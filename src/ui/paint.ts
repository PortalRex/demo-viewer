// The gel on the map at a tick: paint bytes in the lightmap atlas's layout
// (3 bits of power, 5 bits of coverage per luxel), built by replaying the
// segment's paint events, and the colour texture world materials blend in.
import * as THREE from 'three';
import type {BspMap, PaintFace} from '../game/bsp.ts';
import type {PaintEvent} from '../net/paint.ts';
import {Power} from '../net/paint.ts';

const ALPHA_BITS = 5, ALPHA_MAX = 31;
const SPLAT_BIAS = 0.1;  // the engine's paintsplat_bias
const SNAPSHOT_EVERY = 64;

const COLORS: Record<number, [number, number, number]> = {
	[Power.BOUNCE]: [20, 120, 255],
	[Power.REFLECT]: [160, 160, 160],
	[Power.SPEED]: [255, 110, 0],
	[Power.PORTAL]: [235, 235, 235],
	[Power.NONE]: [0, 0, 0],
};

const bias = (x: number, b: number) => Math.pow(x, Math.log(b) / Math.log(0.5));

export class PaintLayer {
	readonly texture: THREE.DataTexture;
	private bytes: Uint8Array;
	private rgba: Uint8Array;
	private width: number;
	private height: number;
	private faces: [number, PaintFace][];
	private events: PaintEvent[];
	private applied = 0;  // events applied to `bytes`
	private snapshots: {applied: number; bytes: Uint8Array}[] = [];
	private dirty = true;

	constructor(bsp: BspMap, events: PaintEvent[]) {
		this.width = bsp.lightmap?.width ?? 1;
		this.height = bsp.lightmap?.height ?? 1;
		this.bytes = new Uint8Array(this.width * this.height);
		this.rgba = new Uint8Array(this.width * this.height * 4);
		this.texture = new THREE.DataTexture(this.rgba, this.width, this.height, THREE.RGBAFormat);
		this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
		this.texture.flipY = false;
		this.texture.channel = 1;
		this.faces = [...bsp.paintFaces];
		this.events = [...events].sort((a, b) => a.tick - b.tick);
		this.snapshots.push({applied: 0, bytes: this.bytes.slice()});
		this.upload();
	}

	get hasPaint() {
		return this.events.length > 0;
	}

	// bring the paint to the state at `tick`
	seek(tick: number) {
		let target = 0;
		while (target < this.events.length && this.events[target].tick <= tick) target++;
		if (target === this.applied) return;
		if (target < this.applied) {
			let snap = this.snapshots[0];
			for (const s of this.snapshots) if (s.applied <= target) snap = s;
			this.bytes.set(snap.bytes);
			this.applied = snap.applied;
		}
		while (this.applied < target) {
			this.apply(this.events[this.applied++]);
			if (this.applied % SNAPSHOT_EVERY === 0 && !this.snapshots.some(s => s.applied === this.applied)) {
				this.snapshots.push({applied: this.applied, bytes: this.bytes.slice()});
			}
		}
		this.dirty = true;
		this.upload();
	}

	private apply(e: PaintEvent) {
		switch (e.kind) {
		case 'map':
			for (const s of e.surfaces) {
				const f = this.faces.find(([i]) => i === s.face)?.[1];
				if (!f) continue;
				for (let y = 0; y < f.h; y++) {
					for (let x = 0; x < f.w; x++) {
						const v = s.data[y * f.w + x];
						if (v !== undefined) this.bytes[(f.y + y) * this.width + f.x + x] = v;
					}
				}
			}
			break;
		case 'removeAll':
			this.bytes.fill(0);
			break;
		case 'all':
			for (const [, f] of this.faces) this.fill(f, (e.power << ALPHA_BITS) | ALPHA_MAX);
			break;
		case 'world':
			if (e.entity !== 0) break;  // brush entities aren't painted yet
			for (const p of e.points) this.splat(p, e.radius, e.power, e.alpha);
			break;
		}
	}

	private fill(f: PaintFace, v: number) {
		for (let y = 0; y < f.h; y++) this.bytes.fill(v, (f.y + y) * this.width + f.x, (f.y + y) * this.width + f.x + f.w);
	}

	// one paint sphere: every face it reaches gets a circle of coverage,
	// strongest at the centre (as the engine's splats, without their noise)
	private splat(p: number[], radius: number, power: number, coat: number) {
		for (const [, f] of this.faces) {
			const planeDist = p[0] * f.normal[0] + p[1] * f.normal[1] + p[2] * f.normal[2] - f.dist;
			if (Math.abs(planeDist) >= radius) continue;
			if (Math.hypot(p[0] - f.center[0], p[1] - f.center[1], p[2] - f.center[2]) > f.radius + radius) continue;
			const d = Math.abs(planeDist);
			const circle = Math.sqrt(radius * radius - d * d);
			const v = f.lmVecs;
			const s = p[0] * v[0] + p[1] * v[1] + p[2] * v[2] + v[3] - f.mins[0];
			const t = p[0] * v[4] + p[1] * v[5] + p[2] * v[6] + v[7] - f.mins[1];
			const ext = Math.max(circle * Math.hypot(v[0], v[1], v[2]), circle * Math.hypot(v[4], v[5], v[6]));
			const r = Math.floor(ext + 0.5);
			if (r <= 0) continue;
			const centerAlpha = d / radius;
			for (let y = Math.max(0, Math.floor(t - ext)); y <= Math.min(f.h - 1, Math.ceil(t + ext)); y++) {
				for (let x = Math.max(0, Math.floor(s - ext)); x <= Math.min(f.w - 1, Math.ceil(s + ext)); x++) {
					const ratio = Math.min(1, Math.max(0, centerAlpha + Math.hypot(x - s, y - t) / r));
					const a = 1 - bias(ratio, SPLAT_BIAS);
					if (a <= 0) continue;
					const i = (f.y + y) * this.width + f.x + x;
					const prev = this.bytes[i];
					if (power === Power.NONE) {
						this.bytes[i] = prev & ~ALPHA_MAX;
					} else {
						const alpha = Math.min(1, (prev & ALPHA_MAX) / ALPHA_MAX + coat * a);
						this.bytes[i] = (power << ALPHA_BITS) | Math.floor(alpha * ALPHA_MAX);
					}
				}
			}
		}
	}

	private upload() {
		if (!this.dirty) return;
		this.dirty = false;
		for (let i = 0; i < this.bytes.length; i++) {
			const b = this.bytes[i];
			const c = COLORS[b >> ALPHA_BITS] ?? COLORS[Power.NONE];
			this.rgba[i * 4] = c[0];
			this.rgba[i * 4 + 1] = c[1];
			this.rgba[i * 4 + 2] = c[2];
			this.rgba[i * 4 + 3] = Math.round((b & ALPHA_MAX) / ALPHA_MAX * 255);
		}
		this.texture.needsUpdate = true;
	}
}
