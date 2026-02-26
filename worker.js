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

		// ── Audio DDC setup ───────────────────────────────────────────
		// Determine decimation to get close to 240 kSPS
		const targetDemodRate = 240000;
		let decimation = Math.round(sampleRate / targetDemodRate);
		if (decimation < 1) decimation = 1;
		const actualDemodRate = sampleRate / decimation;

		this.audioParams = { freq: centerFreq, mode: 'wbfm', enabled: false };
		// Initialize the Rust NCO/Decimator
		if (this.ddc) {
			this.ddc.free();
		}
		this.ddc = new DspProcessor(sampleRate, 0.0, decimation);

		const maxDdcOut = Math.ceil(131072 / decimation) * 2;
		const ddcOutput = new Float32Array(maxDdcOut);

		// ── Audio Demodulator setup ───────────────────────────────────
		const state = {
			prevI: 0, prevQ: 0,
			dcAvg: 0,
			audioDecimSum: 0, audioDecimCount: 0,
			deemphPrev: 0,
			agcGain: 0,
			chunkCount: 0,
		};

		const AUDIO_RATE = 48000;
		const audioDecimation = Math.round(actualDemodRate / AUDIO_RATE);

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
						const reordered = new Float32Array(fftSize);
						const half = fftSize / 2;
						for (let j = 0; j < half; j++) {
							reordered[j] = spectrumOutput[j + half];
							reordered[j + half] = spectrumOutput[j];
						}
						spectrumCallback(reordered);
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

				const maxAudioSamples = Math.ceil(numDemodSamples / audioDecimation) + 2;
				const audioSamples = new Float32Array(maxAudioSamples);
				let audioIdx = 0;

				for (let i = 0; i < numDemodSamples; i++) {
					const dI = ddcOutput[i * 2];
					const dQ = ddcOutput[i * 2 + 1];

					let demodSample;
					if (this.audioParams.mode === 'am') {
						const mag = Math.sqrt(dI * dI + dQ * dQ);
						state.dcAvg = state.dcAvg * 0.999 + mag * 0.001;
						demodSample = (mag - state.dcAvg) * 5.0;
					} else {
						const conjI = dI * state.prevI + dQ * state.prevQ;
						const conjQ = dQ * state.prevI - dI * state.prevQ;
						demodSample = Math.atan2(conjQ, conjI);
						if (this.audioParams.mode === 'nbfm') {
							demodSample *= 5.0 / Math.PI;
						} else {
							demodSample /= Math.PI;
						}
					}
					state.prevI = dI;
					state.prevQ = dQ;

					state.audioDecimSum += demodSample;
					state.audioDecimCount++;

					if (state.audioDecimCount >= audioDecimation) {
						audioSamples[audioIdx++] = state.audioDecimSum / audioDecimation;
						state.audioDecimSum = 0;
						state.audioDecimCount = 0;
					}
				}

				if (audioIdx === 0) return;

				const result = audioSamples.slice(0, audioIdx);

				if (this.audioParams.mode === 'wbfm' && result.length > 0) {
					const dt = 1.0 / AUDIO_RATE;
					const RC = 75e-6; // 75us for americas
					const alpha = Math.exp(-dt / RC);
					for (let i = 0; i < result.length; i++) {
						state.deemphPrev = alpha * state.deemphPrev + (1 - alpha) * result[i];
						result[i] = state.deemphPrev;
					}
				}

				let rms = 0;
				for (let i = 0; i < result.length; i++) rms += result[i] * result[i];
				rms = Math.sqrt(rms / result.length);

				const targetRMS = 0.15;
				const desiredGain = rms > 1e-6 ? targetRMS / rms : 1000;
				const clampedGain = Math.min(desiredGain, 5000);

				if (!state.agcGain) state.agcGain = clampedGain;
				state.agcGain = state.agcGain * 0.95 + clampedGain * 0.05;

				for (let i = 0; i < result.length; i++) {
					result[i] *= state.agcGain;
					if (result[i] > 1.0) result[i] = 1.0;
					else if (result[i] < -1.0) result[i] = -1.0;
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
