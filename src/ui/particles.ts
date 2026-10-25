// Particle systems, as the game runs them: the definitions from the .pcf
// files (the global manifest, then the map's own), simulated on the CPU
// with the emitters, initializers and operators Portal 2's effects mostly
// use, and drawn as camera-facing sprites (animated through their
// texture's sheet) or velocity-stretched trails.
import * as THREE from 'three';
import {readParticleSystems} from '../game/pcf.ts';
import type {ParticleSystemDef, ParticleOperator, DmxValue} from '../game/pcf.ts';
import {readVtfSheet} from '../game/vtf.ts';
import type {SheetSequence} from '../game/vtf.ts';
import type {GameFiles} from '../game/files.ts';
import type {Materials} from '../game/materials.ts';
import type {TextureCache} from './textures.ts';

const STEP = 1 / 30;

export class ParticleLibrary {
	private systems = new Map<string, ParticleSystemDef>();
	readonly ready: Promise<void>;

	constructor(files: GameFiles, map: string) {
		this.ready = this.load(files, map);
	}

	private async load(files: GameFiles, map: string) {
		const lists = [await files.text('particles/particles_manifest.txt'), await files.text(`maps/${map}_particles.txt`)];
		for (const text of lists) {
			if (!text) continue;
			for (const m of text.matchAll(/"file"\s+"!?([^"]+)"/g)) {
				const bytes = await files.read(m[1].toLowerCase().replace(/\\/g, '/'));
				if (!bytes) continue;
				try {
					for (const s of readParticleSystems(bytes)) this.systems.set(s.name.toLowerCase(), s);
				} catch {
					// a file the reader can't take: its effects just don't show
				}
			}
		}
	}

	get(name: string): ParticleSystemDef | undefined {
		return this.systems.get(name.toLowerCase());
	}
}

// ---- operator parameters ----

const num = (o: ParticleOperator, k: string, d: number): number => {
	const v = o.params.get(k);
	return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d;
};
const vec = (o: ParticleOperator, k: string, d: number[]): number[] => {
	const v = o.params.get(k) as DmxValue;
	return Array.isArray(v) && typeof v[0] === 'number' ? (v as number[]) : d;
};

// ---- particles ----

interface Particle {
	pos: THREE.Vector3;
	vel: THREE.Vector3;
	born: number;      // instance time
	life: number;
	radius: number;
	baseRadius: number;
	rot: number;       // degrees
	rotSpeed: number;
	color: number[];   // 0..1
	baseColor: number[];
	alpha: number;
	baseAlpha: number;
	seq: number;
	trail: number;
	fadeIn: number;    // per-particle random fade times (seconds or proportions)
	fadeOut: number;
}

