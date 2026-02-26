use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use std::slice;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[allow(unused_macros)]
macro_rules! console_log {
    // Note that this is using the `log` function imported above during
    // `bare_bones`
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

#[wasm_bindgen]
pub fn set_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct FFT {
    n: usize,
    smoothing_time_constant: f32,
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    prev: Box<[f32]>,
    /// FFT working buffer. Reused to avoid allocations
    buffer: Vec<rustfft::num_complex::Complex<f32>>,
    /// Window function with pre-applied scaling (1/128 and 1/n)
    scaled_window: Box<[f32]>,
}

#[wasm_bindgen]
impl FFT {
    /// Create a new FFT processor.
    ///
    /// # Arguments
    /// * `n` - FFT size. Must be a power of two and greater than 0
    /// * `window_` - Window function array. Length must equal `n`
    ///
    /// # Panics
    /// * If `n` is 0
    /// * If `n` is not a power of two
    /// * If `window_.len() != n`
    #[allow(clippy::new_without_default)]
    #[wasm_bindgen(constructor)]
    pub fn new(n: usize, window_: &[f32]) -> Self {
        assert!(n > 0, "FFT size must be positive, got {}", n);
        assert!(n.is_power_of_two(), "FFT size must be a power of two, got {}", n);
        assert_eq!(window_.len(), n, "Window size must match FFT size (expected {}, got {})", n, window_.len());

        let fft = FftPlanner::new().plan_fft_forward(n);
        let prev = vec![0.0; n].into_boxed_slice();
        let smoothing_time_constant = 0.0;
        let buffer = vec![Complex { re: 0.0, im: 0.0 }; n];

        // Pre-apply scaling factors to window function
        // 1/128: normalize i8 (-128..127) to -1..1
        // 1/n: FFT normalization
        let scale = 1.0 / (128.0 * n as f32);
        let scaled_window = window_.iter().map(|&w| w * scale).collect::<Vec<_>>().into_boxed_slice();

        FFT {
            n,
            smoothing_time_constant,
            fft,
            prev,
            buffer,
            scaled_window,
        }
    }

    pub fn set_smoothing_time_constant(&mut self, val: f32) {
        self.smoothing_time_constant = val;
    }

    /// Perform a complex FFT on HackRF One IQ samples and apply all
    /// preprocessing needed for spectrogram waterfall display.
    ///
    /// This method performs the following operations in a single pass:
    /// 1. Normalize IQ samples (i8 → f32)
    /// 2. Apply window function
    /// 3. Complex FFT
    /// 4. Rearrange frequency axis to DC-centered layout
    /// 5. Exponential moving average smoothing (when configured)
    /// 6. Convert to dB scale
    ///
    /// The output array can be used directly as a single row (spectrum at time t)
    /// in a waterfall spectrogram display.
    ///
    /// # Input format
    /// * `input_` - Complex sequence as i8 array `[re0, im0, re1, im1, ...]`
    ///               Length must be `self.n * 2`
    ///
    /// # Output format
    /// * `result` - Buffer to store results. Length must be `self.n`
    ///   - `result[0 .. half_n]` - Negative frequency components (DC-centered, dB scale)
    ///   - `result[half_n .. n]` - Positive frequency components (DC-centered, dB scale)
    ///
    /// # Contract (caller's responsibility)
    /// * `input_.len() == self.n * 2` must hold
    /// * `result.len() == self.n` must hold
    ///
    /// # Safety
    /// This function uses unsafe memory reinterpretation. Violating the contract
    /// may cause undefined behavior.
    pub fn fft(&mut self, input_: &[i8], result: &mut [f32]) {
        debug_assert_eq!(input_.len(), self.n * 2, "Input length must be n * 2");
        debug_assert_eq!(result.len(), self.n, "Result length must be n");

        // Reinterpret i8 array [re0, im0, re1, im1, ...] as a Complex<i8> slice
        let input_complex: &[Complex<i8>] = unsafe {
            slice::from_raw_parts(input_.as_ptr() as *const Complex<i8>, self.n)
        };

        // Working buffer (stored in struct for reuse, avoiding allocations)
        let buffer = &mut self.buffer;

        // Normalize and apply window function. scaled_window includes 1/128 and 1/n scaling.
        for i in 0..self.n {
            buffer[i] = Complex {
                re: input_complex[i].re as f32,
                im: input_complex[i].im as f32,
            } * self.scaled_window[i];
        }

        // Execute FFT (in-place transform)
        self.fft.process(buffer);

        // Combined into a single pass:
        // 1. Rearrange to DC-centered layout
        // 2. Exponential moving average smoothing
        // 3. Convert to dB scale
        let half_n = self.n / 2;
        let alpha = self.smoothing_time_constant;
        let inv_alpha = 1.0 - alpha;

        for i in 0..self.n {
            // Calculate the buffer index for the component that goes into result[i] (DC shift)
            let src_idx = if i < half_n { i + half_n } else { i - half_n };
            
            // Already scaled by 1/n via scaled_window, so just compute norm()
            let magnitude = buffer[src_idx].norm();

            let smoothed = if alpha > 0.0 {
                let s = alpha * self.prev[i] + inv_alpha * magnitude;
                self.prev[i] = s;
                s
            } else {
                magnitude
            };

            // Clamp to a small value to avoid log10(0) = -inf
            result[i] = smoothed.max(1e-10).log10() * 10.0;
        }
    }
}

// ============================================================================
// DspProcessor for NCO & Decimation
// ============================================================================

#[wasm_bindgen]
pub struct DspProcessor {
    phase: f32,
    phase_inc: f32,
    decimation: usize,
    sum_i: f32,
    sum_q: f32,
    count: usize,
}

#[wasm_bindgen]
impl DspProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32, shift_hz: f32, decimation: usize) -> Self {
        let phase_inc = 2.0 * std::f32::consts::PI * shift_hz / sample_rate;
        DspProcessor {
            phase: 0.0,
            phase_inc,
            decimation,
            sum_i: 0.0,
            sum_q: 0.0,
            count: 0,
        }
    }

    pub fn set_shift(&mut self, sample_rate: f32, shift_hz: f32) {
        self.phase_inc = 2.0 * std::f32::consts::PI * shift_hz / sample_rate;
    }

    pub fn set_decimation(&mut self, decimation: usize) {
        self.decimation = decimation;
        self.count = 0;
        self.sum_i = 0.0;
        self.sum_q = 0.0;
    }

    /// Process raw i8 IQ samples, applying NCO shift and CIC decimation.
    /// Returns the number of f32 samples written to `output`.
    /// `input` is pairs of i8 (I, Q).
    /// `output` is pairs of f32 (I, Q) and must be large enough. (input.len() / decimation)
    pub fn process(&mut self, input: &[i8], output: &mut [f32]) -> usize {
        let mut out_idx = 0;
        let mut count = self.count;
        let mut sum_i = self.sum_i;
        let mut sum_q = self.sum_q;
        let mut phase = self.phase;
        let decimation = self.decimation;
        let phase_inc = self.phase_inc;
        let pi2 = 2.0 * std::f32::consts::PI;

        // processing 2 bytes at a time (I, Q)
        let exact_len = input.len() / 2 * 2;
        let mut i = 0;
        while i < exact_len {
            let i_val = input[i] as f32 / 128.0;
            let q_val = input[i + 1] as f32 / 128.0;

            let cos_p = phase.cos();
            let sin_p = phase.sin();
            let shifted_i = i_val * cos_p - q_val * sin_p;
            let shifted_q = i_val * sin_p + q_val * cos_p;

            phase += phase_inc;
            if phase > pi2 {
                phase -= pi2;
            } else if phase < -pi2 {
                phase += pi2;
            }

            sum_i += shifted_i;
            sum_q += shifted_q;
            count += 1;

            if count >= decimation {
                if out_idx + 1 < output.len() {
                    output[out_idx] = sum_i / decimation as f32;
                    output[out_idx + 1] = sum_q / decimation as f32;
                    out_idx += 2;
                }
                sum_i = 0.0;
                sum_q = 0.0;
                count = 0;
            }
            i += 2;
        }

        self.phase = phase;
        self.sum_i = sum_i;
        self.sum_q = sum_q;
        self.count = count;

        out_idx
    }
}

