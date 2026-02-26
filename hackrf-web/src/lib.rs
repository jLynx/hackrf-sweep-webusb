use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use std::f32::consts::PI;
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
    smoothing_speed: f32,
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
        let smoothing_speed = 1.0;
        let buffer = vec![Complex { re: 0.0, im: 0.0 }; n];

        // Pre-apply scaling factors to window function
        // 1/128: normalize i8 (-128..127) to -1..1
        // 1/n: FFT normalization
        // (-1)^i: pre-FFT DC centering (equivalent to fftShift, matches SDR++ iq_frontend.cpp)
        let scale = 1.0 / (128.0 * n as f32);
        let scaled_window = window_.iter().enumerate().map(|(i, &w)| {
            let shift = if i % 2 == 0 { 1.0f32 } else { -1.0f32 };
            w * scale * shift
        }).collect::<Vec<_>>().into_boxed_slice();

        FFT {
            n,
            smoothing_speed,
            fft,
            prev,
            buffer,
            scaled_window,
        }
    }

    pub fn set_smoothing_speed(&mut self, val: f32) {
        self.smoothing_speed = val;
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

        // Combined into a single pass (matches SDR++ iq_frontend.cpp + waterfall.cpp):
        // 1. DC centering already done via (-1)^i in window (pre-FFT shift)
        // 2. Power spectrum: 10 * log10(re² + im²) (matches volk_32fc_s32f_power_spectrum_32f)
        // 3. Exponential moving average smoothing in dB domain
        let alpha = self.smoothing_speed;
        let inv_alpha = 1.0 - alpha;

        for i in 0..self.n {
            // Power spectrum (matches SDR++ volk_32fc_s32f_power_spectrum_32f)
            // Already scaled by 1/(128*n) via scaled_window
            let power = buffer[i].norm_sqr();
            let db = power.max(1e-20).log10() * 10.0;

            // EMA smoothing in dB domain (matches SDR++ waterfall.cpp pushFFT)
            // SDR++ formula: result = alpha * new + (1-alpha) * old
            // alpha = speed: 1.0 = no smoothing, 0.0 = frozen
            result[i] = if alpha < 1.0 {
                let s = alpha * db + inv_alpha * self.prev[i];
                self.prev[i] = s;
                s
            } else {
                db
            };
        }
    }
}

// ============================================================================
// DSP Primitives (matching SDR++ core/src/dsp/)
// ============================================================================

/// Cosine window (matches SDR++ dsp/window/cosine.h)
/// n: continuous offset value, big_n: window length N
fn cosine_window(n: f64, big_n: f64, coefs: &[f64]) -> f64 {
    let mut win = 0.0;
    let mut sign = 1.0;
    for (i, &c) in coefs.iter().enumerate() {
        win += sign * c * (i as f64 * 2.0 * std::f64::consts::PI * n / big_n).cos();
        sign = -sign;
    }
    win
}

/// Nuttall 4-term cosine window (matches SDR++ dsp/window/nuttall.h)
/// n: continuous offset value, big_n: window length N
fn nuttall_window(n: f64, big_n: f64) -> f64 {
    const COEFS: [f64; 4] = [0.355768, 0.487396, 0.144232, 0.012604];
    cosine_window(n, big_n, &COEFS)
}

/// sinc(x) = sin(x)/x, sinc(0) = 1
fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        x.sin() / x
    }
}

/// Estimate FIR tap count (matches SDR++ dsp/taps/estimate_tap_count.h)
fn estimate_tap_count(trans_width: f64, sample_rate: f64) -> usize {
    (3.8 * sample_rate / trans_width).floor() as usize
}

/// Generate low-pass FIR taps using windowed sinc with Nuttall window
/// (matches SDR++ dsp/taps/low_pass.h + dsp/taps/windowed_sinc.h)
fn low_pass_taps(cutoff: f64, trans_width: f64, sample_rate: f64) -> Vec<f32> {
    let count = estimate_tap_count(trans_width, sample_rate).max(1);
    let omega = 2.0 * std::f64::consts::PI * cutoff / sample_rate;
    let half = count as f64 / 2.0;
    let corr = omega / std::f64::consts::PI;
    let mut taps = Vec::with_capacity(count);
    for i in 0..count {
        let t = i as f64 - half + 0.5;
        // SDR++ windowed_sinc.h passes (t - half, count) to window function
        let win = nuttall_window(t - half, count as f64);
        let val = sinc(t * omega) * win * corr;
        taps.push(val as f32);
    }
    taps
}

/// Greatest common divisor
fn gcd(mut a: usize, mut b: usize) -> usize {
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    a
}

