// Bink movie screens (vgui_movie_display: the elevator signs, chamber
// screens). Each CMovieDisplay has a vgui screen: a panel its width by its
// height, from its origin (the lower left corner) along its forward axis and
// up its left one (C_VGuiScreen::ComputeEdges), facing out along its up axis.
// The movie plays from when its display is enabled, looping or holding its
// last frame; a group's forced slaves show their master's movie, each
// through its own corner of it (custom UVs: one movie across a ring of
// signs). Drawn as vgui is: the movie's own colours on the screen, untouched
// by the lighting or the view's exposure. Other vgui screens that draw a
// texture (indicator panels' checks and crosses) go the same way, with their
// texture's alpha, and taking the exposure (matched to the game's frames).
// Screens with a label (finale 4's neurotoxin clock) have their text drawn
// into a canvas over the texture.
import * as THREE from 'three';
import {decodeVfont} from './hudtext.ts';
import {BinkVideo, binkTablesFromDll, type BinkTables, type BinkFrame} from '../game/bink.ts';
import type {GameFiles} from '../game/files.ts';
import {writeAttribute} from './dynamic.ts';
import {exposureUniforms} from './shaderhooks.ts';

export interface ScreenSpec {
	key: string;
	file: string;          // under the game folder, e.g. media/exercises_horiz.bik
	image?: string;        // instead of a movie: this material's texture (e.g. vgui/signage/vgui_indicator_checked)
	dial?: number;         // a countdown dial over it: the eighths of its time left (0..8)
	text?: string;         // a label over the image (its own material per screen)
	start: number;         // seconds: when it started playing
	looping: boolean;
	corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3];  // lower left, upper left, upper right
	uv: [number, number, number, number];  // u from, u to, v from (top), v to
}

interface Movie {
	video: BinkVideo | null;
	texture: THREE.DataTexture | null;
	rgba: Uint8Array | null;
	shown: number;         // the frame the texture holds
	material: THREE.ShaderMaterial;
}

// (the frame's exposure is undone for movies, as the final pass applies it)
const VERTEX = `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}`;
const FRAGMENT = `
	uniform sampler2D map;
	uniform float sceneExposure;
	uniform float image;  // an image screen: its alpha, and exposed
	uniform float dial;   // a countdown's eighths left, or < 0
	uniform sampler2D label;  // a label's text over it (hasLabel)
	uniform float hasLabel;
	varying vec2 vUv;
	void main() {
		vec4 c = texture2D(map, vUv);
		if (hasLabel > 0.5) {
			vec4 l = texture2D(label, vUv);
			c.rgb = mix(c.rgb, l.rgb, l.a);
		}
		if (dial >= 0.0) {
			// (a ring of eight dark 45-degree segments, going out clockwise
			// from twelve o'clock as the time runs down, the current one fading)
			vec2 d = vec2(vUv.x - 0.5, 0.5 - vUv.y);
			float r = length(d) * 2.0;
			if (r > 0.25 && r < 0.81) {
				float a = atan(d.x, d.y);
				float segment = floor((a < 0.0 ? a + 6.2831853 : a) / 0.78539816);
				float shade = clamp(dial - (7.0 - segment), 0.0, 1.0) * 0.98;
				c.rgb *= 1.0 - shade;
			}
		}
		gl_FragColor = image > 0.5 ? c : vec4(c.rgb / max(sceneExposure, 1e-3), 1.0);
	}`;

const LABEL_FONT = 'P2 UniversLTStd-BoldCn', LABEL_TALL = 80;

// frames decoded at most per update (catching up after a jump is spread out)
const DECODE_BUDGET = 24;

export class MovieScreens {
	readonly group = new THREE.Group();
	private files: GameFiles;
	private tables: Promise<BinkTables | null> | null = null;
	private movies = new Map<string, Movie | null>();
	private loading = new Set<string>();
	private screens = new Map<string, THREE.Mesh>();
	private images = new Map<string, THREE.ShaderMaterial | null>();
	private imageTexture: (material: string) => Promise<THREE.Texture | null>;
	onChange = () => {};

	constructor(files: GameFiles, imageTexture: (material: string) => Promise<THREE.Texture | null>) {
		this.files = files;
		this.imageTexture = imageTexture;
	}

