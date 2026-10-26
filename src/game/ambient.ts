// Lighting for models that move (cubes, players, props on panels), as the
// engine lights them: vrad's ambient cubes (six colours, one per axis
// direction) sampled around the map's leaves, plus the strongest world
// lights that weren't already folded into the cubes. All linear, in the
// same units as the lightmaps.

export interface WorldLight {
	origin: [number, number, number];
	color: [number, number, number];  // intensity
	normal: [number, number, number];
	type: number;      // 0 surface, 1 point, 2 spot, 3 skylight, 4 quake, 5 skyambient
	stopdot: number;   // spots: cos of the inner and outer cones
	stopdot2: number;
	exponent: number;
	radius: number;
	attn: [number, number, number];  // constant, linear, quadratic
	style: number;
	inAmbient: boolean;  // already in the ambient cubes
}

export interface ModelLight {
	cube: number[];    // 6 x rgb: +x -x +y -y +z -z
	// colour at the sample point (attenuated); and, for falloff per point
	// (as the engine's vertex shader does), the colour before the distance
	// falloff and its constant/linear/quadratic terms
	lights: {pos: [number, number, number]; color: [number, number, number]; base?: [number, number, number]; atten?: [number, number, number]}[];
}

const LIGHT_FLAG_IN_AMBIENT_CUBE = 0x1;

export class AmbientLighting {
	private planes: DataView;
	private nodes: DataView;
	private leaves: DataView;
	private index: DataView;
	private samples: DataView;
	private head: number;
	readonly lights: WorldLight[];

	constructor(planes: DataView, nodes: DataView, leaves: DataView, models: DataView, index: DataView, samples: DataView, worldLights: DataView) {
		this.planes = planes;
		this.nodes = nodes;
		this.leaves = leaves;
		this.index = index;
		this.samples = samples;
		this.head = models.byteLength >= 48 ? models.getInt32(36, true) : 0;
		this.lights = [];
		// dworldlight_t: 88 bytes, or 100 in lump version 1 (a shadow cast
		// offset after the normal)
		const len = worldLights.byteLength;
		const v1 = len % 100 === 0 && len >= 100 && [0, 1, 2, 3, 4, 5].includes(worldLights.getInt32(52, true));
		const stride = v1 ? 100 : 88, x = v1 ? 12 : 0;
		for (let o = 0; o + stride <= len; o += stride) {
			const f = (k: number) => worldLights.getFloat32(o + k, true);
			this.lights.push({
				origin: [f(0), f(4), f(8)], color: [f(12), f(16), f(20)], normal: [f(24), f(28), f(32)],
				type: worldLights.getInt32(o + x + 40, true), style: worldLights.getInt32(o + x + 44, true),
				stopdot: f(x + 48), stopdot2: f(x + 52), exponent: f(x + 56), radius: f(x + 60),
				attn: [f(x + 64), f(x + 68), f(x + 72)], inAmbient: (worldLights.getInt32(o + x + 76, true) & LIGHT_FLAG_IN_AMBIENT_CUBE) !== 0,
			});
		}
	}

	get available() {
		return this.samples.byteLength > 0 && this.nodes.byteLength > 0;
	}

	private leafAt(p: number[]): number {
		let node = this.head;
		for (let guard = 0; guard < 4096 && node >= 0; guard++) {
			const o = node * 32;
			const pn = this.nodes.getInt32(o, true);
			const n = [this.planes.getFloat32(pn * 20, true), this.planes.getFloat32(pn * 20 + 4, true), this.planes.getFloat32(pn * 20 + 8, true)];
			const d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - this.planes.getFloat32(pn * 20 + 12, true);
			node = this.nodes.getInt32(o + 4 + (d >= 0 ? 0 : 4), true);
		}
		return -1 - node;
	}