// ============================================================================
// Polyphase Rational Resampler (matches SDR++ dsp/multirate/polyphase_resampler.h)
// ============================================================================

/// Polyphase rational resampler for f32 mono audio data.
/// Resamples by interp/decim ratio using a polyphase filter bank.
struct PolyphaseResamplerF32 {
    interp: usize,
    decim: usize,
    taps_per_phase: usize,
    phases: Vec<Vec<f32>>,
    buffer: Vec<f32>,
    buf_start_offset: usize,
    phase: usize,
    offset: usize,
}

impl PolyphaseResamplerF32 {
    fn new(interp: usize, decim: usize, taps: &[f32]) -> Self {
        let phase_count = interp;
        let taps_per_phase = (taps.len() + phase_count - 1) / phase_count;
        let mut phases = vec![vec![0.0f32; taps_per_phase]; phase_count];

        let tot_tap_count = phase_count * taps_per_phase;
        for i in 0..tot_tap_count {
            let phase_idx = (phase_count - 1) - (i % phase_count);
            let tap_idx = i / phase_count;
            phases[phase_idx][tap_idx] = if i < taps.len() { taps[i] } else { 0.0 };
        }

        let buffer = vec![0.0f32; taps_per_phase - 1 + 65536];
        PolyphaseResamplerF32 {
            interp,
            decim,
            taps_per_phase,
            phases,
            buffer,
            buf_start_offset: taps_per_phase - 1,
            phase: 0,
            offset: 0,
        }
    }

    fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        let count = input.len();
        // Grow buffer dynamically if input exceeds pre-allocated size
        let needed = self.buf_start_offset + count;
        if needed > self.buffer.len() {
            self.buffer.resize(needed, 0.0);
        }
        // Copy input into delay line
        self.buffer[self.buf_start_offset..self.buf_start_offset + count]
            .copy_from_slice(input);

        while self.offset < count {
            // Dot product with current phase taps
            let phase_taps = &self.phases[self.phase];
            let mut sum = 0.0f32;
            for j in 0..self.taps_per_phase {
                sum += self.buffer[self.offset + j] * phase_taps[j];
            }
            output.push(sum);

            self.phase += self.decim;
            self.offset += self.phase / self.interp;
            self.phase %= self.interp;
        }
        self.offset -= count;

        // Move delay line (memmove equivalent)
        self.buffer.copy_within(count..count + self.taps_per_phase - 1, 0);
    }

    fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.phase = 0;
        self.offset = 0;
    }
}

/// Polyphase rational resampler for complex IQ data.
/// Each complex sample is two f32 (I, Q) interleaved.
struct PolyphaseResamplerComplex {
    interp: usize,
    decim: usize,
    taps_per_phase: usize,
    phases: Vec<Vec<f32>>,
    // Buffer stores Complex<f32> but we work with raw pairs for wasm compat
    buffer_i: Vec<f32>,
    buffer_q: Vec<f32>,
    buf_start_offset: usize,
    phase: usize,
    offset: usize,
}

impl PolyphaseResamplerComplex {
    fn new(interp: usize, decim: usize, taps: &[f32]) -> Self {
        let phase_count = interp;
        let taps_per_phase = (taps.len() + phase_count - 1) / phase_count;
        let mut phases = vec![vec![0.0f32; taps_per_phase]; phase_count];

        let tot_tap_count = phase_count * taps_per_phase;
        for i in 0..tot_tap_count {
            let phase_idx = (phase_count - 1) - (i % phase_count);
            let tap_idx = i / phase_count;
            phases[phase_idx][tap_idx] = if i < taps.len() { taps[i] } else { 0.0 };
        }

        let buf_size = taps_per_phase - 1 + 262144;
        PolyphaseResamplerComplex {
            interp,
            decim,
            taps_per_phase,
            phases,
            buffer_i: vec![0.0f32; buf_size],
            buffer_q: vec![0.0f32; buf_size],
            buf_start_offset: taps_per_phase - 1,
            phase: 0,
            offset: 0,
        }
    }

