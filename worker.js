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
import init, { FFT } from "./hackrf-web/pkg/hackrf_web.js";

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
		const device = !opts ? devices[0] : devices.find( d => {
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

		console.log(`Serial Number: ${serialNo.map( (i) => (i + 0x100000000).toString(16).slice(1) ).join('')}`)
		console.log(`Board ID Number: ${boardId} (${HackRF.BOARD_ID_NAME.get(boardId)})`);
		console.log(`Firmware Version: ${versionString} (API:${apiVersion[0]}.${apiVersion[1]}${apiVersion[2]})`);
		console.log(`Part ID Number: ${partId.map( (i) => (i + 0x100000000).toString(16).slice(1) ).join(' ')}`)
		console.log(`Board Rev: ${HackRF.BOARD_REV_NAME.get(boardRev)} (${boardRev})`)
		return {boardId, versionString, apiVersion, partId, serialNo };
	}

	async start(opts, callback) {
		const { hackrf } = this;

		const { FFT_SIZE, SAMPLE_RATE, lowFreq, highFreq, bandwidth, freqBinCount } = opts;
		console.log({lowFreq, highFreq, bandwidth, freqBinCount});

		await hackrf.setSampleRateManual(SAMPLE_RATE, 1);
		await hackrf.setBasebandFilterBandwidth(15e6);

		const windowFunction = (x) => {
			// blackman window
			const alpha = 0.16;
			const a0 = (1.0 - alpha) / 2.0;
			const a1 = 1.0 / 2.0;
			const a2 = alpha / 2.0;
			return  a0 - a1 * Math.cos(2 * Math.PI * x) + a2 * Math.cos(4 * Math.PI * x);
		};

		const window = new Float32Array(FFT_SIZE);
		for (let i = 0; i < FFT_SIZE; i++) {
			window[i] = windowFunction(i / FFT_SIZE);
		}

		const BYTES_PER_BLOCK = HackRF.BYTES_PER_BLOCK;

		let startTime = performance.now();
		let prevTime = startTime;
		let readBytes = 0;
		let bytesPerSec = 0;
		let sweepCount = 0;
		let sweepPerSec = 0;

		const fft = new FFT(FFT_SIZE, window);
		fft.set_smoothing_time_constant(0.0);
		const line   = new Float32Array(freqBinCount);
		const output = new Float32Array(FFT_SIZE);
		await hackrf.startRxSweep((data) => {
			readBytes += data.length;
			const now = performance.now();
			const duration = now - prevTime;
			if (duration > 1000) {
				bytesPerSec = readBytes / (duration / 1000);
				prevTime = now;
				readBytes = 0;
			}

			let o = 0;
			for (let n = 0, len = 16; n < len; n++) {
				// console.log(o % HackRF.BYTES_PER_BLOCK, n, data[o+0], data[o+1]);
				if (!(data[o+0] === 0x7F && data[o+1] === 0x7F)) {
					console.log('invalid header', n, data[o+0], data[o+1]);
					o += BYTES_PER_BLOCK;
					continue;
				}

				// this is sweep mode
				// JavaScript does not support 64bit, and all bit operations treat number as 32bit.
				// but double can retain 53bit integer (Number.MAX_SAFE_INTEGER) and frequency never exceeds Number.MAX_SAFE_INTEGER
				// so we can calculate with generic floating point math operation.
				const freqH = (
					(data[o+9] << 24) |
					(data[o+8] << 16) |
					(data[o+7] <<  8) |
					(data[o+6] <<  0) )>>>0;
				const freqL = (
					(data[o+5] << 24) |
					(data[o+4] << 16) |
					(data[o+3] <<  8) |
					(data[o+2] <<  0) )>>>0;
				const frequency = 2**32*freqH + freqL;

				const freqM = frequency / 1e6;

				if (freqM < lowFreq) {
					console.log(freqM, 'ignored');
					o += BYTES_PER_BLOCK;
					continue;
				} else
				if (freqM > highFreq) {
					console.log(freqM, 'ignored');
					o += BYTES_PER_BLOCK;
					continue
				} else
				if (freqM === lowFreq) {
					sweepCount++;

					const duration = now - startTime;
					sweepPerSec = sweepCount / (duration / 1000);
					const MAX_FPS = 60;
					if (sweepPerSec < MAX_FPS || sweepCount % Math.round(sweepPerSec / MAX_FPS) === 0) {
						callback(line, { sweepPerSec, bytesPerSec, sweepCount });
					}
					line.fill(0);
				}

				o += BYTES_PER_BLOCK - (FFT_SIZE * 2);
				const target = data.subarray(o, o + FFT_SIZE * 2);
				fft.fft(target, output);
				o += FFT_SIZE * 2;

				//*
				let pos = Math.floor((freqM - lowFreq) / bandwidth * freqBinCount);
				const low = output.subarray(Math.floor(FFT_SIZE/8*1), Math.ceil(FFT_SIZE/8*3) + 1);
				if (pos < line.length) line.set(low.subarray(0, (line.length - pos)), pos);
				const pos2 = pos + FFT_SIZE/2;
				const high = output.subarray(Math.floor(FFT_SIZE/8*5), Math.ceil(FFT_SIZE/8*7) + 1);
				if (pos2 < line.length) line.set(high.subarray(0, (line.length - pos2)), pos2);
				// console.log({freqM, pos, pos2}, output.length, line.length);
				//*/
			}
		});

		console.log('initSweep', [
			[lowFreq, highFreq],
			HackRF.BYTES_PER_BLOCK /* I + Q */,
			SAMPLE_RATE,
			SAMPLE_RATE / 8 * 3,
			HackRF.SWEEP_STYLE_INTERLEAVED
		]);
		await hackrf.initSweep(
			[lowFreq, highFreq],
			HackRF.BYTES_PER_BLOCK /* I + Q */,
			SAMPLE_RATE,
			SAMPLE_RATE / 8 * 3,
			HackRF.SWEEP_STYLE_INTERLEAVED
		);
	}

	async startRxAudio(opts, callback) {
		const { hackrf } = this;
		const { freq, mode, lnaGain, vgaGain, ampEnabled } = opts;

		console.log('startRxAudio:', { freq, mode, lnaGain, vgaGain, ampEnabled });

		const RX_SAMPLE_RATE = 2400000;
		const AUDIO_RATE = 48000;

		// Configure hardware
		await hackrf.setSampleRateManual(RX_SAMPLE_RATE, 1);
		await hackrf.setBasebandFilterBandwidth(
			HackRF.computeBasebandFilterBw(RX_SAMPLE_RATE)
		);
		await hackrf.setFreq(freq * 1e6);
		console.log('startRxAudio: hardware configured, starting RX...');

		// ── DSP Pipeline ──────────────────────────────────────────────
		// 1. 4th-order Butterworth IIR low-pass (fc=100 kHz) on IQ
		//    → acts as channel filter, rejecting out-of-band noise
		// 2. Decimate IQ by 10 (2.4 MSPS → 240 kSPS) with averaging
		// 3. FM/AM demodulate at 240 kSPS
		// 4. Decimate audio by 5 (240 kSPS → 48 kSPS)
		// 5. De-emphasis (50µs for NZ/EU/AU)
		// 6. AGC + soft clip
		const IQ_DECIM = 10;
		const AUDIO_DECIM = 5;

		// 4th-order Butterworth LPF at fc=100kHz, fs=2.4MHz
		// Implemented as 2 cascaded biquad sections
		// Computed via bilinear transform: K = tan(π·fc/fs) = 0.131652
		const lpfSections = [
			{ b0: 0.013749, b1: 0.027498, b2: 0.013749, a1: -1.559076, a2: 0.614080 }, // Q=0.5412
			{ b0: 0.015501, b1: 0.031002, b2: 0.015501, a1: -1.757757, a2: 0.819756 }, // Q=1.3066
		];

		const state = {
			// IIR filter state: 2 sections × 2 channels (Direct Form II Transposed)
			fI: [{ s1: 0, s2: 0 }, { s1: 0, s2: 0 }],
			fQ: [{ s1: 0, s2: 0 }, { s1: 0, s2: 0 }],
			// IQ decimation accumulator
			iqDecimI: 0, iqDecimQ: 0, iqDecimCount: 0,
			// FM discriminator previous sample
			prevI: 0, prevQ: 0,
			// AM DC removal
			dcAvg: 0,
			// Audio decimation
			audioDecimSum: 0, audioDecimCount: 0,
			// De-emphasis
			deemphPrev: 0,
			// AGC
			agcGain: 0,
			chunkCount: 0,
		};

		// Biquad filter – Direct Form II Transposed (numerically stable)
		function biquad(x, sec, st) {
			const y = sec.b0 * x + st.s1;
			st.s1 = sec.b1 * x - sec.a1 * y + st.s2;
			st.s2 = sec.b2 * x - sec.a2 * y;
			return y;
		}

		// Start RX (sets transceiver mode to RECEIVE internally)
		await hackrf.startRx((data) => {
			state.chunkCount++;
			if (state.chunkCount <= 3) {
				console.log(`startRxAudio: chunk #${state.chunkCount}, bytes=${data.length}`);
			}

			const signed = new Int8Array(data.buffer, data.byteOffset, data.length);
			const numIQSamples = signed.length / 2;
			const maxAudioSamples = Math.ceil(numIQSamples / (IQ_DECIM * AUDIO_DECIM)) + 2;
			const audioSamples = new Float32Array(maxAudioSamples);
			let audioIdx = 0;

			for (let i = 0; i < numIQSamples; i++) {
				let I = signed[i * 2] / 128.0;
				let Q = signed[i * 2 + 1] / 128.0;

				// Apply 4th-order Butterworth channel filter (fc=100kHz)
				// This rejects noise outside ±100 kHz, matching SDR++ "bandwidth 150kHz"
				I = biquad(biquad(I, lpfSections[0], state.fI[0]), lpfSections[1], state.fI[1]);
				Q = biquad(biquad(Q, lpfSections[0], state.fQ[0]), lpfSections[1], state.fQ[1]);

				// Accumulate for IQ decimation (averaging provides additional anti-alias)
				state.iqDecimI += I;
				state.iqDecimQ += Q;
				state.iqDecimCount++;

				if (state.iqDecimCount >= IQ_DECIM) {
					const dI = state.iqDecimI / IQ_DECIM;
					const dQ = state.iqDecimQ / IQ_DECIM;
					state.iqDecimI = 0;
					state.iqDecimQ = 0;
					state.iqDecimCount = 0;

					// Demodulate at 240 kSPS
					let demodSample;
					if (mode === 'am') {
						const mag = Math.sqrt(dI * dI + dQ * dQ);
						state.dcAvg = state.dcAvg * 0.999 + mag * 0.001;
						demodSample = (mag - state.dcAvg) * 5.0;
					} else {
						const conjI = dI * state.prevI + dQ * state.prevQ;
						const conjQ = dQ * state.prevI - dI * state.prevQ;
						demodSample = Math.atan2(conjQ, conjI);
						if (mode === 'nbfm') {
							demodSample *= 5.0 / Math.PI;
						} else {
							demodSample /= Math.PI;
						}
					}
					state.prevI = dI;
					state.prevQ = dQ;

					// Audio decimation (240 kSPS → 48 kSPS)
					state.audioDecimSum += demodSample;
					state.audioDecimCount++;

					if (state.audioDecimCount >= AUDIO_DECIM) {
						audioSamples[audioIdx++] = state.audioDecimSum / AUDIO_DECIM;
						state.audioDecimSum = 0;
						state.audioDecimCount = 0;
					}
				}
			}

			if (audioIdx === 0) return;

			const result = audioSamples.slice(0, audioIdx);

			// De-emphasis filter for WBFM
			// 50µs for NZ / Europe / Australia / Japan
			// (use 75e-6 for North America)
			if (mode === 'wbfm' && result.length > 0) {
				const dt = 1.0 / AUDIO_RATE;
				const RC = 50e-6;
				const alpha = Math.exp(-dt / RC);
				for (let i = 0; i < result.length; i++) {
					state.deemphPrev = alpha * state.deemphPrev + (1 - alpha) * result[i];
					result[i] = state.deemphPrev;
				}
			}

			// AGC
			let rms = 0;
			for (let i = 0; i < result.length; i++) rms += result[i] * result[i];
			rms = Math.sqrt(rms / result.length);

			const targetRMS = 0.15;
			const desiredGain = rms > 1e-6 ? targetRMS / rms : 1000;
			const maxGain = 5000;
			const clampedGain = Math.min(desiredGain, maxGain);

			if (!state.agcGain) state.agcGain = clampedGain;
			state.agcGain = state.agcGain * 0.95 + clampedGain * 0.05;

			for (let i = 0; i < result.length; i++) {
				result[i] *= state.agcGain;
				if (result[i] > 1.0) result[i] = 1.0;
				else if (result[i] < -1.0) result[i] = -1.0;
			}

			if (state.chunkCount <= 5) {
				console.log(`startRxAudio: sending ${result.length} samples, rms=${rms.toFixed(6)}, agcGain=${state.agcGain.toFixed(1)}`);
			}
			callback(result);
		});

		// Apply gains AFTER startRx — setTransceiverMode(RECEIVE) inside
		// startRx resets the RF chain, so gains must be set after it.
		if (ampEnabled !== undefined) await hackrf.setAmpEnable(ampEnabled);
		if (lnaGain !== undefined) await hackrf.setLnaGain(lnaGain);
		if (vgaGain !== undefined) await hackrf.setVgaGain(vgaGain);
		console.log('startRxAudio: gains applied after RX start');
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