	// the ambient cube at a point (blended from the leaf's samples by
	// distance) and the nearby world lights that reach it
	// (`visible`: whether a light can reach the point, as the engine's light
	// cache traces it; all lights count without it)
	// (`style`: how bright each switchable light style is now, 0 = off)
	at(p: number[], visible?: (from: number[], to: [number, number, number]) => boolean, style?: (s: number) => number): ModelLight {
		// a leaf without samples (or a point just inside a wall): the
		// nearest point around it that has some
		let cube = this.cubeAt(p);
		for (let r = 16; !cube && r <= 64; r *= 2) {
			for (const d of [[0, 0, r], [0, 0, -r], [r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0]]) {
				cube = this.cubeAt([p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
				if (cube) break;
			}
		}
		const out = cube ?? new Array(18).fill(0);
		return {cube: out, lights: this.lightsAt(p, out, visible, style)};
	}

	// The switchable lights (light styles) reaching a static prop: vrad
	// leaves them out of static props' vertex light and the engine adds them
	// at the prop's lighting origin as it runs (its light cache), so these
	// are each light's position and colour there, at its style's value
	switchableAt(p: number[], visible: (from: number[], to: [number, number, number]) => boolean, style: (s: number) => number): ModelLight['lights'] {
		const out: ModelLight['lights'] = [];
		for (const l of this.lights) {
			if (!l.style || (l.type !== 1 && l.type !== 2)) continue;
			const k = this.reach(l, p) * style(l.style);
			if (k <= 0) continue;
			const color: [number, number, number] = [l.color[0] * k, l.color[1] * k, l.color[2] * k];
			if (color[0] + color[1] + color[2] < 1e-5 || !visible(p, l.origin)) continue;
			out.push({pos: l.origin, color});
		}
		return out;
	}

	// a point or spot light's falloff (and cone) at a point
	private reach(l: WorldLight, p: number[]): number {
		const d = [l.origin[0] - p[0], l.origin[1] - p[1], l.origin[2] - p[2]];
		const dist = Math.hypot(d[0], d[1], d[2]);
		if (l.radius > 0 && dist > l.radius) return 0;
		let k = 1 / Math.max(1e-3, l.attn[0] + l.attn[1] * dist + l.attn[2] * dist * dist);
		if (l.type === 2) {
			const dot = -(d[0] * l.normal[0] + d[1] * l.normal[1] + d[2] * l.normal[2]) / Math.max(dist, 1e-3);
			if (dot <= l.stopdot2) return 0;
			if (dot < l.stopdot) k *= (dot - l.stopdot2) / Math.max(1e-3, l.stopdot - l.stopdot2);
			if (l.exponent > 0) k *= Math.pow(Math.max(dot, 0), l.exponent);
		}
		return k;
	}

	private cubeAt(p: number[]): number[] | null {
		const cube = new Array(18).fill(0);
		let leaf = this.leafAt(p);
		// a leaf without samples of its own (solid) borrows a neighbour's
		if (leaf >= 0 && leaf * 4 + 4 <= this.index.byteLength && !this.index.getUint16(leaf * 4, true) && this.index.getUint16(leaf * 4 + 2, true)) {
			leaf = this.index.getUint16(leaf * 4 + 2, true);
		}
		if (leaf >= 0 && leaf * 4 + 4 <= this.index.byteLength) {
			const count = this.index.getUint16(leaf * 4, true), first = this.index.getUint16(leaf * 4 + 2, true);
			const lo = leaf * 32;
			const mins = [0, 1, 2].map(k => this.leaves.getInt16(lo + 8 + k * 2, true));
			const maxs = [0, 1, 2].map(k => this.leaves.getInt16(lo + 14 + k * 2, true));
			let total = 0;
			for (let s = 0; s < count; s++) {
				const o = (first + s) * 28;
				if (o + 28 > this.samples.byteLength) break;
				const sp = [0, 1, 2].map(k => mins[k] + (maxs[k] - mins[k]) * (this.samples.getUint8(o + 24 + k) / 255));
				const d2 = (sp[0] - p[0]) ** 2 + (sp[1] - p[1]) ** 2 + (sp[2] - p[2]) ** 2;
				const w = 1 / (d2 + 1);
				total += w;
				for (let side = 0; side < 6; side++) {
					const c = o + side * 4;
					// ColorRGBExp32 as a light colour: c * 2^e (lightmaps have a further /255)
					const e = 2 ** this.samples.getInt8(c + 3);
					cube[side * 3] += this.samples.getUint8(c) * e * w;
					cube[side * 3 + 1] += this.samples.getUint8(c + 1) * e * w;
					cube[side * 3 + 2] += this.samples.getUint8(c + 2) * e * w;
				}
			}
			if (total > 0) {
				for (let i = 0; i < 18; i++) cube[i] /= total;
				return cube;
			}
		}
		return null;
	}

	// The direct lights not already in the cubes that reach the point: the
	// strongest two as local lights, the rest added into the cube by
	// direction (as the light cache's AddWorldLightToAmbientCube)
	private lightsAt(p: number[], cube?: number[], visible?: (from: number[], to: [number, number, number]) => boolean, style?: (s: number) => number): ModelLight['lights'] {
		const lit: {pos: [number, number, number]; color: [number, number, number]; base: [number, number, number]; atten: [number, number, number]; s: number}[] = [];
		for (const l of this.lights) {
			// (point and spot lights, and texture lights bright enough that vrad
			// left them out of the cubes: emit_surface, 1/r^2 off the face)
			if (l.inAmbient || (l.type !== 0 && l.type !== 1 && l.type !== 2)) continue;
			const d = [l.origin[0] - p[0], l.origin[1] - p[1], l.origin[2] - p[2]];
			const dist = Math.hypot(d[0], d[1], d[2]);
			if (l.radius > 0 && dist > l.radius) continue;
			const on = l.style && style ? style(l.style) : 1;
			// (the falloff by distance apart from the rest)
			let k: number, falloff: number, atten: [number, number, number];
			if (l.type === 0) {
				const facing = -(d[0] * l.normal[0] + d[1] * l.normal[1] + d[2] * l.normal[2]) / Math.max(dist, 1e-3);
				if (facing <= 1e-4) continue;
				k = on * facing;
				falloff = 1 / Math.max(1, dist * dist);
				atten = [0, 0, 1];
			} else {
				k = on;
				falloff = 1 / Math.max(1e-3, l.attn[0] + l.attn[1] * dist + l.attn[2] * dist * dist);
				atten = [l.attn[0], l.attn[1], l.attn[2]];
			}
			if (k <= 0) continue;
			if (l.type === 2) {
				const dot = -(d[0] * l.normal[0] + d[1] * l.normal[1] + d[2] * l.normal[2]) / Math.max(dist, 1e-3);
				if (dot <= l.stopdot2) continue;
				if (dot < l.stopdot) k *= (dot - l.stopdot2) / Math.max(1e-3, l.stopdot - l.stopdot2);
				if (l.exponent > 0) k *= Math.pow(Math.max(dot, 0), l.exponent);
			}
			const base: [number, number, number] = [l.color[0] * k, l.color[1] * k, l.color[2] * k];
			const color: [number, number, number] = [base[0] * falloff, base[1] * falloff, base[2] * falloff];
			const sum = color[0] + color[1] + color[2];
			if (sum < 1e-5) continue;
			lit.push({pos: l.origin, color, base, atten, s: sum});
		}
		lit.sort((a, b) => b.s - a.s);
		const reach = visible ? lit.filter(l => visible(p, l.pos)) : lit;
		if (cube) {
			for (const l of reach.slice(2)) {
				const d = [l.pos[0] - p[0], l.pos[1] - p[1], l.pos[2] - p[2]];
				const len = Math.hypot(d[0], d[1], d[2]) || 1;
				for (let axis = 0; axis < 3; axis++) {
					const c = d[axis] / len;
					const side = axis * 2 + (c >= 0 ? 0 : 1);
					for (let ch = 0; ch < 3; ch++) cube[side * 3 + ch] += l.color[ch] * Math.abs(c);
				}
			}
		}
		return reach.slice(0, 2).map(({pos, color, base, atten}) => ({pos, color, base, atten}));
	}
}
