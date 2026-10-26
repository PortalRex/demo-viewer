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
import * as THREE from 'three';
import {BinkVideo, binkTablesFromDll, type BinkTables, type BinkFrame} from '../game/bink.ts';
import type {GameFiles} from '../game/files.ts';
import {writeAttribute} from './dynamic.ts';
import {exposureUniforms} from './shaderhooks.ts';

export interface ScreenSpec {
	key: string;
	file: string;          // under the game folder, e.g. media/exercises_horiz.bik
	image?: string;        // instead of a movie: this material's texture (e.g. vgui/signage/vgui_indicator_checked)
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
	varying vec2 vUv;
	void main() {
		vec4 c = texture2D(map, vUv);
		gl_FragColor = image > 0.5 ? c : vec4(c.rgb / max(sceneExposure, 1e-3), 1.0);
	}`;

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
				uniforms: {map: {value: tex}, image: {value: 1}, ...exposureUniforms},
				vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false,
				polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
			}));
			this.onChange();
		}).catch(() => {});
		return undefined;
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
					uniforms: {map: {value: null}, image: {value: 0}, ...exposureUniforms},
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
			if (s.image) {
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
	}
}