function mulberry(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export class ParticleInstance {
	readonly def: ParticleSystemDef;
	time = 0;
	particles: Particle[] = [];
	emitting = true;
	private rand: () => number;
	private emitted = new Map<ParticleOperator, number>();
	private children: {inst: ParticleInstance; delay: number}[] = [];
	cp: THREE.Matrix4;  // control point 0 (the effect's origin and orientation)

	constructor(def: ParticleSystemDef, lib: ParticleLibrary, cp: THREE.Matrix4, seed: number, depth = 0) {
		this.def = def;
		this.cp = cp;
		this.rand = mulberry(seed);
		if (depth < 4) {
			def.children.forEach((c, i) => {
				const d = lib.get(c.name);
				if (d) this.children.push({inst: new ParticleInstance(d, lib, cp, seed * 31 + i + 1, depth + 1), delay: c.delay});
			});
		}
		for (let i = 0; i < Math.min(def.initialParticles, def.maxParticles); i++) this.spawn();
	}

	get all(): ParticleInstance[] {
		const out: ParticleInstance[] = [this];
		for (const c of this.children) if (this.time >= c.delay) out.push(...c.inst.all);
		return out;
	}

	get alive(): boolean {
		return this.emitting || this.particles.length > 0 || this.children.some(c => c.inst.alive);
	}

	// starts the simulation at `t` (for effects that have been running a
	// long while: what was emitted before then is gone anyway)
	skipTo(t: number) {
		this.time = t;
		for (const e of this.def.emitters) if (e.fn === 'emit_instantaneously' && num(e, 'emission_start_time', 0) < t) this.emitted.set(e, 0);
	}

	stopEmitting() {
		this.emitting = false;
		for (const c of this.children) c.inst.stopEmitting();
	}

	// runs the effect up to `t` seconds
	advance(t: number) {
		while (this.time + 1e-6 < t) this.step(Math.min(STEP, t - this.time));
	}

	private r(lo: number, hi: number, exp = 1) {
		return lo + (hi - lo) * Math.pow(this.rand(), exp);
	}

	private step(dt: number) {
		const t0 = this.time;
		this.time += dt;
		const t = this.time;
		if (this.emitting) {
			for (const e of this.def.emitters) {
				const start = num(e, 'emission_start_time', 0);
				let want = 0;
				if (e.fn === 'emit_instantaneously') {
					if (t >= start && !this.emitted.has(e)) {
						const lo = num(e, 'num_to_emit_minimum', -1), hi = num(e, 'num_to_emit', 100);
						want = Math.round(lo >= 0 ? this.r(lo, hi) : hi);
						this.emitted.set(e, want);
					}
				} else if (e.fn === 'emit_continuously' || e.fn === 'emit noise') {
					const duration = num(e, 'emission_duration', 0);
					const rate = e.fn === 'emit noise' ? (num(e, 'emission minimum', 0) + num(e, 'emission maximum', 100)) / 2 : num(e, 'emission_rate', 100);
					const a = Math.max(t0, start), b = duration > 0 ? Math.min(t, start + duration) : t;
					if (b > a) {
						const acc = (this.emitted.get(e) ?? 0) + (b - a) * rate;
						want = Math.floor(acc);
						this.emitted.set(e, acc - want);
					}
				}
				for (let i = 0; i < want && this.particles.length < this.def.maxParticles; i++) this.spawn();
			}
		}
		for (const p of this.particles) this.operate(p, dt);
		this.particles = this.particles.filter(p => this.time - p.born < p.life);
		for (const c of this.children) if (t > c.delay) c.inst.advance(t - c.delay);
	}

	private spawn() {
		const def = this.def;
		const origin = new THREE.Vector3().setFromMatrixPosition(this.cp);
		const local = (v: number[]) => new THREE.Vector3(v[0], v[1], v[2]).transformDirection(this.cp).multiplyScalar(Math.hypot(v[0], v[1], v[2]));
		const c = def.color.map(x => x / 255);
		const p: Particle = {
			pos: origin.clone(), vel: new THREE.Vector3(), born: this.time, life: 1,
			radius: def.radius, baseRadius: def.radius, rot: def.rotation, rotSpeed: 0,
			color: c.slice(0, 3), baseColor: c.slice(0, 3), alpha: c[3], baseAlpha: c[3],
			seq: def.sequence, trail: 0.1, fadeIn: 0.25, fadeOut: 0.25,
		};
		const randomDir = () => {
			const z = this.r(-1, 1), a = this.r(0, Math.PI * 2), s = Math.sqrt(1 - z * z);
			return new THREE.Vector3(s * Math.cos(a), s * Math.sin(a), z);
		};
		for (const o of def.initializers) {
			switch (o.fn) {
			case 'lifetime random':
				p.life = this.r(num(o, 'lifetime_min', 0), num(o, 'lifetime_max', 0), num(o, 'lifetime_random_exponent', 1));
				break;
			case 'position within sphere random': {
				const dir = randomDir();
				const bias = vec(o, 'distance_bias', [1, 1, 1]);
				const d = this.r(num(o, 'distance_min', 0), num(o, 'distance_max', 0));
				p.pos.add(new THREE.Vector3(dir.x * bias[0], dir.y * bias[1], dir.z * bias[2]).multiplyScalar(d));
				const speed = this.r(num(o, 'speed_min', 0), num(o, 'speed_max', 0), num(o, 'speed_random_exponent', 1));
				p.vel.addScaledVector(dir, speed);
				const lo = vec(o, 'speed_in_local_coordinate_system_min', [0, 0, 0]), hi = vec(o, 'speed_in_local_coordinate_system_max', [0, 0, 0]);
				p.vel.add(local([this.r(lo[0], hi[0]), this.r(lo[1], hi[1]), this.r(lo[2], hi[2])]));
				break;
			}
			case 'position within box random': {
				const lo = vec(o, 'min', [0, 0, 0]), hi = vec(o, 'max', [0, 0, 0]);
				const off = [this.r(lo[0], hi[0]), this.r(lo[1], hi[1]), this.r(lo[2], hi[2])];
				p.pos.add(num(o, 'use local space', 0) ? local(off) : new THREE.Vector3(off[0], off[1], off[2]));
				break;
			}
			case 'position modify offset random': {
				const lo = vec(o, 'offset min', [0, 0, 0]), hi = vec(o, 'offset max', [0, 0, 0]);
				const off = [this.r(lo[0], hi[0]), this.r(lo[1], hi[1]), this.r(lo[2], hi[2])];
				p.pos.add(num(o, 'offset in local space 0/1', 0) ? local(off) : new THREE.Vector3(off[0], off[1], off[2]));
				break;
			}
			case 'velocity random': {
				p.vel.addScaledVector(randomDir(), this.r(num(o, 'random_speed_min', 0), num(o, 'random_speed_max', 0)));
				const lo = vec(o, 'speed_in_local_coordinate_system_min', [0, 0, 0]), hi = vec(o, 'speed_in_local_coordinate_system_max', [0, 0, 0]);
				p.vel.add(local([this.r(lo[0], hi[0]), this.r(lo[1], hi[1]), this.r(lo[2], hi[2])]));
				break;
			}
			case 'velocity noise': {
				// smooth noise in the game; a random pick from the same range here
				const lo = vec(o, 'output minimum', [0, 0, 0]), hi = vec(o, 'output maximum', [1, 1, 1]);
				const n = [this.r(lo[0], hi[0]), this.r(lo[1], hi[1]), this.r(lo[2], hi[2])];
				p.vel.add(num(o, 'Apply Velocity in Local Space (0/1)', 0) ? local(n) : new THREE.Vector3(n[0], n[1], n[2]));
				break;
			}
			case 'radius random':
				p.radius = p.baseRadius = this.r(num(o, 'radius_min', 1), num(o, 'radius_max', 1), num(o, 'radius_random_exponent', 1));
				break;
			case 'color random': {
				const a = vec(o, 'color1', [255, 255, 255, 255]), b = vec(o, 'color2', [255, 255, 255, 255]), k = this.rand();
				p.color = p.baseColor = [0, 1, 2].map(i => (a[i] + (b[i] - a[i]) * k) / 255);
				break;
			}
			case 'alpha random':
				p.alpha = p.baseAlpha = this.r(num(o, 'alpha_min', 255), num(o, 'alpha_max', 255), num(o, 'alpha_random_exponent', 1)) / 255;
				break;
			case 'rotation random': {
				const flip = num(o, 'randomly_flip_direction', 1) && this.rand() < 0.5 ? -1 : 1;
				p.rot = num(o, 'rotation_initial', 0) + flip * this.r(num(o, 'rotation_offset_min', 0), num(o, 'rotation_offset_max', 360));
				break;
			}
			case 'rotation speed random': {
				const flip = num(o, 'randomly_flip_direction', 1) && this.rand() < 0.5 ? -1 : 1;
				p.rotSpeed = num(o, 'rotation_speed_constant', 0) + flip * this.r(num(o, 'rotation_speed_random_min', 0), num(o, 'rotation_speed_random_max', 360));
				break;
			}
			case 'sequence random':
				p.seq = Math.floor(this.r(num(o, 'sequence_min', 0), num(o, 'sequence_max', 0) + 0.999));
				break;
			case 'trail length random':
				p.trail = this.r(num(o, 'length_min', 0.1), num(o, 'length_max', 0.1));
				break;
			case 'remap initial scalar': {
				// the emitter's age at birth (field 8) mapped onto a field
				if (num(o, 'input field', 8) !== 8) break;
				const i0 = num(o, 'input minimum', 0), i1 = num(o, 'input maximum', 1);
				const k = Math.min(1, Math.max(0, (this.time - i0) / ((i1 - i0) || 1)));
				const val = num(o, 'output minimum', 0) + (num(o, 'output maximum', 1) - num(o, 'output minimum', 0)) * k;
				const scale = num(o, 'output is scalar of initial random range', 0);
				switch (num(o, 'output field', 3)) {
				case 1: p.life = scale ? p.life * val : val; break;
				case 3: p.radius = p.baseRadius = scale ? p.baseRadius * val : val; break;
				case 7: p.alpha = p.baseAlpha = scale ? p.baseAlpha * val : val; break;
				case 4: p.rot = scale ? p.rot * val : val; break;
				}
				break;
			}
			}
		}
		for (const o of def.operators) {
			if (o.fn === 'alpha fade in random') {
				p.fadeIn = this.r(num(o, 'fade in time min', 0.25), num(o, 'fade in time max', 0.25), num(o, 'fade in time exponent', 1));
			} else if (o.fn === 'alpha fade out random') {
				p.fadeOut = this.r(num(o, 'fade out time min', 0.25), num(o, 'fade out time max', 0.25), num(o, 'fade out time exponent', 1));
			}
		}
		this.particles.push(p);
	}

	private operate(p: Particle, dt: number) {
		const age = this.time - p.born;
		const frac = p.life > 0 ? Math.min(1, age / p.life) : 1;
		let alpha = p.baseAlpha;
		for (const o of this.def.operators) {
			switch (o.fn) {
			case 'movement basic': {
				const g = vec(o, 'gravity', [0, 0, 0]);
				p.vel.x += g[0] * dt;
				p.vel.y += g[1] * dt;
				p.vel.z += g[2] * dt;
				const drag = num(o, 'drag', 0);
				if (drag > 0) p.vel.multiplyScalar(Math.pow(Math.max(0, 1 - drag), dt * 30));
				break;
			}
			case 'alpha fade in random': {
				const tIn = num(o, 'proportional 0/1', 1) ? p.fadeIn * p.life : p.fadeIn;
				if (tIn > 0) alpha *= Math.min(1, age / tIn);
				break;
			}
			case 'alpha fade out random': {
				const tOut = num(o, 'proportional 0/1', 1) ? p.fadeOut * p.life : p.fadeOut;
				if (tOut > 0) {
					const k = Math.min(1, Math.max(0, (p.life - age) / tOut));
					alpha *= num(o, 'ease in and out', 1) ? k * k * (3 - 2 * k) : k;
				}
				break;
			}
			case 'alpha fade in simple': {
				const f = num(o, 'proportional fade in time', 0.25);
				if (f > 0) alpha *= Math.min(1, frac / f);
				break;
			}
			case 'alpha fade out simple': {
				const f = num(o, 'proportional fade out time', 0.25);
				if (f > 0) alpha *= Math.min(1, (1 - frac) / f);
				break;
			}
			case 'alpha fade and decay': {
				const a0 = num(o, 'start_alpha', 1), a1 = num(o, 'end_alpha', 0);
				const i0 = num(o, 'start_fade_in_time', 0), i1 = num(o, 'end_fade_in_time', 0.5);
				const o0 = num(o, 'start_fade_out_time', 0.5), o1 = num(o, 'end_fade_out_time', 1);
				let k = 1;
				if (frac < i1) k = a0 + (1 - a0) * Math.max(0, (frac - i0) / ((i1 - i0) || 1));
				else if (frac > o0) k = 1 + (a1 - 1) * Math.min(1, (frac - o0) / ((o1 - o0) || 1));
				alpha *= k;
				break;
			}
			case 'radius scale': {
				const s0 = num(o, 'start_time', 0), s1 = num(o, 'end_time', 1);
				let k = Math.min(1, Math.max(0, (frac - s0) / ((s1 - s0) || 1)));
				const b = num(o, 'scale_bias', 0.5);
				if (b !== 0.5) k = Math.pow(k, Math.log(b) / Math.log(0.5));
				p.radius = p.baseRadius * (num(o, 'radius_start_scale', 1) + (num(o, 'radius_end_scale', 1) - num(o, 'radius_start_scale', 1)) * k);
				break;
			}
			case 'color fade': {
				const c = vec(o, 'color_fade', [255, 255, 255, 255]);
				const s0 = num(o, 'fade_start_time', 0), s1 = num(o, 'fade_end_time', 1);
				let k = Math.min(1, Math.max(0, (frac - s0) / ((s1 - s0) || 1)));
				if (num(o, 'ease_in_and_out', 1)) k = k * k * (3 - 2 * k);
				p.color = [0, 1, 2].map(i => p.baseColor[i] + (c[i] / 255 - p.baseColor[i]) * k);
				break;
			}
			case 'rotation spin roll':
				p.rot += num(o, 'spin_rate_degrees', 0) * dt;
				break;
			case 'rotation basic':
				p.rot += p.rotSpeed * dt;
				break;
			case 'lifespan minimum velocity decay':
				if (age > STEP && p.vel.length() < num(o, 'minimum velocity', 1)) p.life = age;
				break;
			}
		}
		p.alpha = alpha;
		p.pos.addScaledVector(p.vel, dt);
	}
}

// ---- drawing ----

interface SpriteMaterial {
	material: THREE.ShaderMaterial;
	sheet: SheetSequence[] | null;
}

const VERTEX = `
	attribute vec4 pcolor;
	varying vec2 vUv;
	varying vec4 vColor;
	void main() {
		vUv = uv;
		vColor = pcolor;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}`;

const FRAGMENT = `
	uniform sampler2D map;
	uniform float overbright;
	varying vec2 vUv;
	varying vec4 vColor;
	void main() {
		vec4 t = texture2D(map, vUv);
		gl_FragColor = vec4(t.rgb * vColor.rgb * overbright, t.a * vColor.a);
		#include <tonemapping_fragment>
		#include <colorspace_fragment>
	}`;

export class ParticleRenderer {
	readonly group = new THREE.Group();
	private files: GameFiles;
	private materials: Materials;
	private textures: TextureCache;
	private sprites = new Map<string, Promise<SpriteMaterial | null>>();
	private loaded = new Map<string, SpriteMaterial | null>();
	private meshes = new Map<string, THREE.Mesh>();

	constructor(files: GameFiles, materials: Materials, textures: TextureCache) {
		this.files = files;
		this.materials = materials;
		this.textures = textures;
		this.group.renderOrder = 3;
	}

	private sprite(name: string): SpriteMaterial | null | undefined {
		if (this.loaded.has(name)) return this.loaded.get(name);
		if (!this.sprites.has(name)) {
			const p = this.loadSprite(name).catch(() => null);
			this.sprites.set(name, p);
			p.then(s => this.loaded.set(name, s));
		}
		return undefined;
	}

	// a SpriteCard material: its texture (with the sheet it carries) and blending
	private async loadSprite(name: string): Promise<SpriteMaterial | null> {
		const m = await this.materials.raw(name);
		if (!m) return null;
		const base = (m.params.get('$basetexture') ?? '').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');
		if (!base) return null;
		const [tex, bytes] = await Promise.all([this.textures.get(base), this.files.read(`materials/${base}.vtf`)]);
		if (!tex) return null;
		const t = tex.clone();
		t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
		t.needsUpdate = true;
		const on = (k: string) => {
			const v = m.params.get(k);
			return v !== undefined && v !== '0';
		};
		const additive = on('$additive') || on('$addself');
		const material = new THREE.ShaderMaterial({
			uniforms: {map: {value: t}, overbright: {value: Number(m.params.get('$overbrightfactor') ?? 1) || 1}},
			vertexShader: VERTEX,
			fragmentShader: FRAGMENT,
			transparent: true,
			depthWrite: false,
			depthTest: !on('$ignorez'),
			blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
			side: THREE.DoubleSide,
		});
		return {material, sheet: bytes ? readVtfSheet(bytes) : null};
	}

	// rebuilds the quads of every live particle
	draw(instances: ParticleInstance[], camera: THREE.Camera) {
		const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
		const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
		const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
		const batches = new Map<string, {pos: number[]; uv: number[]; col: number[]}>();
		for (const inst of instances) {
			const def = inst.def;
			if (!def.material || !inst.particles.length) continue;
			const sprite = this.sprite(def.material);
			if (!sprite) continue;
			const r = def.renderers.find(o => o.fn === 'render_animated_sprites' || o.fn === 'render_sprite_trail');
			if (!r) continue;
			let b = batches.get(def.material);
			if (!b) batches.set(def.material, b = {pos: [], uv: [], col: []});
			const trail = r.fn === 'render_sprite_trail';
			const rate = num(r, 'animation rate', 0.1);
			const fit = num(r, 'animation_fit_lifetime', 0);
			const flat = num(r, 'orientation_type', 0) === 2;
			for (const p of inst.particles) {
				if (p.alpha <= 0.002 || p.radius <= 0) continue;
				const age = inst.time - p.born;
				const uv = frameUv(sprite.sheet, p.seq, fit ? age / Math.max(p.life, 1e-3) : age * rate, !!fit);
				let ax: THREE.Vector3, ay: THREE.Vector3, center = p.pos;
				if (trail) {
					// stretched back along the velocity, as wide as the radius
					const speed = p.vel.length();
					const len = Math.min(num(r, 'max length', 2000), Math.max(num(r, 'min length', 0), speed * p.trail));
					if (speed < 1e-3) continue;
					const dir = p.vel.clone().divideScalar(speed);
					center = p.pos.clone().addScaledVector(dir, -len / 2);
					const toCam = camPos.clone().sub(center).normalize();
					ax = dir.clone().cross(toCam).normalize().multiplyScalar(p.radius);
					ay = dir.multiplyScalar(len / 2);
				} else if (flat) {
					const c = Math.cos(p.rot * Math.PI / 180), s = Math.sin(p.rot * Math.PI / 180);
					ax = new THREE.Vector3(c, s, 0).multiplyScalar(p.radius);
					ay = new THREE.Vector3(-s, c, 0).multiplyScalar(p.radius);
				} else {
					const c = Math.cos(p.rot * Math.PI / 180), s = Math.sin(p.rot * Math.PI / 180);
					ax = right.clone().multiplyScalar(c).addScaledVector(up, s).multiplyScalar(p.radius);
					ay = up.clone().multiplyScalar(c).addScaledVector(right, -s).multiplyScalar(p.radius);
				}
				const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
				const uvs = [[uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]], [uv[0], uv[1]]];
				for (const k of [0, 1, 2, 0, 2, 3]) {
					const [cx, cy] = corners[k];
					b.pos.push(center.x + ax.x * cx + ay.x * cy, center.y + ax.y * cx + ay.y * cy, center.z + ax.z * cx + ay.z * cy);
					b.uv.push(uvs[k][0], uvs[k][1]);
					b.col.push(p.color[0], p.color[1], p.color[2], p.alpha);
				}
			}
		}
		for (const [name, mesh] of this.meshes) if (!batches.has(name)) mesh.visible = false;
		for (const [name, b] of batches) {
			let mesh = this.meshes.get(name);
			const sprite = this.loaded.get(name);
			if (!sprite) continue;
			if (!mesh) {
				mesh = new THREE.Mesh(new THREE.BufferGeometry(), sprite.material);
				mesh.frustumCulled = false;
				mesh.renderOrder = 3;
				this.meshes.set(name, mesh);
				this.group.add(mesh);
			}
			const g = mesh.geometry;
			g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
			g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
			g.setAttribute('pcolor', new THREE.Float32BufferAttribute(b.col, 4));
			mesh.visible = b.pos.length > 0;
		}
	}

	clear() {
		for (const m of this.meshes.values()) m.geometry.dispose();
		this.meshes.clear();
		this.group.clear();
	}
}

// the texture rectangle for a sheet sequence at a point in its cycle
// (`cycles`: how many times through the sequence; with `fit`, 0..1 over
// the particle's life)
function frameUv(sheet: SheetSequence[] | null, seq: number, cycles: number, fit: boolean): [number, number, number, number] {
	const s = sheet?.[seq] ?? sheet?.[0];
	if (!s || !s.frames.length) return [0, 0, 1, 1];
	let c = fit ? Math.min(0.999, cycles) : cycles;
	c = s.clamp ? Math.min(0.999, c) : c - Math.floor(c);
	const total = s.frames.reduce((n, f) => n + f.duration, 0) || 1;
	let at = c * total;
	for (const f of s.frames) {
		if (at < f.duration) return f.uv;
		at -= f.duration;
	}
	return s.frames[s.frames.length - 1].uv;
}