    /// Process `count` complex samples from separate I/Q arrays.
    /// Output is appended to out_i and out_q.
    fn process(&mut self, in_i: &[f32], in_q: &[f32], out_i: &mut Vec<f32>, out_q: &mut Vec<f32>) {
        let count = in_i.len();
        debug_assert_eq!(in_i.len(), in_q.len());

        // Grow buffers dynamically if input exceeds pre-allocated size
        let needed = self.buf_start_offset + count;
        if needed > self.buffer_i.len() {
            self.buffer_i.resize(needed, 0.0);
            self.buffer_q.resize(needed, 0.0);
        }

        self.buffer_i[self.buf_start_offset..self.buf_start_offset + count]
            .copy_from_slice(in_i);
        self.buffer_q[self.buf_start_offset..self.buf_start_offset + count]
            .copy_from_slice(in_q);

        while self.offset < count {
            let phase_taps = &self.phases[self.phase];
            let mut sum_i = 0.0f32;
            let mut sum_q = 0.0f32;
            for j in 0..self.taps_per_phase {
                sum_i += self.buffer_i[self.offset + j] * phase_taps[j];
                sum_q += self.buffer_q[self.offset + j] * phase_taps[j];
            }
            out_i.push(sum_i);
            out_q.push(sum_q);

            self.phase += self.decim;
            self.offset += self.phase / self.interp;
            self.phase %= self.interp;
        }
        self.offset -= count;

        self.buffer_i.copy_within(count..count + self.taps_per_phase - 1, 0);
        self.buffer_q.copy_within(count..count + self.taps_per_phase - 1, 0);
    }

    fn reset(&mut self) {
        self.buffer_i.fill(0.0);
        self.buffer_q.fill(0.0);
        self.phase = 0;
        self.offset = 0;
    }
}

// ============================================================================
// FIR Filter (matches SDR++ dsp/filter/fir.h)
// ============================================================================

/// Complex FIR filter with real taps (matches SDR++ volk_32fc_32f_dot_prod_32fc)
struct ComplexFIR {
    taps: Vec<f32>,
    history_i: Vec<f32>,
    history_q: Vec<f32>,
    hist_idx: usize,
}

impl ComplexFIR {
    fn new(taps: Vec<f32>) -> Self {
        let len = taps.len();
        ComplexFIR {
            taps,
            history_i: vec![0.0; len],
            history_q: vec![0.0; len],
            hist_idx: 0,
        }
    }

    fn set_taps(&mut self, taps: Vec<f32>) {
        let len = taps.len();
        self.taps = taps;
        self.history_i = vec![0.0; len];
        self.history_q = vec![0.0; len];
        self.hist_idx = 0;
    }

    fn process_block(&mut self, in_i: &[f32], in_q: &[f32], out_i: &mut [f32], out_q: &mut [f32]) {
        for k in 0..in_i.len() {
            self.history_i[self.hist_idx] = in_i[k];
            self.history_q[self.hist_idx] = in_q[k];

            let mut si = 0.0f32;
            let mut sq = 0.0f32;
            let mut tap_idx = 0;

            // Circular buffer dot product
            let mut i = self.hist_idx as isize;
            loop {
                si += self.history_i[i as usize] * self.taps[tap_idx];
                sq += self.history_q[i as usize] * self.taps[tap_idx];
                tap_idx += 1;
                i -= 1;
                if i < 0 { i = self.taps.len() as isize - 1; }
                if i == self.hist_idx as isize { break; }
            }

            out_i[k] = si;
            out_q[k] = sq;

            self.hist_idx += 1;
            if self.hist_idx >= self.taps.len() {
                self.hist_idx = 0;
            }
        }
    }

    fn reset(&mut self) {
        self.history_i.fill(0.0);
        self.history_q.fill(0.0);
        self.hist_idx = 0;
    }
}

/// Real FIR filter with real taps (for post-demod audio filtering)
struct RealFIR {
    taps: Vec<f32>,
    history: Vec<f32>,
    hist_idx: usize,
}

impl RealFIR {
    fn new(taps: Vec<f32>) -> Self {
        let len = taps.len();
        RealFIR {
            taps,
            history: vec![0.0; len],
            hist_idx: 0,
        }
    }

    fn set_taps(&mut self, taps: Vec<f32>) {
        let len = taps.len();
        self.taps = taps;
        self.history = vec![0.0; len];
        self.hist_idx = 0;
    }

    fn process_block(&mut self, input: &[f32], output: &mut [f32]) {
        for k in 0..input.len() {
            self.history[self.hist_idx] = input[k];

            let mut sum = 0.0f32;
            let mut tap_idx = 0;

            let mut i = self.hist_idx as isize;
            loop {
                sum += self.history[i as usize] * self.taps[tap_idx];
                tap_idx += 1;
                i -= 1;
                if i < 0 { i = self.taps.len() as isize - 1; }
                if i == self.hist_idx as isize { break; }
            }

            output[k] = sum;

            self.hist_idx += 1;
            if self.hist_idx >= self.taps.len() {
                self.hist_idx = 0;
            }
        }
    }

    fn reset(&mut self) {
        self.history.fill(0.0);
        self.hist_idx = 0;
    }
}

