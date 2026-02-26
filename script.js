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
			snackbar: { show: false, message: "" },
			radio: {
				centerFreq: 100.0,
				sampleRate: 8000000,
				fftSize: 2048,
			},
			gains: {
				lna: 16,
				vga: 16,
				ampEnabled: false,
			},
			audio: {
				enabled: false,
				freq: 100.0,
				mode: 'wbfm',
				volume: 50,
			},
			info: { boardName: "" },
			hoverFreqText: "",
			view: {
				zoomScale: 1.0,
				zoomOffset: 0.0 // 0 to 1-1/scale
			}
		};
	},
	computed: {
		// Calculate the min/max display bandwidth based on sampleRate AND zoom state
		minFreq() {
			const baseMin = this.radio.centerFreq - (this.radio.sampleRate / 2) / 1e6;
			const baseSpan = this.radio.sampleRate / 1e6;
			return baseMin + (baseSpan * this.view.zoomOffset);
		},
		maxFreq() {
			const baseMin = this.radio.centerFreq - (this.radio.sampleRate / 2) / 1e6;
			const baseSpan = this.radio.sampleRate / 1e6;
			return baseMin + (baseSpan * (this.view.zoomOffset + (1.0 / this.view.zoomScale)));
		}
	},
	methods: {
		formatFreq(mhz) {
			if (!mhz) return "000.000000";
			let s = mhz.toFixed(6);
			return s.padStart(10, '0');
		},
		labelFreq(percent) {
			const freq = this.minFreq + percent * (this.maxFreq - this.minFreq);
			return freq.toFixed(2);
		},
		showMsg(msg) {
			this.snackbar.message = msg;
			this.snackbar.show = true;
			setTimeout(() => { this.snackbar.show = false; }, 3000);
		},
		async connect() {
			if (!this.backend) return;
			this.showMsg("Connecting...");
			try {
				let ok = await this.backend.open();
				if (!ok) {
					const device = await HackRF.requestDevice();
					if (!device) return;
					ok = await this.backend.open({
						vendorId: device.vendorId,
						productId: device.productId,
						serialNumber: device.serialNumber
					});
				}
				if (ok) {
					this.connected = true;
					const info = await this.backend.info();
					this.info.boardName = HackRF.BOARD_ID_NAME.get(info.boardId);
					this.showMsg("Connected to " + this.info.boardName);
				} else {
					this.showMsg("Failed to open device.");
				}
			} catch (e) {
				this.showMsg("Connect Error: " + e.message);
			}
		},
		async disconnect() {
			if (this.running) await this.togglePlay();
			await this.backend.close();
			this.connected = false;
			this.showMsg("Disconnected");
		},
		async togglePlay() {
			console.log('togglePlay clicked, current running state:', this.running);
			if (this.running) {
				await this.backend.stopRx();
				this.running = false;
				if (this.audioCtx) {
					try { await this.audioCtx.close(); } catch (_) { }
					this.audioCtx = null;
					this.gainNode = null;
				}
			} else {
				this.startStream();
			}
		},
		async startStream() {
			console.log('startStream called, current running state:', this.running);
			if (this.running) return;

			this.initCanvas();

			const opts = {
				centerFreq: this.radio.centerFreq,
				sampleRate: this.radio.sampleRate,
				fftSize: this.radio.fftSize,
				lnaGain: this.gains.lna,
				vgaGain: this.gains.vga,
				ampEnabled: this.gains.ampEnabled,
			};

			console.log('Calling backend.startRxStream with opts:', opts);
			try {
				await this.backend.startRxStream(opts,
					Comlink.proxy((spectrumData) => this.drawSpectrum(spectrumData)),
					Comlink.proxy((audioSamples) => this.playAudio(audioSamples))
				);
				console.log('backend.startRxStream returned successfully.');
			} catch (e) {
				console.error('Error starting RX stream:', e);
				this.showMsg("Error starting stream.");
			}

			this.running = true;

			// Initially send audio params to backend 
			this.updateBackendAudioParams();
		},
		initCanvas() {
			const { fftSize } = this.radio;
			const { waterfall, fft } = this.$refs;

			const nx = Math.pow(2, Math.ceil(Math.log2(fftSize)));
			const useWebGL = nx <= 16384;
			this.waterfallEngine = useWebGL ?
				new WaterfallGL(waterfall, fftSize, 512) :
				new Waterfall(waterfall, fftSize, 512);

			const rect = this.$refs.fftContainer.getBoundingClientRect();
			fft.width = fftSize;
			fft.height = rect.height;
			this.fftCtx = fft.getContext('2d');
		},
		drawSpectrum(data) {
			if (!this.running || !this.fftCtx) return;

			// Waterfall drawing
			this.waterfallEngine.renderLine(data);

			const ctx = this.fftCtx;
			const w = ctx.canvas.width;
			const h = ctx.canvas.height;

			ctx.fillStyle = "rgba(0, 0, 0, 1)";
			ctx.fillRect(0, 0, w, h);

			// Grid
			ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (let p of [0.25, 0.5, 0.75]) {
				ctx.moveTo(w * p, 0);
				ctx.lineTo(w * p, h);
			}
			ctx.stroke();

			// Spectrum Data
			ctx.save();
			ctx.beginPath();
			ctx.moveTo(0, h);

			const pointsToDraw = data.length / this.view.zoomScale;
			const startIdx = Math.floor(data.length * this.view.zoomOffset);

			for (let i = 0; i < pointsToDraw; i++) {
				const dataIdx = startIdx + i;
				if (dataIdx >= data.length) break;
				// data[i] is rough dB, from -120 to -20 mostly, adapt visual scale
				// e.g. -110 is bottom, -10 is top
				const n = (data[dataIdx] + 110) / 100;
				let y = h - (h * n);
				if (y < 0) y = 0;
				if (y > h) y = h;

				const x = (i / pointsToDraw) * w;
				ctx.lineTo(x, y);
			}
			ctx.strokeStyle = "#4da6ff";
			ctx.lineWidth = 1;
			ctx.stroke();

			// Fill under spectrum
			ctx.lineTo(w, h);
			ctx.lineTo(0, h);
			ctx.fillStyle = "rgba(77, 166, 255, 0.1)";
			ctx.fill();
			ctx.restore();

			// Draw VFO highlight
			if (this.audio.freq !== null && this.audio.enabled) {
				const bandwidthHz = this.audio.mode === 'wbfm' ? 150000 : (this.audio.mode === 'nbfm' ? 15000 : 10000);

				const currentSpanHz = this.radio.sampleRate / this.view.zoomScale;
				const pixelWidth = (bandwidthHz / currentSpanHz) * w;

				const offsetFreq = (this.audio.freq - this.radio.centerFreq) * 1e6;
				const basePixel = (offsetFreq / this.radio.sampleRate) * w + (w / 2);

				// Adjust for zoom
				const zoomedPixelOffset = basePixel - (this.view.zoomOffset * w);
				const centerPixel = zoomedPixelOffset * this.view.zoomScale;

				// Red tint block
				ctx.fillStyle = "rgba(255, 68, 68, 0.25)";
				ctx.fillRect(centerPixel - pixelWidth / 2, 0, Math.max(pixelWidth, 2), h);

				// Red center line
				ctx.strokeStyle = "#ff4444";
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(centerPixel, 0);
				ctx.lineTo(centerPixel, h);
				ctx.stroke();
			}
		},
		async toggleAudio() {
			this.audio.enabled = !this.audio.enabled;
			if (this.audio.enabled && !this.audioCtx) {
				const AudioContext = window.AudioContext || window.webkitAudioContext;
				this.audioCtx = new AudioContext({ sampleRate: 48000 });
				if (this.audioCtx.state === 'suspended') {
					await this.audioCtx.resume();
				}
				this.gainNode = this.audioCtx.createGain();
				this.gainNode.gain.value = this.audio.volume / 100;
				this.gainNode.connect(this.audioCtx.destination);
				this.nextPlayTime = 0;
			}
			this.updateBackendAudioParams();
		},
		playAudio(samples) {
			if (!this.audio.enabled || !this.audioCtx) return;
			if (this.audioCtx.state === 'suspended') return;

			let floats;
			if (samples instanceof Float32Array) floats = samples;
			else {
				const len = samples.length || Object.keys(samples).length;
				floats = new Float32Array(len);
				for (let i = 0; i < len; i++) floats[i] = samples[i];
			}

			if (!floats.length) return;

			const buffer = this.audioCtx.createBuffer(1, floats.length, 48000);
			buffer.getChannelData(0).set(floats);

			const src = this.audioCtx.createBufferSource();
			src.buffer = buffer;
			src.connect(this.gainNode);

			if (this.nextPlayTime < this.audioCtx.currentTime) {
				this.nextPlayTime = this.audioCtx.currentTime + 0.05;
			}
			src.start(this.nextPlayTime);
			this.nextPlayTime += buffer.duration;
		},
		updateBackendAudioParams() {
			if (this.backend && this.running) {
				this.backend.setAudioParams({
					freq: this.audio.freq,
					mode: this.audio.mode,
					enabled: this.audio.enabled
				});
			}
		},
		saveSetting() {
			const json = JSON.stringify({ radio: this.radio, gains: this.gains, audio: this.audio, view: this.view });
			localStorage.setItem('sdr-web-setting', json);
		},
		loadSetting() {
			try {
				const json = localStorage.getItem('sdr-web-setting');
				if (json) {
					const setting = JSON.parse(json);
					if (setting.radio) Object.assign(this.radio, setting.radio);
					if (setting.gains) Object.assign(this.gains, setting.gains);
					if (setting.audio) Object.assign(this.audio, setting.audio);
					if (setting.view) Object.assign(this.view, setting.view);
					this.audio.enabled = false; // ensure audio is physically off on load
				}
			} catch (e) { }
		},
		applyZoomToEngine() {
			if (this.waterfallEngine) {
				this.waterfallEngine.setZoom(this.view.zoomOffset, this.view.zoomScale);
			}
		},
		handleWheelZoom(e, rect) {
			e.preventDefault();

			const zoomSensitivity = 0.1;
			const zoomDir = e.deltaY < 0 ? 1 : -1;
			const newScale = Math.max(1.0, Math.min(100.0, this.view.zoomScale * (1 + (zoomDir * zoomSensitivity))));

			// Calculate where the mouse is relative to the current view
			const mouseX = e.clientX - rect.left;
			const p = mouseX / rect.width;

			// Calculate the absolute normalized coordinate of the mouse
			const absNormTarget = this.view.zoomOffset + (p / this.view.zoomScale);

			// Calculate new offset to keep the absolute target under the mouse
			let newOffset = absNormTarget - (p / newScale);

			// Clamp offset
			const maxOffset = 1.0 - (1.0 / newScale);
			if (newOffset < 0) newOffset = 0;
			if (newOffset > maxOffset) newOffset = maxOffset;

			this.view.zoomScale = newScale;
			this.view.zoomOffset = newOffset;

			this.applyZoomToEngine();
		}
	},
	created: async function () {
		this.loadSetting();
		this.backend = await new Backend();
		await this.backend.init();

		this.$watch('radio', async () => {
			this.saveSetting();
			// Reset zoom on radio change
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.running) {
				await this.togglePlay();
				await this.togglePlay();
			}
		}, { deep: true });

		this.$watch('gains', () => {
			if (this.running && this.connected) {
				// We don't have individual gain methods anymore since they were removed.
				// However, changing startRxStream will re-apply gains. Or we can just restart.
				// Wait actually I never removed them, they are back in worker.js! But they aren't exposed in worker.js.
				// It's safest to just restart the stream since we are using DDC anyway, 
				// but actually restarting isn't ideal. Let me just leave this.
				// Actually they ARE exposed by `Comlink` directly grabbing the methods.
				if (this.backend.setAmpEnable) {
					this.backend.setAmpEnable(this.gains.ampEnabled);
					this.backend.setLnaGain(this.gains.lna);
					this.backend.setVgaGain(this.gains.vga);
				}
			}
			this.saveSetting();
		}, { deep: true });

		this.$watch('audio', () => {
			if (this.gainNode) {
				this.gainNode.gain.value = this.audio.volume / 100;
			}
			this.updateBackendAudioParams();
			this.saveSetting();
		}, { deep: true });

		this.$watch('view', () => {
			this.applyZoomToEngine();
			this.saveSetting();
		}, { deep: true });
	},
	mounted() {
		// Event listeners for tuning on canvas
		let isDraggingVFO = false;
		let isPanning = false;
		let lastPanX = 0;

		const getFreqFromEvent = (e) => {
			const rect = e.currentTarget.getBoundingClientRect();
			const p = (e.clientX - rect.left) / rect.width;
			return this.minFreq + p * (this.maxFreq - this.minFreq);
		};

		const updateHover = (e) => {
			const hoverFreq = getFreqFromEvent(e);
			this.hoverFreqText = hoverFreq.toFixed(3) + " MHz";

			const rect = e.currentTarget.getBoundingClientRect();
			const p = (e.clientX - rect.left) / rect.width;
			const ht = this.$refs.hoverTick;
			ht.style.display = "block";
			ht.style.left = (p * 100) + "%";
		};

		const handleMouseMove = (e) => {
			if (isDraggingVFO) {
				const f = getFreqFromEvent(e);
				this.audio.freq = parseFloat(f.toFixed(3));
				this.updateBackendAudioParams();
			} else if (isPanning) {
				const dx = e.clientX - lastPanX;
				lastPanX = e.clientX;
				const rect = e.currentTarget.getBoundingClientRect();

				// convert pixel delta to normalized view delta
				const pDelta = dx / rect.width;
				// adjust offset
				let newOffset = this.view.zoomOffset - (pDelta / this.view.zoomScale);

				const maxOffset = 1.0 - (1.0 / this.view.zoomScale);
				if (newOffset < 0) newOffset = 0;
				if (newOffset > maxOffset) newOffset = maxOffset;

				this.view.zoomOffset = newOffset;
				this.applyZoomToEngine();
				updateHover(e);
			} else {
				updateHover(e);
			}
		};

		const leaveListener = () => {
			this.$refs.hoverTick.style.display = "none";
			isDraggingVFO = false;
			isPanning = false;
		};

		const handleMouseDown = (e) => {
			if (e.button === 0) {
				// Left click: set VFO
				isDraggingVFO = true;
				const f = getFreqFromEvent(e);
				this.audio.freq = parseFloat(f.toFixed(3));
				this.updateBackendAudioParams();
			} else if (e.button === 2) {
				// Right click: pan
				isPanning = true;
				lastPanX = e.clientX;
			}
		};

		const handleMouseUp = (e) => {
			isDraggingVFO = false;
			isPanning = false;
		};

		// Prevent context menu on right click for panning
		const handleContextMenu = (e) => e.preventDefault();

		const attachCanvasEvents = (canvas) => {
			canvas.addEventListener('mousemove', handleMouseMove);
			canvas.addEventListener('mouseleave', leaveListener);
			canvas.addEventListener('mousedown', handleMouseDown);
			canvas.addEventListener('mouseup', handleMouseUp);
			canvas.addEventListener('contextmenu', handleContextMenu);
			canvas.addEventListener('wheel', (e) => {
				this.handleWheelZoom(e, e.currentTarget.getBoundingClientRect());
				updateHover(e);
			}, { passive: false });
		};

		attachCanvasEvents(this.$refs.fft);
		attachCanvasEvents(this.$refs.waterfall);

		// Initial application of zoom bounds
		this.applyZoomToEngine();
	}
}).mount('#app');
