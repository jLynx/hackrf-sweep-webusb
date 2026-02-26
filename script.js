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

import { createApp } from "./node_modules/vue/dist/vue.esm-browser.js";
import * as Comlink from "./node_modules/comlink/dist/esm/comlink.mjs";
import { HackRF } from "./hackrf.js";
import { Waterfall, WaterfallGL } from "./utils.js";

const Backend = Comlink.wrap(new Worker("./worker.js", { type: "module" }));

createApp({
	data() {
		return {
			backend: null,
			connected: false,
			running: false,
			snackbar: {
				show: false,
				message: ""
			},
			alert: {
				show: false,
				title: "",
				content: ""
			},
			range: {
				start: 2400,
				stop: 2500,
				fftSize: 256
			},
			options: {
				ampEnabled: false,
				antennaEnabled: false,
				lnaGain: 16,
				vgaGain: 16,
				peakHold: false
			},
			info: {
				serialNumber: "",
				boardId: "",
				boardName: "",
				partIdNumber: "",
				firmwareVersion: "",
			},
			metrics: {
				sweepPerSec: 0,
				bytesPerSec: 0,
			},

			audio: {
				frequency: null,
				mode: 'wbfm',
				volume: 50,
				listening: false,
			},

			currentHover: "",
			selectedPreset: null,
			presetGroups: [
				{
					label: "WiFi/ISM",
					presets: [
						{ name: "ISM 2.4GHz (Wi-Fi/BLE/Zigbee)", start: 2400, stop: 2485 },
						{ name: "Wi-Fi 5GHz", start: 5150, stop: 5850 },
					]
				},
				{
					label: "Cellular (LTE)",
					presets: [
						{ name: "Band1 (FDD)", start: 1920, stop: 2170 },
						{ name: "Band3 (FDD)", start: 1710, stop: 1880 },
						{ name: "Band8 (FDD)", start: 880, stop: 960 },
						{ name: "Band19 (FDD)", start: 875, stop: 945 },
						{ name: "Band20 (FDD)", start: 791, stop: 862 },
						{ name: "Band21 (FDD)", start: 1450, stop: 1512 },
						{ name: "Band25 (FDD)", start: 1850, stop: 1995 },
						{ name: "Band26 (FDD)", start: 814, stop: 894 },
						{ name: "Band28 (FDD)", start: 703, stop: 803 },
						{ name: "Band38 (TDD)", start: 2570, stop: 2620 },
						{ name: "Band39 (TDD)", start: 1880, stop: 1920 },
						{ name: "Band40 (TDD)", start: 2300, stop: 2400 },
						{ name: "Band41 (TDD)", start: 2496, stop: 2690 },
						{ name: "Band42 (TDD)", start: 3400, stop: 3600 },
					]
				},
				{
					label: "Japan Sub-GHz",
					presets: [
						{ name: "Wi-SUN (920MHz)", start: 920, stop: 928 },
					]
				},
				{
					label: "Broadcast",
					presets: [
						{ name: "ISDB-T (Digital TV)", start: 470, stop: 710 },
					]
				},
				{
					label: "Others",
					presets: [
						{ name: "Amateur 430MHz", start: 430, stop: 440 },
						{ name: "Amateur 144MHz", start: 144, stop: 146 },
					]
				},
			],
			// Flat preset list for compatibility with existing code
			get presets() {
				const result = [];
				for (const group of this.presetGroups) {
					for (const preset of group.presets) {
						result.push(preset);
					}
				}
				return result;
			}
		};
	},

	methods: {
		openAbout: function () {
			this.$refs.aboutDialog.showModal();
		},

		closeAbout: function () {
			this.$refs.aboutDialog.close();
		},

		applyPreset: function () {
			if (this.selectedPreset) {
				const preset = this.presets.find(p => p.name === this.selectedPreset);
				if (preset) {
					this.range.start = preset.start;
					this.range.stop = preset.stop;
					// FFTサイズは最大値に設定（startメソッド側で画面サイズに応じて制限される）
					this.range.fftSize = 8192;
					this.resetPeak();
				}
			}
		},

		resetPeak: function () {
			this.maxData = null;
		},
		connect: async function () {
			if (!this.backend) {
				this.snackbar.show = true;
				this.snackbar.message = "backend not initialized yet";
				return;
			}

			this.snackbar.show = true;
			this.snackbar.message = "connecting";

			let ok = false;
			try {
				ok = await this.backend.open()
			} catch (e) {
				this.alert.title = "Error";
				this.alert.content = e.message || e.toString();
				this.alert.show = true;
			}

			if (!ok) {
				const device = await HackRF.requestDevice();
				if (!device) {
					this.snackbar.message = "device is not found";
					return;
				}
				this.snackbarMessage = "opening device";
				const ok = await this.backend.open({
					vendorId: device.vendorId,
					productId: device.productId,
					serialNumber: device.serialNumber
				});
				if (!ok) {
					this.alert.content = "failed to open device";
					this.alert.show = true;
				}
			}

			this.connected = true;
			const { boardId, versionString, apiVersion, partId, serialNo } = await this.backend.info();

			this.info.serialNumber = serialNo.map((i) => (i + 0x100000000).toString(16).slice(1)).join('');
			this.info.boardId = boardId;
			this.info.boardName = HackRF.BOARD_ID_NAME.get(boardId);
			this.info.firmwareVersion = `${versionString} (API:${apiVersion[0]}.${apiVersion[1]}${apiVersion[2]})`;
			this.info.partIdNumber = partId.map((i) => (i + 0x100000000).toString(16).slice(1)).join(' ');
			this.snackbar.message = `connected to ${HackRF.BOARD_ID_NAME.get(this.info.boardId)}`;
			console.log('apply options', this.options);
			await this.backend.setAmpEnable(this.options.ampEnabled);
			await this.backend.setAntennaEnable(this.options.antennaEnabled);
			await this.backend.setLnaGain(+this.options.lnaGain);
			await this.backend.setVgaGain(+this.options.vgaGain);
		},

		disconnect: async function () {
			if (this.audio.listening) {
				await this.stopListening();
			}
			await this.backend.close();
			console.log('disconnected');
			this.connected = false;
			this.running = false;
		},

		start: async function () {
			if (this.running) return;
			this.running = false;

			const { canvasFft, canvasWf } = this;

			const SAMPLE_RATE = 20e6;

			const lowFreq = +this.range.start;
			const highFreq0 = +this.range.stop;
			const bandwidth0 = highFreq0 - lowFreq;
			const steps = Math.ceil((bandwidth0 * 1e6) / SAMPLE_RATE);
			const bandwidth = (steps * SAMPLE_RATE) / 1e6;
			const highFreq = lowFreq + bandwidth;
			this.range.stop = highFreq;

			// const FFT_SIZE = +this.range.fftSize;
			// const freqBinCount = (bandwidth*1e6) / SAMPLE_RATE * FFT_SIZE;
			//
			const freqBinCount0 = canvasFft.offsetWidth * window.devicePixelRatio;
			const fftSize0 = Math.pow(2, Math.ceil(Math.log2((freqBinCount0 * SAMPLE_RATE) / (bandwidth * 1e6))));
			const fftSize1 = fftSize0 < +this.range.fftSize ? fftSize0 : +this.range.fftSize;
			const FFT_SIZE = fftSize1 > 8 ? fftSize1 : 8;
			const freqBinCount = (bandwidth * 1e6) / SAMPLE_RATE * FFT_SIZE;

			if (this.range.fftSize != FFT_SIZE) {
				this.snackbar.show = true;
				this.snackbar.message = "FFT Size is limited to rendering width";
				this.range.fftSize = FFT_SIZE;
			}


			console.log({ lowFreq, highFreq, bandwidth, freqBinCount });
			const nx = Math.pow(2, Math.ceil(Math.log2(freqBinCount)));
			const maxTextureSize = 16384;
			const useWebGL = nx <= maxTextureSize;
			console.log(`Waterfall: ${useWebGL ? 'WebGL (WaterfallGL)' : 'Canvas 2D (Waterfall)'} - nx=${nx}, maxTextureSize=${maxTextureSize}`);
			const waterfall = useWebGL ?
				new WaterfallGL(canvasWf, freqBinCount, 256) :
				new Waterfall(canvasWf, freqBinCount, 256);

			canvasFft.height = 200;
			canvasFft.width = freqBinCount;

			const ctxFft = canvasFft.getContext('2d');

			this.maxData = null;
			await this.backend.start({ FFT_SIZE, SAMPLE_RATE, lowFreq, highFreq, bandwidth, freqBinCount }, Comlink.proxy((data, metrics) => {
				this.metrics = metrics;
				requestAnimationFrame(() => {
					/*
					const max = Math.max(...data);
					const min = Math.min(...data);
					console.log({max,min});
					*/

					/*
					if (prevData) {
						for (let i = 0; i < data.length; i++) {
							data[i] = (data[i] + prevData[i]) / 2;
						}
					}
					prevData = data;
					*/

					waterfall.renderLine(data);

					ctxFft.fillStyle = "rgba(0, 0, 0, 0.1)";
					ctxFft.fillRect(0, 0, canvasFft.width, canvasFft.height);

					// Draw grid
					ctxFft.strokeStyle = "rgba(255, 255, 255, 0.1)";
					ctxFft.lineWidth = 1;
					ctxFft.beginPath();
					for (let p of [0.25, 0.5, 0.75]) {
						ctxFft.moveTo(canvasFft.width * p, 0);
						ctxFft.lineTo(canvasFft.width * p, canvasFft.height);
					}
					ctxFft.stroke();

					if (this.options.peakHold) {
						const now = Date.now();
						if (now - this.captureStartTime > 1000) {
							if (!this.maxData || this.maxData.length !== data.length) {
								this.maxData = new Float32Array(data);
							} else {
								for (let i = 0; i < data.length; i++) {
									if (data[i] > this.maxData[i]) this.maxData[i] = data[i];
								}
							}
						}

						if (this.maxData) {
							ctxFft.beginPath();
							ctxFft.moveTo(0, canvasFft.height);
							for (let i = 0; i < freqBinCount; i++) {
								const n = (this.maxData[i] + 45) / 42;
								ctxFft.lineTo(i, canvasFft.height - canvasFft.height * n);
							}
							ctxFft.strokeStyle = "#ffeb3b";
							ctxFft.stroke();
						}
					}

					ctxFft.save();
					ctxFft.beginPath();
					ctxFft.moveTo(0, canvasFft.height);
					for (let i = 0; i < freqBinCount; i++) {
						const n = (data[i] + 45) / 42;
						ctxFft.lineTo(i, canvasFft.height - canvasFft.height * n);
					}
					ctxFft.strokeStyle = "#fff";
					ctxFft.stroke();
					ctxFft.restore();

						// Draw selected frequency marker
						if (this.audio.frequency !== null) {
							const markerX = (this.audio.frequency - lowFreq) / bandwidth * freqBinCount;
							if (markerX >= 0 && markerX <= freqBinCount) {
								ctxFft.save();
								ctxFft.strokeStyle = "#ff4444";
								ctxFft.lineWidth = 2;
								ctxFft.setLineDash([4, 4]);
								ctxFft.beginPath();
								ctxFft.moveTo(markerX, 0);
								ctxFft.lineTo(markerX, canvasFft.height);
								ctxFft.stroke();

								ctxFft.fillStyle = "#ff4444";
								ctxFft.font = "12px sans-serif";
								ctxFft.setLineDash([]);
								ctxFft.fillText(this.audio.frequency.toFixed(1) + " MHz", markerX + 4, 14);
								ctxFft.restore();
							}
						}
				});
			}));
			this.running = true;
			this.captureStartTime = Date.now();
		},

		stop: async function () {
			await this.backend.stopRx();
			this.running = false;
		},

		selectFrequency: function (freq) {
			if (this.audio.listening) return;
			this.audio.frequency = parseFloat(freq.toFixed(3));
		},

		listen: async function () {
			if (this.audio.listening || this.audio.frequency === null || !this.connected) return;

			// Create audio context IMMEDIATELY (must be in user-gesture callback
			// before any awaits, or Chrome will suspend it)
			this.audioCtx = new AudioContext({ sampleRate: 48000 });
			this.gainNode = this.audioCtx.createGain();
			this.gainNode.gain.value = this.audio.volume / 100;
			this.gainNode.connect(this.audioCtx.destination);
			this.nextPlayTime = 0;

			// Remember if sweep was running so we can restart it later
			this.wasRunning = this.running;

			try {
				// Stop sweep if running
				if (this.running) {
					await this.stop();
				}

				// Ensure AudioContext is running (Chrome autoplay policy)
				if (this.audioCtx.state === 'suspended') {
					await this.audioCtx.resume();
				}
				console.log('AudioContext state:', this.audioCtx.state, 'sampleRate:', this.audioCtx.sampleRate);

				this.audio.listening = true;

				// ── Set up narrowband spectrum/waterfall display ───────
				const { canvasFft, canvasWf } = this;
				const RX_BW_MHZ = 2.4;
				const SPECTRUM_FFT_SIZE = 1024;
				const centerFreq = this.audio.frequency;
				const rxLowFreq = centerFreq - RX_BW_MHZ / 2;
				const rxHighFreq = centerFreq + RX_BW_MHZ / 2;

				// Store for labelFor override during listening
				this.audioSpectrumRange = { start: rxLowFreq, stop: rxHighFreq };

				const freqBinCount = SPECTRUM_FFT_SIZE;
				const nx = Math.pow(2, Math.ceil(Math.log2(freqBinCount)));
				const maxTextureSize = 16384;
				const useWebGL = nx <= maxTextureSize;
				const waterfall = useWebGL ?
					new WaterfallGL(canvasWf, freqBinCount, 256) :
					new Waterfall(canvasWf, freqBinCount, 256);

				canvasFft.height = 200;
				canvasFft.width = freqBinCount;
				const ctxFft = canvasFft.getContext('2d');
				this.audioWaterfall = waterfall;

				this.snackbar.show = true;
				this.snackbar.message = `Listening to ${this.audio.frequency} MHz (${this.audio.mode.toUpperCase()})`;

				await this.backend.startRxAudio(
					{
						freq: this.audio.frequency,
						mode: this.audio.mode,
						lnaGain: +this.options.lnaGain,
						vgaGain: +this.options.vgaGain,
						ampEnabled: this.options.ampEnabled,
					},
					Comlink.proxy((audioSamples) => {
						if (!this.audio.listening) return;
						this.playAudioSamples(audioSamples);
					}),
					Comlink.proxy((spectrumData) => {
						if (!this.audio.listening) return;
						// Convert spectrum data to Float32Array if needed
						let data;
						if (spectrumData instanceof Float32Array) {
							data = spectrumData;
						} else {
							const len = spectrumData.length || Object.keys(spectrumData).length;
							data = new Float32Array(len);
							for (let i = 0; i < len; i++) data[i] = spectrumData[i];
						}

						requestAnimationFrame(() => {
							// Render waterfall
							waterfall.renderLine(data);

							// Render FFT spectrum
							ctxFft.fillStyle = "rgba(0, 0, 0, 0.15)";
							ctxFft.fillRect(0, 0, canvasFft.width, canvasFft.height);

							// Draw grid lines
							ctxFft.strokeStyle = "rgba(255, 255, 255, 0.1)";
							ctxFft.lineWidth = 1;
							ctxFft.beginPath();
							for (let p of [0.25, 0.5, 0.75]) {
								ctxFft.moveTo(canvasFft.width * p, 0);
								ctxFft.lineTo(canvasFft.width * p, canvasFft.height);
							}
							ctxFft.stroke();

							// Draw spectrum line
							ctxFft.save();
							ctxFft.beginPath();
							ctxFft.moveTo(0, canvasFft.height);
							for (let i = 0; i < data.length; i++) {
								const n = (data[i] + 45) / 42;
								ctxFft.lineTo(i, canvasFft.height - canvasFft.height * n);
							}
							ctxFft.strokeStyle = "#fff";
							ctxFft.stroke();
							ctxFft.restore();

							// Draw center frequency marker (tuned frequency)
							const markerX = freqBinCount / 2;
							ctxFft.save();
							ctxFft.strokeStyle = "#ff4444";
							ctxFft.lineWidth = 2;
							ctxFft.setLineDash([4, 4]);
							ctxFft.beginPath();
							ctxFft.moveTo(markerX, 0);
							ctxFft.lineTo(markerX, canvasFft.height);
							ctxFft.stroke();

							ctxFft.fillStyle = "#ff4444";
							ctxFft.font = "12px sans-serif";
							ctxFft.setLineDash([]);
							ctxFft.fillText(centerFreq.toFixed(3) + " MHz", markerX + 4, 14);
							ctxFft.restore();
						});
					})
				);
			} catch (e) {
				console.error('listen() error:', e);
				this.audio.listening = false;
				this.audioSpectrumRange = null;
				if (this.audioCtx) {
					try { await this.audioCtx.close(); } catch (_) { }
					this.audioCtx = null;
					this.gainNode = null;
				}
				this.snackbar.show = true;
				this.snackbar.message = 'Audio error: ' + (e.message || e);
			}
		},

		playAudioSamples: function (samples) {
			if (!this.audioCtx || !samples) return;

			// Comlink may deserialize Float32Array as a plain object with
			// numeric keys; coerce to a real Float32Array if needed.
			let floats;
			if (samples instanceof Float32Array) {
				floats = samples;
			} else if (ArrayBuffer.isView(samples)) {
				floats = new Float32Array(samples.buffer, samples.byteOffset, samples.byteLength / 4);
			} else {
				// Plain array or object — convert manually
				const len = samples.length || Object.keys(samples).length;
				floats = new Float32Array(len);
				for (let i = 0; i < len; i++) floats[i] = samples[i];
			}

			if (!floats.length) return;

			// Debug: log first few calls
			if (!this._audioDbgCount) this._audioDbgCount = 0;
			if (this._audioDbgCount < 5) {
				const maxVal = floats.reduce((a, b) => Math.max(a, Math.abs(b)), 0);
				console.log(`playAudioSamples #${this._audioDbgCount}: type=${samples.constructor.name}, len=${floats.length}, max=${maxVal.toFixed(6)}, gain=${this.gainNode.gain.value}, ctxState=${this.audioCtx.state}`);
				this._audioDbgCount++;
			}

			const buffer = this.audioCtx.createBuffer(1, floats.length, 48000);
			buffer.getChannelData(0).set(floats);

			const src = this.audioCtx.createBufferSource();
			src.buffer = buffer;
			src.connect(this.gainNode);

			// Schedule-ahead buffering for gapless audio
			if (this.nextPlayTime < this.audioCtx.currentTime) {
				this.nextPlayTime = this.audioCtx.currentTime + 0.05;
			}
			src.start(this.nextPlayTime);
			this.nextPlayTime += buffer.duration;
		},

		testTone: function () {
			// Generate a 440Hz test tone for 1 second to verify speakers work
			const ctx = new AudioContext({ sampleRate: 48000 });
			const duration = 1.0;
			const samples = 48000 * duration;
			const buffer = ctx.createBuffer(1, samples, 48000);
			const data = buffer.getChannelData(0);
			for (let i = 0; i < samples; i++) {
				data[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / 48000);
			}
			const src = ctx.createBufferSource();
			src.buffer = buffer;
			const gain = ctx.createGain();
			gain.gain.value = this.audio.volume / 100;
			src.connect(gain).connect(ctx.destination);
			src.start();
			src.onended = () => ctx.close();
			this.snackbar.show = true;
			this.snackbar.message = 'Playing 440Hz test tone...';
		},

		stopListening: async function () {
			this.audio.listening = false;
			this._audioDbgCount = 0;
			this.audioSpectrumRange = null;
			try {
				await this.backend.stopRx();
			} catch (e) {
				console.warn('stopListening: stopRx error (ignored):', e.message || e);
			}
			if (this.audioCtx) {
				try { await this.audioCtx.close(); } catch (e) { }
				this.audioCtx = null;
				this.gainNode = null;
			}
			if (this.audioWaterfall) {
				this.audioWaterfall = null;
			}
			this.snackbar.show = true;
			this.snackbar.message = 'Audio stopped';

			// Restart sweep if it was running before listening
			if (this.wasRunning) {
				this.wasRunning = false;
				await this.start();
			}
		},

		labelFor: function (n) {
			// When listening, show narrowband RX range
			if (this.audioSpectrumRange) {
				const lowFreq = this.audioSpectrumRange.start;
				const highFreq = this.audioSpectrumRange.stop;
				const bandwidth = highFreq - lowFreq;
				const freq = bandwidth * n + lowFreq;
				return freq.toFixed(2);
			}
			const lowFreq = +this.range.start;
			const highFreq = +this.range.stop;
			const bandwidth = highFreq - lowFreq;
			const freq = bandwidth * n + lowFreq;
			return (freq).toFixed(1);
		},

		saveSetting: function () {
			const json = JSON.stringify({
				range: this.range,
				options: this.options
			});
			// console.log('saveSetting', json);
			localStorage.setItem('hackrf-sweep-setting', json);
		},

		loadSetting: function () {
			try {
				const json = localStorage.getItem('hackrf-sweep-setting');
				// console.log('loadSetting', json);
				const setting = JSON.parse(json);
				Object.assign(this.range, setting.range);
				Object.assign(this.options, setting.options);
			} catch (e) {
				console.log(e);
			}
		}
	},

	created: async function () {
		this.loadSetting();

		console.log("creating backend");
		this.backend = await new Backend();
		console.log("backend created");
		await this.backend.init();
		console.log('backend initialized');

		this.$watch('options.ampEnabled', async (val) => {
			if (!this.connected) return;
			await this.backend.setAmpEnable(val);
		});

		this.$watch('options.antennaEnabled', async (val) => {
			if (!this.connected) return;
			await this.backend.setAntennaEnable(val);
		});

		this.$watch('options.lnaGain', async (val) => {
			if (!this.connected) return;
			await this.backend.setLnaGain(+val);
		});

		this.$watch('options.vgaGain', async (val) => {
			if (!this.connected) return;
			await this.backend.setVgaGain(+val);
		});

		this.$watch('options.peakHold', () => {
			this.resetPeak();
		});

		this.$watch('range', () => {
			// 手動で周波数を変更したらプリセット選択をクリア
			if (this.selectedPreset) {
				const preset = this.presets.find(p => p.name === this.selectedPreset);
				if (!preset || preset.start !== this.range.start || preset.stop !== this.range.stop) {
					this.selectedPreset = null;
				}
			}
			this.saveSetting();
		}, { deep: true });

		this.$watch('options', () => {
			this.saveSetting();
		}, { deep: true });

		this.canvasWf = this.$refs.waterfall;
		this.canvasFft = this.$refs.fft;

		const hoverListenr = (e) => {
			const rect = e.currentTarget.getBoundingClientRect();
			const x = e.clientX - rect.x;
			const p = x / rect.width;
			const label = this.labelFor(p);
			this.currentHover = label;
			this.$refs.currentHover.style.left = (p * 100) + "%";
			this.$refs.currentHover.classList.toggle('is-reversed', p > 0.5);
		};

		const leaveListener = (e) => {
			this.$refs.currentHover.style.left = "-100%";
		};

		this.$refs.waterfall.addEventListener('mousemove', hoverListenr);
		this.$refs.waterfall.addEventListener('mouseleave', leaveListener);
		this.$refs.fft.addEventListener('mousemove', hoverListenr);
		this.$refs.fft.addEventListener('mouseleave', leaveListener);

		const clickListener = (e) => {
			if (this.audio.listening) return;
			const rect = e.currentTarget.getBoundingClientRect();
			const x = e.clientX - rect.x;
			const p = x / rect.width;
			const low = +this.range.start;
			const high = +this.range.stop;
			const freq = low + p * (high - low);
			this.selectFrequency(freq);
		};
		this.$refs.waterfall.addEventListener('click', clickListener);
		this.$refs.fft.addEventListener('click', clickListener);

		this.$watch('audio.volume', (val) => {
			if (this.gainNode) {
				this.gainNode.gain.value = val / 100;
			}
		});

		this.connect();
	},

	mounted: function () {
	}
}).mount('#app');