// ============================================================================
// DspProcessor — Full SDR++ VFO + Demod Pipeline
// ============================================================================
//
// Signal chain (matches SDR++ exactly):
//   1. FrequencyXlator (NCO mixer) — complex rotate to shift channel to baseband
//   2. RationalResampler (polyphase) — decimate from source SR → IF SR (50 kHz)
//   3. Channel FIR filter — LPF at bandwidth/2 (only if bandwidth != IF SR)
//   4. Squelch — avg magnitude gate on complex IQ (pre-demod)
//   5. Quadrature FM discriminator — atan2 phase diff → float audio
//   6. Post-demod FIR filter — LPF at bandwidth/2 on demodulated audio
//   7. Audio RationalResampler — 50 kHz → 48 kHz (polyphase)
//
// All steps run at appropriate sample rates, matching SDR++ processing order.

#[wasm_bindgen]
pub struct DspProcessor {
    // NCO state (phasor form — no per-sample trig, just complex multiply)
    phasor_re: f32,
    phasor_im: f32,
    phasor_inc_re: f32,
    phasor_inc_im: f32,

    // Sample rates
    in_sample_rate: f32,
    if_sample_rate: f32,   // 50000.0 Hz (matches SDR++ NFM getIFSampleRate)
    audio_sample_rate: f32, // 48000.0 Hz

    // Pre-decimation: cascaded CIC decimate-by-2 stages
    // (matches SDR++ rx_vfo.h PowerDecimator concept)
    pre_decim_stages: usize,

    // Bandwidth
    bandwidth: f32,

    // IQ resampler: pre_decim_rate → 50 kHz
    iq_resampler: PolyphaseResamplerComplex,

    // Channel bandwidth FIR filter (complex, operates at IF SR)
    channel_filter: ComplexFIR,
    channel_filter_needed: bool,

    // FM demodulator state
    prev_phase: f32,
    inv_deviation: f32,

    // Post-demod FIR (real, operates at IF SR)
    post_demod_fir: RealFIR,

    // Audio resampler: IF SR → audio SR
    audio_resampler: PolyphaseResamplerF32,

    // Squelch state
    squelch_level: f32,   // dB threshold (-100 = disabled)
    squelch_enabled: bool,

    // NCO output buffers (reused to avoid per-call allocation)
    nco_buf_i: Vec<f32>,
    nco_buf_q: Vec<f32>,

    // Scratch buffers (reused to avoid allocations)
    scratch_i: Vec<f32>,
    scratch_q: Vec<f32>,
    scratch_i2: Vec<f32>,
    scratch_q2: Vec<f32>,
    scratch_audio: Vec<f32>,
    scratch_audio2: Vec<f32>,
}

#[wasm_bindgen]
impl DspProcessor {
    /// Create a new DSP processor matching SDR++ NFM pipeline.
    ///
    /// # Arguments
    /// * `in_sample_rate` - Source sample rate (e.g. 2_000_000.0 for 2 MHz)
    /// * `shift_hz` - Frequency offset in Hz (VFO offset from center)
    /// * `bandwidth` - Channel bandwidth in Hz (default 12500.0 for NFM)
    #[wasm_bindgen(constructor)]
    pub fn new(in_sample_rate: f32, shift_hz: f32, bandwidth: f32) -> Self {
        let if_sample_rate = 50000.0f32;
        let audio_sample_rate = 48000.0f32;

        // NCO: phasor form (negate offset to match SDR++ xlator.init(NULL, -_offset, _inSR))
        let phase_inc = -2.0 * PI * shift_hz / in_sample_rate;
        let (sin_inc, cos_inc) = phase_inc.sin_cos();

        // Pre-decimation stages (matches SDR++ rx_vfo.h PowerDecimator)
        // Cascade of decimate-by-2 (CIC averaging) to bring rate close to IF
        // before the polyphase resampler (avoids 30k+ tap FIR for 20MHz→50kHz)
        let sr_to_if = in_sample_rate / if_sample_rate;
        let pre_decim_stages = if sr_to_if > 4.0 {
            (sr_to_if.log2().floor() as usize).saturating_sub(1).min(12)
        } else {
            0
        };
        let pre_decim_rate = in_sample_rate / (1u32 << pre_decim_stages) as f32;

        // IQ rational resampler: pre_decim_rate → IF
        let iq_resampler = Self::build_complex_resampler(pre_decim_rate, if_sample_rate);

        // Channel filter: LPF at bandwidth/2, operating at IF SR
        let channel_filter_needed = (bandwidth - if_sample_rate).abs() > 1.0;
        let channel_filter = if channel_filter_needed {
            let filter_width = bandwidth as f64 / 2.0;
            let taps = low_pass_taps(filter_width, filter_width * 0.1, if_sample_rate as f64);
            ComplexFIR::new(taps)
        } else {
            ComplexFIR::new(vec![1.0])
        };

        // FM demodulator: deviation = bandwidth/2
        let deviation_rad = 2.0 * PI * (bandwidth / 2.0) / if_sample_rate;
        let inv_deviation = 1.0 / deviation_rad;

        // Post-demod FIR: LPF at bandwidth/2, transition = 10% of cutoff, at IF SR
        let post_demod_fir = {
            let cutoff = bandwidth as f64 / 2.0;
            let trans = cutoff * 0.1;
            let taps = low_pass_taps(cutoff, trans, if_sample_rate as f64);
            RealFIR::new(taps)
        };

        // Audio resampler: IF SR → audio SR
        let audio_resampler = Self::build_f32_resampler(if_sample_rate, audio_sample_rate);

        DspProcessor {
            phasor_re: 1.0,
            phasor_im: 0.0,
            phasor_inc_re: cos_inc,
            phasor_inc_im: sin_inc,
            in_sample_rate,
            if_sample_rate,
            audio_sample_rate,
            pre_decim_stages,
            bandwidth,
            iq_resampler,
            channel_filter,
            channel_filter_needed,
            prev_phase: 0.0,
            inv_deviation,
            post_demod_fir,
            audio_resampler,
            squelch_level: -100.0,
            squelch_enabled: false,
            nco_buf_i: Vec::with_capacity(262144),
            nco_buf_q: Vec::with_capacity(262144),
            scratch_i: Vec::with_capacity(8192),
            scratch_q: Vec::with_capacity(8192),
            scratch_i2: Vec::with_capacity(8192),
            scratch_q2: Vec::with_capacity(8192),
            scratch_audio: Vec::with_capacity(8192),
            scratch_audio2: Vec::with_capacity(8192),
        }
    }

