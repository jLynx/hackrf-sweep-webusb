/*
Copyright (c) 2019, cho45 <cho45@lowreal.net>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import * as Comlink from "./node_modules/comlink/dist/esm/comlink.mjs";
import { HackRF } from "./hackrf.js";
import init, { FFT, DspProcessor } from "./hackrf-web/pkg/hackrf_web.js";

// wasm モジュール（トップレベルでインポート）
console.log('worker: imported');

let wasmInitialized = false;

async function ensureWasmInitialized() {
	if (!wasmInitialized) {
		console.log('worker: loading wasm...');
		await init();
		wasmInitialized = true;
		console.log('worker: wasm loaded');
	}
}

class Worker {
	constructor() {
	}

	async init() {
		console.log('init worker');
		await ensureWasmInitialized();
	}

	async open(opts) {
		const devices = await navigator.usb.getDevices();
		const device = !opts ? devices[0] : devices.find(d => {
			if (opts.vendorId) {
				if (d.vendorId !== opts.vendorId) {
					return false;
				}
			}
			if (opts.productId) {
				if (d.productId !== opts.productId) {
					return false;
				}
			}
			if (opts.serialNumber) {
				if (d.serialNumber !== opts.serialNumber) {
					return false;
				}
			}
			return true;
		});
		if (!device) {
			return false;
		}
		console.log(device);
		this.hackrf = new HackRF();
		await this.hackrf.open(device);
		return true;
	}

	async info() {
		const { hackrf } = this;
		const boardId = await hackrf.readBoardId();
		const versionString = await hackrf.readVersionString();
		const apiVersion = await hackrf.readApiVersion();
		const { partId, serialNo } = await hackrf.readPartIdSerialNo();

		let boardRev = HackRF.BOARD_REV_UNDETECTED;
		try {
			boardRev = await hackrf.boardRevRead();
		} catch (e) {
			console.log(e);
		}

		console.log(`Serial Number: ${serialNo.map((i) => (i + 0x100000000).toString(16).slice(1)).join('')}`)
		console.log(`Board ID Number: ${boardId} (${HackRF.BOARD_ID_NAME.get(boardId)})`);
		console.log(`Firmware Version: ${versionString} (API:${apiVersion[0]}.${apiVersion[1]}${apiVersion[2]})`);
		console.log(`Part ID Number: ${partId.map((i) => (i + 0x100000000).toString(16).slice(1)).join(' ')}`)
		console.log(`Board Rev: ${HackRF.BOARD_REV_NAME.get(boardRev)} (${boardRev})`)
		return { boardId, versionString, apiVersion, partId, serialNo };
	}

	async startRxStream(opts, spectrumCallback, audioCallback) {
		const { hackrf } = this;
		const { centerFreq, sampleRate, fftSize, lnaGain, vgaGain, ampEnabled } = opts;

		console.log('startRxStream:', { centerFreq, sampleRate, fftSize });

		await hackrf.setSampleRateManual(sampleRate, 1);
		await hackrf.setBasebandFilterBandwidth(
			HackRF.computeBasebandFilterBw(sampleRate)
		);
		await hackrf.setFreq(centerFreq * 1e6);
		console.log('startRxStream: hardware configured, starting RX...');

		// ── Spectrum FFT setup ────────────────────────────────────────
		const spectrumWindowFunc = (x) => {
			const alpha = 0.16;
			const a0 = (1.0 - alpha) / 2.0;
			const a1 = 1.0 / 2.0;
			const a2 = alpha / 2.0;
			return a0 - a1 * Math.cos(2 * Math.PI * x) + a2 * Math.cos(4 * Math.PI * x);
		};
		const spectrumWindow = new Float32Array(fftSize);
		for (let i = 0; i < fftSize; i++) {
			spectrumWindow[i] = spectrumWindowFunc(i / fftSize);
		}
		const spectrumFft = new FFT(fftSize, spectrumWindow);
		spectrumFft.set_smoothing_time_constant(0.6);
		const spectrumOutput = new Float32Array(fftSize);

		const iqBuffer = new Int8Array(fftSize * 2);
		let iqBufferPos = 0;
		let spectrumThrottle = 0;

		// ── FIR Filter Math (SDR++ dsp/taps & dsp/window) ──────────────
		const sinc = (x) => (x === 0.0) ? 1.0 : (Math.sin(x) / x);

		const cosineWindow = (n, N, coefs) => {
			let win = 0.0;
			let sign = 1.0;
			for (let i = 0; i < coefs.length; i++) {
				win += sign * coefs[i] * Math.cos(i * 2.0 * Math.PI * n / N);
				sign = -sign;
			}
			return win;
		};

		const nuttall = (n, N) => {
			const coefs = [0.355768, 0.487396, 0.144232, 0.012604];
			return cosineWindow(n, N, coefs);
		};

		const hzToRads = (freq, samplerate) => 2.0 * Math.PI * (freq / samplerate);

		const estimateTapCount = (transWidth, samplerate) => {
			return Math.floor(3.8 * samplerate / transWidth);
		};

		const windowedSinc = (count, cutoff, samplerate) => {
			const taps = new Float32Array(count);
			const omega = hzToRads(cutoff, samplerate);
			const half = count / 2.0;
			const corr = omega / Math.PI;

			for (let i = 0; i < count; i++) {
				const t = i - half + 0.5;
				taps[i] = sinc(t * omega) * nuttall(t - half, count) * corr;
			}

			return taps;
		};

		class FIRFilter {
			constructor(cutoff, transWidth, samplerate) {
				let count = estimateTapCount(transWidth, samplerate);
				// Even count
				// if (count % 2 !== 0) count++;
				this.taps = windowedSinc(count, cutoff, samplerate);
				this.history = new Float32Array(this.taps.length);
				this.histIdx = 0;
			}

			processOne(sample) {
				this.history[this.histIdx] = sample;
				let out = 0;
				let tapIdx = 0;

				// Circular buffer dot product
				// From histIdx down to 0
				for (let i = this.histIdx; i >= 0; i--) {
					out += this.history[i] * this.taps[tapIdx++];
				}
				// From end of history buffer down to histIdx + 1
				for (let i = this.history.length - 1; i > this.histIdx; i--) {
					out += this.history[i] * this.taps[tapIdx++];
				}

				this.histIdx++;
				if (this.histIdx >= this.history.length) this.histIdx = 0;

				return out;
			}
		}

		// Math greatest common divisor for rational resampling
		const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

		class PolyphaseResampler {
			constructor(interp, decim, taps) {
				this.interp = interp;
				this.decim = decim;
				this.taps = taps;

				// Build filter bank (buildPolyphaseBank from SDR++)
				this.phaseCount = interp;
				this.tapsPerPhase = Math.floor((taps.length + this.phaseCount - 1) / this.phaseCount);
				this.phases = new Array(this.phaseCount);

				for (let i = 0; i < this.phaseCount; i++) {
					this.phases[i] = new Float32Array(this.tapsPerPhase);
				}

				const totTapCount = this.phaseCount * this.tapsPerPhase;
				for (let i = 0; i < totTapCount; i++) {
					const phaseIdx = (this.phaseCount - 1) - (i % this.phaseCount);
					const tapIdx = Math.floor(i / this.phaseCount);
					this.phases[phaseIdx][tapIdx] = (i < taps.length) ? taps[i] : 0.0;
				}

				this.buffer = new Float32Array(this.tapsPerPhase - 1 + 64000); // Need enough space for block
				this.bufStartOffset = this.tapsPerPhase - 1;
				this.phase = 0;
				this.offset = 0;
			}

			process(input, count) {
				const out = [];

				// Copy input to buffer (shifting along in the delay line)
				// We assume buffer handles max chunk sizes appropriately.
				this.buffer.set(input.subarray(0, count), this.bufStartOffset);

				while (this.offset < count) {
					// Do convolution
					let sum = 0.0;
					const phaseTaps = this.phases[this.phase];
					for (let i = 0; i < this.tapsPerPhase; i++) {
						sum += this.buffer[this.offset + i] * phaseTaps[i];
					}
					out.push(sum);

					// Increment phase
					this.phase += this.decim;

					// Branchless phase advance if phase wrap arround occurs
					this.offset += Math.floor(this.phase / this.interp);

					// Wrap around if needed
					this.phase = this.phase % this.interp;
				}
				this.offset -= count;

				// Move delay (memmove in c++)
				this.buffer.copyWithin(0, count, count + this.tapsPerPhase - 1);

				return new Float32Array(out);
			}
		}

		class RationalResampler {
			constructor(inSamplerate, outSamplerate) {
				const IntSR = Math.round(inSamplerate);
				const OutSR = Math.round(outSamplerate);
				const divider = gcd(IntSR, OutSR);

				this.interp = OutSR / divider;
				this.decim = IntSR / divider;

				const tapSamplerate = inSamplerate * this.interp;
				const tapBandwidth = Math.min(inSamplerate, outSamplerate) / 2.0;
				const tapTransWidth = tapBandwidth * 0.1;

				// Generate taps and multiply by interp
				let tapCount = estimateTapCount(tapTransWidth, tapSamplerate);
				let taps = windowedSinc(tapCount, tapBandwidth, tapSamplerate);
				for (let i = 0; i < taps.length; i++) taps[i] *= this.interp;

				this.resamp = new PolyphaseResampler(this.interp, this.decim, taps);
			}

			process(input) {
				return this.resamp.process(input, input.length);
			}
		}

		// ── Audio DDC setup ───────────────────────────────────────────
		// Determine decimation to get close to 240 kSPS
		const targetDemodRate = 240000;
		let decimation = Math.round(sampleRate / targetDemodRate);
		if (decimation < 1) decimation = 1;
		const actualDemodRate = sampleRate / decimation;

		this.audioParams = { freq: centerFreq, mode: 'wfm', enabled: false, deEmphasis: '50us', squelchEnabled: false, squelchLevel: -100.0, lowPass: true, highPass: false, bandwidth: 150000 };
		// Initialize the Rust NCO/Decimator
		if (this.ddc) {
			this.ddc.free();
		}
		this.ddc = new DspProcessor(sampleRate, 0.0, decimation);

		const maxDdcOut = Math.ceil(131072 / decimation) * 2;
		const ddcOutput = new Float32Array(maxDdcOut);

		// ── Audio Demodulator setup (matching SDR++ radio_module.h) ───
		const state = {
			// FM demod state
			prevPhase: 0,
			// AM demod state
			dcAvg: 0,
			carrierAgcGain: 1.0,
			// Filters state
			wfmFir: null,
			audioResampler: null,
			// De-emphasis (SDR++ style: y = alpha*x + (1-alpha)*y_prev)
			deemphPrev: 0,
			// Low pass FIR state (simple IIR approximation for browser - NFM only)
			lpPrev: 0,
			// High pass state (for NFM)
			hpPrev: 0,
			hpPrevIn: 0,
			// AGC state (SDR++ loop::AGC style)
			agcGain: 1.0,
			// SSB/CW frequency translator state
			ssbPhase: 0,
			// CW tone
			cwTone: 700,
			// FM IF Noise Reduction state
			ifnrEnabled: false,
			// Block count
			chunkCount: 0,
		};

		const AUDIO_RATE = 48000;

		// Initialize FIR Filter only for WFM with 15kHz cutoff, 4kHz transition bandwidth
		state.wfmFir = new FIRFilter(15000.0, 4000.0, actualDemodRate);

		// Initialize the high-quality Polyphase Resampler for audio decimation
		state.audioResampler = new RationalResampler(actualDemodRate, AUDIO_RATE);

		await hackrf.startRx((data) => {
			state.chunkCount++;

			// 1. Waterfall / Spectrum processing
			const signed = new Int8Array(data.buffer, data.byteOffset, data.length);
			for (let i = 0; i < signed.length; i++) {
				iqBuffer[iqBufferPos++] = signed[i];
				if (iqBufferPos >= iqBuffer.length) {
					iqBufferPos = 0;
					spectrumThrottle++;
					// ~30 fps update
					if (spectrumThrottle % 15 === 0) {
						spectrumFft.fft(iqBuffer, spectrumOutput);
						// `spectrumOutput` is already DC-centered by the Rust FFT implementation
						// Copy the array because `spectrumOutput` is reused for the next frame
						spectrumCallback(new Float32Array(spectrumOutput));
					}
				}
			}

			// 2. Audio Processing (if enabled)
			if (this.audioParams.enabled) {
				// Shift freq: The tuned freq relative to the center freq
				const shiftHz = (this.audioParams.freq - centerFreq) * 1e6;
				// Since `this.audioParams.freq` might have changed, update DDC shift
				this.ddc.set_shift(sampleRate, shiftHz);

				const numOutParams = this.ddc.process(signed, ddcOutput);
				const numDemodSamples = numOutParams / 2;
				if (numDemodSamples === 0) return;

				// ── Squelch (SDR++ style: average magnitude in dB) ────────
				// SDR++ squelch.h: compute avg magnitude, 10*log10(avg_mag), compare to level
				let squelchMag = 0;
				for (let i = 0; i < numDemodSamples; i++) {
					const dI = ddcOutput[i * 2];
					const dQ = ddcOutput[i * 2 + 1];
					squelchMag += Math.sqrt(dI * dI + dQ * dQ);
				}
				squelchMag /= numDemodSamples;
				const squelchDb = 10 * Math.log10(squelchMag + 1e-12);

				if (this.audioParams.squelchEnabled && squelchDb < this.audioParams.squelchLevel) {
					// Muted by squelch - SDR++ zeros the entire block
					// We pass zeros to the resampler to keep the delay lines matching time
					const zeros = new Float32Array(numDemodSamples);
					const result = state.audioResampler.process(zeros);
					if (result.length > 0) audioCallback(result);
					return;
				}

				const audioDemodRateSamples = new Float32Array(numDemodSamples);

				const mode = this.audioParams.mode;
				const bw = this.audioParams.bandwidth || 150000;

				for (let i = 0; i < numDemodSamples; i++) {
					const dI = ddcOutput[i * 2];
					const dQ = ddcOutput[i * 2 + 1];

					let demodSample;

					if (mode === 'wfm' || mode === 'nfm') {
						// ── FM Demod (SDR++ quadrature.h) ─────────────────
						// phase = atan2(Q, I)
						// out = normalizePhase(phase - prevPhase) * invDeviation
						// invDeviation = 1 / hzToRads(bw/2, actualDemodRate)
						// hzToRads(freq, sr) = (freq / sr) * 2 * PI
						const phase = Math.atan2(dQ, dI);
						let phaseDiff = phase - state.prevPhase;
						// Normalize phase to [-PI, PI]
						while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
						while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;

						const deviation = (bw / 2.0) / actualDemodRate * 2 * Math.PI;
						const invDeviation = 1.0 / deviation;
						demodSample = phaseDiff * invDeviation;

						state.prevPhase = phase;
					}
					else if (mode === 'am') {
						// ── AM Demod (SDR++ am.h) ─────────────────────────
						// Envelope detection: magnitude of IQ
						// DC blocking
						// AGC with attack/decay
						const mag = Math.sqrt(dI * dI + dQ * dQ);

						// DC Blocker (SDR++ correction::DCBlocker)
						// Simple IIR DC blocker: y = x - prevX + 0.9999 * prevY
						const dcAlpha = 0.9999;
						state.dcAvg = dcAlpha * state.dcAvg + (1 - dcAlpha) * mag;
						demodSample = mag - state.dcAvg;

						// Audio-mode AGC (attack=50/15000, decay=5/15000 default)
						const agcAttack = 50.0 / 15000.0;
						const agcDecay = 5.0 / 15000.0;
						const absSample = Math.abs(demodSample);
						if (absSample > state.agcGain) {
							state.agcGain = state.agcGain * (1 - agcAttack) + absSample * agcAttack;
						} else {
							state.agcGain = state.agcGain * (1 - agcDecay) + absSample * agcDecay;
						}
						const agcScale = state.agcGain > 1e-6 ? (0.5 / state.agcGain) : 1.0;
						demodSample *= agcScale;
					}
					else if (mode === 'usb' || mode === 'lsb' || mode === 'dsb') {
						// ── SSB Demod (SDR++ ssb.h) ───────────────────────
						// Frequency translate by +bw/2 (USB), -bw/2 (LSB), 0 (DSB)
						// Then take real part, then AGC
						let shiftFreq = 0;
						if (mode === 'usb') shiftFreq = bw / 2.0;
						else if (mode === 'lsb') shiftFreq = -bw / 2.0;
						// else DSB: shiftFreq = 0

						const phaseInc = (shiftFreq / actualDemodRate) * 2 * Math.PI;
						state.ssbPhase += phaseInc;
						// Keep phase bounded
						if (state.ssbPhase > Math.PI) state.ssbPhase -= 2 * Math.PI;
						if (state.ssbPhase < -Math.PI) state.ssbPhase += 2 * Math.PI;

						// Complex multiply: (dI + j*dQ) * (cos(phase) + j*sin(phase))
						const cosP = Math.cos(state.ssbPhase);
						const sinP = Math.sin(state.ssbPhase);
						const rI = dI * cosP - dQ * sinP;
						// Take real part only
						demodSample = rI;

						// AGC (attack=50/24000, decay=5/24000 default for SSB)
						const agcAttack = 50.0 / 24000.0;
						const agcDecay = 5.0 / 24000.0;
						const absSample = Math.abs(demodSample);
						if (absSample > state.agcGain) {
							state.agcGain = state.agcGain * (1 - agcAttack) + absSample * agcAttack;
						} else {
							state.agcGain = state.agcGain * (1 - agcDecay) + absSample * agcDecay;
						}
						const agcScale = state.agcGain > 1e-6 ? (0.5 / state.agcGain) : 1.0;
						demodSample *= agcScale;
					}
					else if (mode === 'cw') {
						// ── CW Demod (SDR++ cw.h) ─────────────────────────
						// Frequency translate by CW tone (default 700Hz) to produce audible beat
						// Then take real part, then AGC
						const cwTone = state.cwTone || 700;
						const phaseInc = (cwTone / actualDemodRate) * 2 * Math.PI;
						state.ssbPhase += phaseInc;
						if (state.ssbPhase > Math.PI) state.ssbPhase -= 2 * Math.PI;
						if (state.ssbPhase < -Math.PI) state.ssbPhase += 2 * Math.PI;

						const cosP = Math.cos(state.ssbPhase);
						const sinP = Math.sin(state.ssbPhase);
						const rI = dI * cosP - dQ * sinP;
						demodSample = rI;

						// AGC (attack=50/3000, decay=5/3000 for CW IF rate)
						const agcAttack = 50.0 / 3000.0;
						const agcDecay = 5.0 / 3000.0;
						const absSample = Math.abs(demodSample);
						if (absSample > state.agcGain) {
							state.agcGain = state.agcGain * (1 - agcAttack) + absSample * agcAttack;
						} else {
							state.agcGain = state.agcGain * (1 - agcDecay) + absSample * agcDecay;
						}
						const agcScale = state.agcGain > 1e-6 ? (0.5 / state.agcGain) : 1.0;
						demodSample *= agcScale;
					}
					else if (mode === 'raw') {
						// ── RAW Mode (SDR++ raw.h) ────────────────────────
						// Complex to stereo pass-through (just take I component for mono)
						demodSample = dI;
					}
					else {
						demodSample = 0;
					}

					// ── NFM Low/High Pass Filter (SDR++ fm.h) ────────────
					// SDR++ NFM uses FIR filters, we approximate with IIR
					if (mode === 'nfm') {
						// Low pass: bandwidth/2 cutoff
						if (this.audioParams.lowPass) {
							const cutoff = bw / 2.0;
							const dt_lp = 1.0 / actualDemodRate;
							const RC_lp = 1.0 / (2.0 * Math.PI * cutoff);
							const alpha_lp = dt_lp / (RC_lp + dt_lp);
							state.lpPrev = alpha_lp * demodSample + (1 - alpha_lp) * state.lpPrev;
							demodSample = state.lpPrev;
						}
						// High pass: 300Hz cutoff (SDR++ uses 300Hz for voice high pass)
						if (this.audioParams.highPass) {
							const dt_hp = 1.0 / actualDemodRate;
							const RC_hp = 1.0 / (2.0 * Math.PI * 300.0);
							const alpha_hp = RC_hp / (RC_hp + dt_hp);
							const out_hp = alpha_hp * (state.hpPrev + demodSample - state.hpPrevIn);
							state.hpPrevIn = demodSample;
							state.hpPrev = out_hp;
							demodSample = out_hp;
						}
					}

					// ── WFM Low Pass Filter (SDR++ broadcast_fm.h) ───────
					// SDR++ WFM uses exact FIR filter
					if (mode === 'wfm' && this.audioParams.lowPass) {
						demodSample = state.wfmFir.processOne(demodSample);
					}

					audioDemodRateSamples[i] = demodSample;
				}

				// ── Audio Decimation (SDR++ RationalResampler/Polyphase) ───
				let result = state.audioResampler.process(audioDemodRateSamples);

				if (result.length === 0) return;

				// ── De-emphasis (SDR++ filter/deephasis.h) ────────────────
				// Only for FM modes (NFM and WFM) per SDR++
				// SDR++ formula: alpha = dt / (tau + dt), y = alpha*x + (1-alpha)*y_prev
				if ((mode === 'wfm' || mode === 'nfm') && this.audioParams.deEmphasis !== 'none' && result.length > 0) {
					const dt = 1.0 / AUDIO_RATE;
					let tau;
					switch (this.audioParams.deEmphasis) {
						case '22us': tau = 22e-6; break;
						case '50us': tau = 50e-6; break;
						case '75us': tau = 75e-6; break;
						default: tau = 50e-6; break;
					}
					const alpha = dt / (tau + dt);
					for (let i = 0; i < result.length; i++) {
						state.deemphPrev = alpha * result[i] + (1 - alpha) * state.deemphPrev;
						result[i] = state.deemphPrev;
					}
				}

				// ── Output level normalization ────────────────────────────
				// For non-AGC modes (FM, RAW), apply simple RMS-based AGC
				if (mode === 'wfm' || mode === 'nfm' || mode === 'raw') {
					let rms = 0;
					for (let i = 0; i < result.length; i++) rms += result[i] * result[i];
					rms = Math.sqrt(rms / result.length);

					const targetRMS = 0.15;
					const desiredGain = rms > 1e-6 ? targetRMS / rms : 1000;
					const clampedGain = Math.min(desiredGain, 5000);

					if (!state.outputGain) state.outputGain = clampedGain;
					state.outputGain = state.outputGain * 0.95 + clampedGain * 0.05;

					for (let i = 0; i < result.length; i++) {
						result[i] *= state.outputGain;
						if (result[i] > 1.0) result[i] = 1.0;
						else if (result[i] < -1.0) result[i] = -1.0;
					}
				} else {
					// AM, SSB, CW already have per-sample AGC from demod
					// Just hard-clip
					for (let i = 0; i < result.length; i++) {
						if (result[i] > 1.0) result[i] = 1.0;
						else if (result[i] < -1.0) result[i] = -1.0;
					}
				}

				audioCallback(result);
			}
		});

		if (ampEnabled !== undefined) await hackrf.setAmpEnable(ampEnabled);
		if (lnaGain !== undefined) await hackrf.setLnaGain(lnaGain);
		if (vgaGain !== undefined) await hackrf.setVgaGain(vgaGain);
	}

	setAudioParams(params) {
		if (this.audioParams) {
			Object.assign(this.audioParams, params);
			console.log("Audio params updated:", this.audioParams);
		}
	}

	async setSampleRateManual(freq, divider) {
		await this.hackrf.setSampleRateManual(freq, divider);
	}

	async setBasebandFilterBandwidth(bandwidthHz) {
		await this.hackrf.setBasebandFilterBandwidth(bandwidthHz);
	}

	async setLnaGain(value) {
		await this.hackrf.setLnaGain(value);
	}

	async setVgaGain(value) {
		await this.hackrf.setVgaGain(value);
	}

	async setFreq(freqHz) {
		await this.hackrf.setFreq(freqHz);
	}

	async setAmpEnable(enable) {
		await this.hackrf.setAmpEnable(enable);
	}

	async setAntennaEnable(enable) {
		await this.hackrf.setAntennaEnable(enable);
	}

	async initSweep(ranges, numBytes, stepWidth, offset, style) {
		await this.hackrf.initSweep(ranges, numBytes, stepWidth, offset, style);
	}

	async startRx(callback) {
		await this.hackrf.startRx(callback);
	}

	async startRxSweep(callback) {
		await this.hackrf.startRxSweep(callback);
	}

	async stopRx() {
		await this.hackrf.stopRx();
	}

	async close() {
		await this.hackrf.close();
		await this.hackrf.exit();
		await this.hackrf.device.forget();
	}
}

console.log('worker: before Comlink.expose');
Comlink.expose(Worker);
console.log('worker: after Comlink.expose');