// ============================================================================
// Rust Native Tests
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// Generate a unit (rectangular) window with no shaping
    fn ones_window(n: usize) -> Vec<f32> {
        vec![1.0; n]
    }

    #[test]
    fn test_fft_construction() {
        let n = 8;
        let window = ones_window(n);
        let fft = FFT::new(n, &window);

        assert_eq!(fft.n, n);
        // Internal fields are not directly accessible, but construction succeeding is OK
    }

    #[test]
    fn test_fft_set_smoothing_time_constant() {
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);

        fft.set_smoothing_time_constant(0.5);
        // Setting succeeds is OK (internal fields are private)
    }

    #[test]
    fn test_fft_dc_input() {
        // FFT test with DC-only input (all same values)
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);

        let mut input = vec![0i8; n * 2]; // Complex<i8> so n * 2
        for i in 0..n {
            input[i * 2] = 64; // real = 64
            input[i * 2 + 1] = 0; // imaginary = 0
        }

        let mut result = vec![0.0f32; n];
        fft.fft(&input, &mut result);

        // Results are rearranged to DC-centered, so DC component is at center (half_n)
        let half_n = n / 2;
        let dc_component = result.iter().enumerate().max_by(|a, b| {
            a.1.partial_cmp(b.1).unwrap()
        });

        // DC component should be at index 4 (half_n)
        assert_eq!(dc_component.unwrap().0, half_n);
    }

    #[test]
    fn test_fft_zero_input_should_not_produce_inf() {
        // All-zero input: should not produce log10(0) = -inf
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);

        let input = vec![0i8; n * 2]; // all zeros

        let mut result = vec![0.0f32; n];
        fft.fft(&input, &mut result);

        // All results should be finite (not inf, -inf, or NaN)
        for (i, &val) in result.iter().enumerate() {
            assert!(
                val.is_finite(),
                "result[{}] = {} is not finite (zero input should not produce inf)",
                i, val
            );
        }
    }

    #[test]
    fn test_fft_smoothing() {
        // Numerically verify the effect of smoothing
        // When smoothing_time_constant = 0.5:
        // result[k] = 0.5 * prev[k] + 0.5 * current[k]
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);
        fft.set_smoothing_time_constant(0.5);

        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i * 2] = 64; // real = 64
            input[i * 2 + 1] = 0; // imaginary = 0
        }

        let mut result1 = vec![0.0f32; n];
        fft.fft(&input, &mut result1);

        let mut result2 = vec![0.0f32; n];
        fft.fft(&input, &mut result2);

        // With smoothing applied, the 2nd result should differ from the 1st
        // (because prev holds non-zero values)
        let mut differences_found = false;
        for i in 0..n {
            if result1[i].is_finite() && result2[i].is_finite() {
                let diff = (result1[i] - result2[i]).abs();
                // Values should have changed due to smoothing (tolerance 1e-6)
                if diff > 1e-6 {
                    differences_found = true;
                }
            }
        }
        assert!(
            differences_found,
            "Smoothing should produce different results on consecutive calls with same input"
        );
    }

    #[test]
    fn test_fft_smoothing_disabled_when_constant_is_zero() {
        // Smoothing is disabled when smoothing_time_constant = 0
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);
        // Default is 0.0

        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i * 2] = 64;
            input[i * 2 + 1] = 0;
        }

        let mut result1 = vec![0.0f32; n];
        fft.fft(&input, &mut result1);

        let mut result2 = vec![0.0f32; n];
        fft.fft(&input, &mut result2);

        // Without smoothing, same input → same output
        for i in 0..n {
            if result1[i].is_finite() && result2[i].is_finite() {
                assert_eq!(
                    result1[i], result2[i],
                    "Without smoothing, same input should produce same output at index {}",
                    i
                );
            }
        }
    }

    #[test]
    fn test_fft_smoothing_edge_cases() {
        // Boundary value tests for smoothing_time_constant
        let n = 8;
        let window = ones_window(n);

        // 0.0: Smoothing disabled (tested above)

        // 1.0: Fully retain previous value (ignore new value)
        let mut fft = FFT::new(n, &window);
        fft.set_smoothing_time_constant(1.0);

        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i * 2] = 64;
            input[i * 2 + 1] = 0;
        }

        let mut result1 = vec![0.0f32; n];
        fft.fft(&input, &mut result1);

        let mut result2 = vec![0.0f32; n];
        fft.fft(&input, &mut result2);

        // When α=1.0, result2 should equal result1 (prev is fully retained)
        for i in 0..n {
            if result1[i].is_finite() && result2[i].is_finite() {
                assert_eq!(
                    result1[i], result2[i],
                    "With α=1.0, output should stay constant at index {}",
                    i
                );
            }
        }

        // Negative value: behavior is undefined but must not crash
        let mut fft = FFT::new(n, &window);
        fft.set_smoothing_time_constant(-0.5);
        let mut result = vec![0.0f32; n];
        // OK as long as it doesn't crash
        fft.fft(&input, &mut result);

        // Value greater than 1.0: may oscillate but must not crash
        let mut fft = FFT::new(n, &window);
        fft.set_smoothing_time_constant(1.5);
        let mut result = vec![0.0f32; n];
        fft.fft(&input, &mut result);
    }

    #[test]
    fn test_fft_dc_input_magnitude() {
        // Verify numerical correctness of FFT results for DC input
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);

        // DC component: all (64 + 0j)
        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i * 2] = 64;
            input[i * 2 + 1] = 0;
        }

        let mut result = vec![0.0f32; n];
        fft.fft(&input, &mut result);

        // Theoretical calculation:
        // Input: 64/128 = 0.5
        // DC component after FFT: 0.5 * 8 = 4.0 (norm() squares so 4.0^2 = 16.0, norm is sqrt(16) = 4.0)
        // Normalization: 4.0 / 8 = 0.5
        // dB: 10 * log10(0.5) ≈ -3.01
        let half_n = n / 2;
        let dc_value = result[half_n]; // DC component is at center

        let expected_db = 10.0 * 0.5_f32.log10(); // ≈ -3.01
        assert!(
            (dc_value - expected_db).abs() < 0.1,
            "DC component {} should be close to {} (dB)",
            dc_value, expected_db
        );

        // DC component should be the maximum
        let max_idx = result
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(i, _)| i)
            .unwrap();
        assert_eq!(max_idx, half_n, "DC component should be at index {}", half_n);
    }

    #[test]
    fn test_fft_negative_input() {
        // Test with negative input values
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);

        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i * 2] = -64; // negative value
            input[i * 2 + 1] = 0;
        }

        let mut result = vec![0.0f32; n];
        fft.fft(&input, &mut result);

        // All values should be finite
        for (i, &val) in result.iter().enumerate() {
            assert!(
                val.is_finite(),
                "result[{}] = {} is not finite (negative input should be handled)",
                i, val
            );
        }
    }

    #[test]
    fn test_fft_i8_boundary_values() {
        // Boundary value tests for i8
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);

        // i8::MIN = -128, i8::MAX = 127
        let test_values = [i8::MIN, -1, 0, 1, i8::MAX];

        for &val in &test_values {
            let mut input = vec![0i8; n * 2];
            for i in 0..n {
                input[i * 2] = val;
                input[i * 2 + 1] = 0;
            }

            let mut result = vec![0.0f32; n];
            fft.fft(&input, &mut result);

            // Should not crash, all values should be finite
            for (i, &r) in result.iter().enumerate() {
                assert!(
                    r.is_finite(),
                    "result[{}] = {} is not finite for input value {}",
                    i, r, val
                );
            }
        }
    }

    #[test]
    #[should_panic(expected = "Window size must match FFT size")]
    fn test_fft_window_size_mismatch() {
        let n = 8;
        let window = vec![1.0; 4]; // undersized
        let _fft = FFT::new(n, &window);
    }

    #[test]
    #[should_panic(expected = "Window size must match FFT size")]
    fn test_fft_window_size_oversized() {
        let n = 8;
        let window = vec![1.0; 16]; // oversized
        let _fft = FFT::new(n, &window);
    }

    #[test]
    #[should_panic(expected = "FFT size must be positive")]
    fn test_fft_zero_size() {
        let _fft = FFT::new(0, &[]);
    }

    #[test]
    #[should_panic(expected = "FFT size must be a power of two")]
    fn test_fft_non_power_of_two() {
        let n = 7; // not a power of two
        let window = vec![1.0; n];
        let _fft = FFT::new(n, &window);
    }

    #[test]
    #[should_panic(expected = "FFT size must be a power of two")]
    fn test_fft_odd_size() {
        let n = 9; // odd number
        let window = vec![1.0; n];
        let _fft = FFT::new(n, &window);
    }

    #[test]
    fn test_fft_differential_against_reference() {
        // Compare results between reference (naive) implementation and optimized version
        let n = 16;
        let mut window = vec![0.0f32; n];
        for (i, w) in window.iter_mut().enumerate() {
             // Generate a Hann-like window
             *w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos());
        }
        
        let mut fft = FFT::new(n, &window);
        fft.set_smoothing_time_constant(0.3);
        
        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i*2] = (i as i8).wrapping_sub(8).wrapping_mul(10);
            input[i*2+1] = (7i8).wrapping_sub(i as i8).wrapping_mul(10);
        }
        
        // First run (updating prev from zero)
        let mut result_opt = vec![0.0f32; n];
        fft.fft(&input, &mut result_opt);
        
        // Reference calculation (1st run)
        let mut prev = vec![0.0f32; n]; // initial state
        let expected = calculate_reference_fft(n, &window, &input, &mut prev, 0.3);
        
        for i in 0..n {
            assert!((result_opt[i] - expected[i]).abs() < 1e-5, "Mismatch at index {} on 1st run: opt={}, expected={}", i, result_opt[i], expected[i]);
        }
        
        // Second run (verify smoothing effect)
        fft.fft(&input, &mut result_opt);
        let expected2 = calculate_reference_fft(n, &window, &input, &mut prev, 0.3);
        
        for i in 0..n {
            assert!((result_opt[i] - expected2[i]).abs() < 1e-5, "Mismatch at index {} on 2nd run: opt={}, expected={}", i, result_opt[i], expected2[i]);
        }
    }

    /// Naive reference calculation (efficiency ignored)
    fn calculate_reference_fft(n: usize, window: &[f32], input: &[i8], prev: &mut [f32], alpha: f32) -> Vec<f32> {
        use rustfft::num_complex::Complex;
        let mut buffer = vec![Complex { re: 0.0, im: 0.0 }; n];
        for i in 0..n {
            buffer[i] = Complex {
                re: input[i*2] as f32 / 128.0,
                im: input[i*2+1] as f32 / 128.0,
            } * window[i];
        }
        
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(n);
        fft.process(&mut buffer);
        
        let half_n = n / 2;
        let mut shifted = vec![0.0f32; n];
        for i in 0..half_n {
            shifted[i + half_n] = buffer[i].norm() / n as f32;
            shifted[i] = buffer[i + half_n].norm() / n as f32;
        }
        
        let mut res = vec![0.0f32; n];
        for i in 0..n {
            let magnitude = if alpha > 0.0 {
                let s = alpha * prev[i] + (1.0 - alpha) * shifted[i];
                prev[i] = s;
                s
            } else {
                shifted[i]
            };
            res[i] = magnitude.max(1e-10).log10() * 10.0;
        }
        res
    }
}

// ============================================================================
// Wasm Tests (wasm-bindgen-test)
// ============================================================================
#[cfg(test)]
mod wasm_tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn test_fft_construction_wasm() {
        let n = 8;
        let window = vec![1.0; n];
        let _fft = FFT::new(n, &window);
    }

    #[wasm_bindgen_test]
    fn test_fft_processing_wasm() {
        let n = 8;
        let window = vec![1.0; n];
        let mut fft = FFT::new(n, &window);

        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i * 2] = 64;
            input[i * 2 + 1] = 0;
        }

        let mut result = vec![0.0f32; n];
        fft.fft(&input, &mut result);

        // Verify the result size is correct
        assert_eq!(result.len(), n);
    }
}