    fn build_complex_resampler(in_sr: f32, out_sr: f32) -> PolyphaseResamplerComplex {
        let in_sr_u = in_sr.round() as usize;
        let out_sr_u = out_sr.round() as usize;
        let d = gcd(in_sr_u, out_sr_u);
        let interp = out_sr_u / d;
        let decim = in_sr_u / d;

        let tap_sr = in_sr as f64 * interp as f64;
        let tap_bw = (in_sr as f64).min(out_sr as f64) / 2.0;
        let tap_tw = tap_bw * 0.1;
        let mut taps = low_pass_taps(tap_bw, tap_tw, tap_sr);
        for t in taps.iter_mut() {
            *t *= interp as f32;
        }

        PolyphaseResamplerComplex::new(interp, decim, &taps)
    }

    fn build_f32_resampler(in_sr: f32, out_sr: f32) -> PolyphaseResamplerF32 {
        let in_sr_u = in_sr.round() as usize;
        let out_sr_u = out_sr.round() as usize;
        let d = gcd(in_sr_u, out_sr_u);
        let interp = out_sr_u / d;
        let decim = in_sr_u / d;

        let tap_sr = in_sr as f64 * interp as f64;
        let tap_bw = (in_sr as f64).min(out_sr as f64) / 2.0;
        let tap_tw = tap_bw * 0.1;
        let mut taps = low_pass_taps(tap_bw, tap_tw, tap_sr);
        for t in taps.iter_mut() {
            *t *= interp as f32;
        }

        PolyphaseResamplerF32::new(interp, decim, &taps)
    }

    /// Update the NCO frequency offset.
    pub fn set_shift(&mut self, sample_rate: f32, shift_hz: f32) {
        self.in_sample_rate = sample_rate;
        // Negate offset to match SDR++ FrequencyXlator
        let phase_inc = -2.0 * PI * shift_hz / sample_rate;
        let (sin_inc, cos_inc) = phase_inc.sin_cos();
        self.phasor_inc_re = cos_inc;
        self.phasor_inc_im = sin_inc;
    }

    /// Update the channel bandwidth and rebuild filters.
    pub fn set_bandwidth(&mut self, bandwidth: f32) {
        if (self.bandwidth - bandwidth).abs() < 1.0 {
            return;
        }
        self.bandwidth = bandwidth;

        // Update channel filter
        self.channel_filter_needed = (bandwidth - self.if_sample_rate).abs() > 1.0;
        if self.channel_filter_needed {
            let filter_width = bandwidth as f64 / 2.0;
            let taps = low_pass_taps(filter_width, filter_width * 0.1, self.if_sample_rate as f64);
            self.channel_filter.set_taps(taps);
        }

        // Update FM deviation
        let deviation_rad = 2.0 * PI * (bandwidth / 2.0) / self.if_sample_rate;
        self.inv_deviation = 1.0 / deviation_rad;

        // Update post-demod filter
        let cutoff = bandwidth as f64 / 2.0;
        let trans = cutoff * 0.1;
        let taps = low_pass_taps(cutoff, trans, self.if_sample_rate as f64);
        self.post_demod_fir.set_taps(taps);
    }