	// an image screen's material, once its texture has loaded
	private image(name: string): THREE.ShaderMaterial | null | undefined {
		if (this.images.has(name)) return this.images.get(name);
		this.images.set(name, null);
		this.imageTexture(name).then(tex => {
			if (!tex) return;
			this.images.set(name, new THREE.ShaderMaterial({
				uniforms: {map: {value: tex}, image: {value: 1}, dial: {value: -1}, label: {value: null}, hasLabel: {value: 0}, ...exposureUniforms},
				vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false,
				polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
			}));
			this.onChange();
		}).catch(() => {});
		return undefined;
	}

	// A labelled screen's material: the image with its text drawn over it,
	// as CNeurotoxinCountdownScreen's label (256 x 128 pixels, text at x 22,
	// its line centred up and down) in NeurotoxinCountdownFont: Univers Bold
	// Condensed 80 tall (a cell height: ascent + descent), black (the
	// clientscheme in the update pak).
	private labelled(key: string, image: string, text: string): THREE.ShaderMaterial | undefined {
		let l = this.labels.get(key);
		if (!l) {
			const canvas = document.createElement('canvas');
			canvas.width = 256;
			canvas.height = 128;
			const label = new THREE.CanvasTexture(canvas);
			label.flipY = false;
			label.colorSpace = THREE.SRGBColorSpace;
			const material = new THREE.ShaderMaterial({
				uniforms: {map: {value: null}, image: {value: 1}, dial: {value: -1}, label: {value: label}, hasLabel: {value: 1}, ...exposureUniforms},
				vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false,
				polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
			});
			this.labels.set(key, l = {material, canvas, texture: label, text: null, ready: false});
			const entry = l;
			Promise.all([this.imageTexture(image), this.labelFont()]).then(([tex]) => {
				if (!tex) return;
				material.uniforms.map.value = tex;
				entry.ready = true;
				entry.text = null;
				this.onChange();
			}).catch(() => {});
		}
		if (!l.ready) return undefined;
		if (l.text !== text) {
			l.text = text;
			const g = l.canvas.getContext('2d')!;
			g.clearRect(0, 0, 256, 128);
			g.fillStyle = 'black';
			g.font = `100px "${LABEL_FONT}"`;
			const m = g.measureText('0');
			const cell = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) || 120;
			const size = 100 * LABEL_TALL / cell;
			g.font = `${size}px "${LABEL_FONT}"`;
			g.textBaseline = 'alphabetic';
			g.fillText(text, 22, (128 - LABEL_TALL) / 2 + m.fontBoundingBoxAscent * size / 100);
			l.texture.needsUpdate = true;
		}
		return l.material;
	}
	private labels = new Map<string, {material: THREE.ShaderMaterial; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; text: string | null; ready: boolean}>();
	private fontLoad: Promise<void> | null = null;
	private labelFont(): Promise<void> {
		this.fontLoad ??= this.files.fs.read('platform/vgui/fonts/univercb.vfont').then(async raw => {
			const ttf = raw && decodeVfont(raw);
			if (!ttf) return;
			const face = new FontFace(LABEL_FONT, ttf.slice().buffer);
			await face.load();
			document.fonts.add(face);
		}).catch(() => {});
		return this.fontLoad;
	}

	private loadTables(): Promise<BinkTables | null> {
		this.tables ??= this.files.fs.read('bin/binkw32.dll').then(b => (b ? binkTablesFromDll(b) : null)).catch(() => null);
		return this.tables;
	}

	private movie(file: string): Movie | null | undefined {
		if (this.movies.has(file)) return this.movies.get(file);
		if (!this.loading.has(file)) {
			this.loading.add(file);
			Promise.all([this.loadTables(), this.files.read(file)]).then(([tables, bytes]) => {
				this.loading.delete(file);
				if (!tables || !bytes) {
					this.movies.set(file, null);
					return;
				}
				const video = new BinkVideo(bytes, tables);
				const material = new THREE.ShaderMaterial({
					uniforms: {map: {value: null}, image: {value: 0}, dial: {value: -1}, label: {value: null}, hasLabel: {value: 0}, ...exposureUniforms},
					vertexShader: VERTEX, fragmentShader: FRAGMENT,
					polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
				});
				this.movies.set(file, {video, texture: null, rgba: null, shown: -1, material});
				this.onChange();
			}).catch(() => {
				this.loading.delete(file);
				this.movies.set(file, null);
			});
		}
		return undefined;
	}

	// the frame a movie should show at `time`: decoded towards (a keyframe
	// first when it's behind what's decoded), a few frames a call
	private show(m: Movie, start: number, looping: boolean, time: number) {
		const v = m.video!;
		const at = Math.max(0, Math.floor((time - start) * v.fps));
		const want = looping ? at % v.frames : Math.min(at, v.frames - 1);
		if (m.shown === want) return;
		let frame: BinkFrame | null = null;
		let from = v.decoded + 1;
		if (v.decoded < 0 || want < v.decoded || want - v.decoded > DECODE_BUDGET * 4) from = v.keyframeBefore(want);
		for (let i = from, n = 0; i <= want && n < DECODE_BUDGET; i++, n++) frame = v.decode(i);
		if (!frame) return;
		m.shown = v.decoded;
		this.upload(m, frame);
	}

	// YCbCr (studio range, BT.601) to sRGB bytes
	private upload(m: Movie, f: BinkFrame) {
		const w = f.width, h = f.height;
		if (!m.texture) {
			m.rgba = new Uint8Array(w * h * 4);
			m.texture = new THREE.DataTexture(m.rgba, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
			m.texture.colorSpace = THREE.SRGBColorSpace;
			m.texture.magFilter = m.texture.minFilter = THREE.LinearFilter;
			m.texture.generateMipmaps = false;
			m.texture.flipY = false;
			m.material.uniforms.map.value = m.texture;
		}
		const out = m.rgba!;
		for (let y = 0; y < h; y++) {
			const yRow = y * f.yStride, cRow = (y >> 1) * f.cStride;
			for (let x = 0; x < w; x++) {
				const Y = 1.164 * (f.y[yRow + x] - 16), U = f.u[cRow + (x >> 1)] - 128, V = f.v[cRow + (x >> 1)] - 128;
				const o = (y * w + x) * 4;
				out[o] = Y + 1.596 * V;
				out[o + 1] = Y - 0.392 * U - 0.813 * V;
				out[o + 2] = Y + 2.017 * U;
				out[o + 3] = 255;
			}
		}
		m.texture!.needsUpdate = true;
	}

	update(specs: ScreenSpec[], time: number) {
		const seen = new Set<string>();
		for (const s of specs) {
			let material: THREE.ShaderMaterial;
			if (s.image && s.text !== undefined) {
				const im = this.labelled(s.key, s.image, s.text);
				if (!im) continue;
				material = im;
			} else if (s.image) {
				const im = this.image(s.image);
				if (!im) continue;
				material = im;
			} else {
				const m = this.movie(s.file);
				if (!m) continue;
				this.show(m, s.start, s.looping, time);
				if (!m.texture) continue;
				material = m.material;
			}
			seen.add(s.key);
			let mesh = this.screens.get(s.key);
			if (!mesh) {
				mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
				mesh.renderOrder = 1;
				this.screens.set(s.key, mesh);
				this.group.add(mesh);
			}
			mesh.material = material;
			// (each screen's dial set as it's drawn: its material is shared)
			mesh.userData.dial = s.dial ?? -1;
			mesh.onBeforeRender = (_r, _s, _c, _g, mat) => {
				const u = (mat as THREE.ShaderMaterial).uniforms;
				if (u.dial.value !== mesh!.userData.dial) {
					u.dial.value = mesh!.userData.dial;
					(mat as THREE.ShaderMaterial).uniformsNeedUpdate = true;
				}
			};
			const [ll, ul, ur] = s.corners;
			const lr = ll.clone().add(ur).sub(ul);
			const [u0, u1, v0, v1] = s.uv;
			// (two triangles facing out of the panel's front)
			const g = mesh.geometry;
			writeAttribute(g, 'position', [ll, lr, ur, ll, ur, ul].flatMap(p => [p.x, p.y, p.z]), 3);
			writeAttribute(g, 'uv', [u0, v1, u1, v1, u1, v0, u0, v1, u1, v0, u0, v0], 2);
			g.setDrawRange(0, 6);
			g.boundingSphere = new THREE.Sphere().setFromPoints([ll, lr, ur, ul]);
			mesh.visible = true;
		}
		for (const [key, mesh] of this.screens) if (!seen.has(key)) mesh.visible = false;
	}

	dispose() {
		for (const mesh of this.screens.values()) mesh.geometry.dispose();
		this.screens.clear();
		this.group.clear();
		for (const m of this.movies.values()) {
			m?.texture?.dispose();
			m?.material.dispose();
		}
		this.movies.clear();
		// (the image textures are the texture library's)
		for (const m of this.images.values()) m?.dispose();
		this.images.clear();
		for (const l of this.labels.values()) {
			l.material.dispose();
			l.texture.dispose();
		}
		this.labels.clear();
	}
}