    /// Set squelch level in dB. Set to -200 or below to effectively disable.
    pub fn set_squelch(&mut self, level: f32, enabled: bool) {
        self.squelch_level = level;
        self.squelch_enabled = enabled;
    }

    /// Process raw i8 IQ samples through the full SDR++ NFM pipeline.
    /// Returns the number of f32 audio samples written to `output`.
    ///
    /// Input: i8 IQ pairs [I0, Q0, I1, Q1, ...]
    /// Output: f32 mono audio at 48 kHz
    pub fn process(&mut self, input: &[i8], output: &mut [f32]) -> usize {
        let num_iq = input.len() / 2;
        if num_iq == 0 {
            return 0;
        }

        // ── Stage 1: NCO (FrequencyXlator via phasor rotation) ──────
        // Uses complex phasor rotation instead of per-sample sin/cos.
        // Each sample: out = in * conj(phasor); phasor *= phasor_inc
        self.nco_buf_i.clear();
        self.nco_buf_q.clear();

        let mut pr = self.phasor_re;
        let mut pi = self.phasor_im;
        let ir = self.phasor_inc_re;
        let ii = self.phasor_inc_im;

        let mut idx = 0;
        for _ in 0..num_iq {
            let i_val = input[idx] as f32 / 128.0;
            let q_val = input[idx + 1] as f32 / 128.0;

            // Standard complex multiply: (i + jq) * (pr + j*pi)
            //   = (i*pr - q*pi) + j(i*pi + q*pr)
            // Matches SDR++ VOLK volk_32fc_s32fc_x2_rotator2_32fc
            self.nco_buf_i.push(i_val * pr - q_val * pi);
            self.nco_buf_q.push(i_val * pi + q_val * pr);

            // Rotate phasor: phasor *= phasor_inc
            let new_r = pr * ir - pi * ii;
            let new_i = pr * ii + pi * ir;
            pr = new_r;
            pi = new_i;

            idx += 2;
        }

        // Renormalize phasor to prevent amplitude drift
        let mag = (pr * pr + pi * pi).sqrt();
        self.phasor_re = pr / mag;
        self.phasor_im = pi / mag;

        // ── Stage 1b: CIC pre-decimation (in-place) ─────────────────
        // Cascaded decimate-by-2 averaging stages to reduce sample rate
        // before the polyphase resampler (avoids huge FIR tap counts)
        let mut decim_len = num_iq;
        for _ in 0..self.pre_decim_stages {
            let half = decim_len / 2;
            for k in 0..half {
                self.nco_buf_i[k] = (self.nco_buf_i[2 * k] + self.nco_buf_i[2 * k + 1]) * 0.5;
                self.nco_buf_q[k] = (self.nco_buf_q[2 * k] + self.nco_buf_q[2 * k + 1]) * 0.5;
            }
            decim_len = half;
        }

        // ── Stage 2: IQ Rational Resampler (pre_decim_rate → 50 kHz) ─
        self.scratch_i.clear();
        self.scratch_q.clear();
        self.iq_resampler.process(
            &self.nco_buf_i[..decim_len], &self.nco_buf_q[..decim_len],
            &mut self.scratch_i, &mut self.scratch_q,
        );
        let if_count = self.scratch_i.len();

        if if_count == 0 {
            return 0;
        }

        // ── Stage 3: Channel Bandwidth FIR Filter ───────────────────
        if self.channel_filter_needed && if_count > 0 {
            self.scratch_i2.resize(if_count, 0.0);
            self.scratch_q2.resize(if_count, 0.0);
            self.channel_filter.process_block(
                &self.scratch_i, &self.scratch_q,
                &mut self.scratch_i2, &mut self.scratch_q2,
            );
            // Swap so scratch_i/q hold filtered output
            std::mem::swap(&mut self.scratch_i, &mut self.scratch_i2);
            std::mem::swap(&mut self.scratch_q, &mut self.scratch_q2);
        }

        // ── Stage 4: Squelch (SDR++ noise_reduction/squelch.h) ──────
        if self.squelch_enabled {
            let mut mag_sum = 0.0f32;
            for k in 0..if_count {
                let i_val = self.scratch_i[k];
                let q_val = self.scratch_q[k];
                mag_sum += (i_val * i_val + q_val * q_val).sqrt();
            }
            let avg_mag = mag_sum / if_count as f32;
            let db = 10.0 * (avg_mag + 1e-12).log10();
            if db < self.squelch_level {
                // Mute: zero the IQ data (SDR++ memset to 0)
                for k in 0..if_count {
                    self.scratch_i[k] = 0.0;
                    self.scratch_q[k] = 0.0;
                }
            }
        }

        // ── Stage 5: FM Quadrature Demodulator ──────────────────────
        // (matches SDR++ dsp/demod/quadrature.h)
        self.scratch_audio.resize(if_count, 0.0);
        let mut prev_phase = self.prev_phase;
        for k in 0..if_count {
            let cur_phase = self.scratch_q[k].atan2(self.scratch_i[k]);
            let mut diff = cur_phase - prev_phase;
            // normalizePhase (single if/else, matches SDR++ math/normalize_phase.h)
            if diff > PI {
                diff -= 2.0 * PI;
            } else if diff <= -PI {
                diff += 2.0 * PI;
            }
            self.scratch_audio[k] = diff * self.inv_deviation;
            prev_phase = cur_phase;
        }
        self.prev_phase = prev_phase;

        // ── Stage 6: Post-Demod FIR Filter ──────────────────────────
        // (matches SDR++ dsp/demod/fm.h, lowPass at bandwidth/2)
        self.scratch_audio2.resize(if_count, 0.0);
        self.post_demod_fir.process_block(&self.scratch_audio, &mut self.scratch_audio2);

        // ── Stage 7: Audio Resampler (50 kHz → 48 kHz) ─────────────
        let mut audio_out: Vec<f32> = Vec::with_capacity(if_count + 16);
        self.audio_resampler.process(&self.scratch_audio2, &mut audio_out);

        // Copy to output buffer
        let out_count = audio_out.len().min(output.len());
        output[..out_count].copy_from_slice(&audio_out[..out_count]);
        out_count
    }
}

// ============================================================================
// Legacy DspProcessor compatibility — keep old API for non-NFM modes
// ============================================================================

// (The old DspProcessor is replaced by the new one above.
//  Non-FM modes like AM/SSB still use JS-side demod, so the new process()
//  method handles the full FM pipeline. For non-FM modes, worker.js can
//  use the raw IQ output via process_iq_only().)

#[wasm_bindgen]
impl DspProcessor {
    /// Process raw i8 IQ samples through NCO + decimation only.
    /// Returns interleaved complex f32 IQ pairs at IF sample rate (50 kHz).
    /// Used for non-FM modes (AM, SSB, CW, RAW) where JS handles demodulation.
    pub fn process_iq_only(&mut self, input: &[i8], output: &mut [f32]) -> usize {
        let num_iq = input.len() / 2;
        if num_iq == 0 {
            return 0;
        }

        // Stage 1: NCO (phasor rotation)
        self.nco_buf_i.clear();
        self.nco_buf_q.clear();

        let mut pr = self.phasor_re;
        let mut pi = self.phasor_im;
        let ir = self.phasor_inc_re;
        let ii = self.phasor_inc_im;

        let mut idx = 0;
        for _ in 0..num_iq {
            let i_val = input[idx] as f32 / 128.0;
            let q_val = input[idx + 1] as f32 / 128.0;

            // Standard complex multiply (matches SDR++ VOLK rotator)
            self.nco_buf_i.push(i_val * pr - q_val * pi);
            self.nco_buf_q.push(i_val * pi + q_val * pr);

            let new_r = pr * ir - pi * ii;
            let new_i = pr * ii + pi * ir;
            pr = new_r;
            pi = new_i;

            idx += 2;
        }

        let mag = (pr * pr + pi * pi).sqrt();
        self.phasor_re = pr / mag;
        self.phasor_im = pi / mag;

        // Stage 1b: CIC pre-decimation
        let mut decim_len = num_iq;
        for _ in 0..self.pre_decim_stages {
            let half = decim_len / 2;
            for k in 0..half {
                self.nco_buf_i[k] = (self.nco_buf_i[2 * k] + self.nco_buf_i[2 * k + 1]) * 0.5;
                self.nco_buf_q[k] = (self.nco_buf_q[2 * k] + self.nco_buf_q[2 * k + 1]) * 0.5;
            }
            decim_len = half;
        }

        // Stage 2: IQ Rational Resampler
        self.scratch_i.clear();
        self.scratch_q.clear();
        self.iq_resampler.process(
            &self.nco_buf_i[..decim_len], &self.nco_buf_q[..decim_len],
            &mut self.scratch_i, &mut self.scratch_q,
        );
        let if_count = self.scratch_i.len();

        // Stage 3: Channel filter
        if self.channel_filter_needed && if_count > 0 {
            self.scratch_i2.resize(if_count, 0.0);
            self.scratch_q2.resize(if_count, 0.0);
            self.channel_filter.process_block(
                &self.scratch_i, &self.scratch_q,
                &mut self.scratch_i2, &mut self.scratch_q2,
            );
            std::mem::swap(&mut self.scratch_i, &mut self.scratch_i2);
            std::mem::swap(&mut self.scratch_q, &mut self.scratch_q2);
        }

        // Output interleaved IQ pairs
        let out_count = (if_count * 2).min(output.len());
        let pairs = out_count / 2;
        for k in 0..pairs {
            output[k * 2] = self.scratch_i[k];
            output[k * 2 + 1] = self.scratch_q[k];
        }
        out_count
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
    fn test_fft_set_smoothing_speed() {
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);

        fft.set_smoothing_speed(0.5);
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
        // When smoothing_speed = 0.5 (SDR++ semantics):
        // result[k] = 0.5 * new_dB[k] + 0.5 * prev_dB[k]
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);
        fft.set_smoothing_speed(0.5);

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
    fn test_fft_smoothing_disabled_when_speed_is_one() {
        // Smoothing is disabled when smoothing_speed = 1.0 (SDR++ semantics: 1.0 = no smoothing)
        let n = 8;
        let window = ones_window(n);
        let mut fft = FFT::new(n, &window);
        // Default is 1.0 (no smoothing)

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
        // Boundary value tests for smoothing_speed (SDR++ semantics)
        let n = 8;
        let window = ones_window(n);

        // 1.0: No smoothing (100% new value, tested above)

        // 0.0: Fully retain previous value (ignore new value, output frozen)
        let mut fft = FFT::new(n, &window);
        fft.set_smoothing_speed(0.0);

        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i * 2] = 64;
            input[i * 2 + 1] = 0;
        }

        let mut result1 = vec![0.0f32; n];
        fft.fft(&input, &mut result1);

        let mut result2 = vec![0.0f32; n];
        fft.fft(&input, &mut result2);

        // When α=0.0, result2 should equal result1 (output is frozen)
        for i in 0..n {
            if result1[i].is_finite() && result2[i].is_finite() {
                assert_eq!(
                    result1[i], result2[i],
                    "With α=0.0, output should stay constant at index {}",
                    i
                );
            }
        }

        // Negative value: behavior is undefined but must not crash
        let mut fft = FFT::new(n, &window);
        fft.set_smoothing_speed(-0.5);
        let mut result = vec![0.0f32; n];
        // OK as long as it doesn't crash
        fft.fft(&input, &mut result);

        // Value greater than 1.0: may oscillate but must not crash
        let mut fft = FFT::new(n, &window);
        fft.set_smoothing_speed(1.5);
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
        // With (-1)^i window shift, DC signal becomes alternating → all energy at bin N/2
        // DC component after FFT: 0.5 * 8 = 4.0 (scaled by 1/(128*8)), magnitude = 0.5
        // Power: 0.5^2 = 0.25
        // dB: 10 * log10(0.25) ≈ -6.02
        let half_n = n / 2;
        let dc_value = result[half_n]; // DC component is at center

        let expected_db = 10.0 * (0.5_f32 * 0.5_f32).log10(); // ≈ -6.02
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
        fft.set_smoothing_speed(0.3);
        
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

    /// Naive reference calculation matching SDR++ pipeline (efficiency ignored)
    fn calculate_reference_fft(n: usize, window: &[f32], input: &[i8], prev: &mut [f32], alpha: f32) -> Vec<f32> {
        use rustfft::num_complex::Complex;
        // Apply window with (-1)^i shift and scaling (matches SDR++ iq_frontend.cpp)
        let scale = 1.0 / (128.0 * n as f32);
        let mut buffer = vec![Complex { re: 0.0, im: 0.0 }; n];
        for i in 0..n {
            let shift = if i % 2 == 0 { 1.0f32 } else { -1.0f32 };
            buffer[i] = Complex {
                re: input[i*2] as f32,
                im: input[i*2+1] as f32,
            } * (window[i] * scale * shift);
        }
        
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(n);
        fft.process(&mut buffer);
        
        // Power spectrum + dB + smoothing in dB domain (matches SDR++ waterfall.cpp)
        let mut res = vec![0.0f32; n];
        for i in 0..n {
            let power = buffer[i].norm_sqr();
            let db = power.max(1e-20).log10() * 10.0;
            
            res[i] = if alpha < 1.0 {
                let s = alpha * db + (1.0 - alpha) * prev[i];
                prev[i] = s;
                s
            } else {
                db
            };
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
