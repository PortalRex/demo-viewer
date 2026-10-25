// Particle systems, as the game runs them: the definitions from the .pcf
// files (the global manifest, then the map's own), simulated on the CPU
// with the emitters, initializers and operators Portal 2's effects mostly
// use, and drawn as camera-facing sprites (animated through their
// texture's sheet), velocity-stretched trails or ropes.
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
// "operator end cap state": 0 = only while the effect runs, 1 = only once
// it's been stopped (closing animations), -1 = always
const endCapOk = (o: ParticleOperator, ending: boolean) => {
	const s = num(o, 'operator end cap state', -1);
	return s < 0 || (s === 1) === ending;
};

// whether an effect (or one of its children) keeps emitting until stopped
export function isEndless(def: ParticleSystemDef, lib: ParticleLibrary, depth = 0): boolean {
	if (def.emitters.some(e => e.fn !== 'emit_instantaneously' && num(e, 'emission_duration', 0) <= 0)) return true;
	// effects that restart themselves run until stopped
	if (def.operators.some(o => o.fn === 'restart effect after duration')) return true;
	// particles that never age (no lifespan operator) stay until stopped too
	if (def.emitters.length && !def.operators.some(o => o.fn === 'lifespan decay' || o.fn === 'alpha fade and decay')) return true;
	return depth < 4 && def.children.some(c => {
		const d = lib.get(c.name);
		return !!d && isEndless(d, lib, depth + 1);
	});
}

// ---- particles ----

// particle fields as the operators address them
const F = {LIFE: 1, RADIUS: 3, ROTATION: 4, COLOR: 6, ALPHA: 7, SEQUENCE: 9, ALPHA2: 16} as const;

interface Particle {
	index: number;     // spawn order
	pos: THREE.Vector3;
	vel: THREE.Vector3;
	born: number;      // instance time
	life: number;
	radius: number;    // field 3 (before scale operators)
	drawRadius: number;
	rot: number;       // degrees
	rotSpeed: number;
	color: number[];   // field 6, 0..1
	baseColor: number[];
	alpha: number;     // field 7 (before fades)
	alpha2: number;    // field 16 (a second multiplier)
	drawAlpha: number;
	seq: number;
	trail: number;
	fadeIn: number;    // per-particle random fade times (seconds or proportions)
	fadeOut: number;
	osc: number[];     // per-particle oscillation rates/frequencies
	pathT?: number;    // where along a control point path it was placed (0..1)
	pathAt?: THREE.Vector3;  // that point of the path when last moved with it
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

const getField = (p: Particle, f: number): number => {
	switch (f) {
	case F.LIFE: return p.life;
	case F.RADIUS: return p.radius;
	case F.ROTATION: return p.rot;
	case F.ALPHA: return p.alpha;
	case F.ALPHA2: return p.alpha2;
	case F.SEQUENCE: return p.seq;
	default: return 0;
	}
};
const setField = (p: Particle, f: number, v: number) => {
	switch (f) {
	case F.LIFE: p.life = v; break;
	case F.RADIUS: p.radius = v; break;
	case F.ROTATION: p.rot = v; break;
	case F.ALPHA: p.alpha = v; break;
	case F.ALPHA2: p.alpha2 = v; break;
	case F.SEQUENCE: p.seq = Math.floor(v); break;
	}
};

// Control points: the effect's frames of reference. 0 is where it's
// attached; others are set by the game (colour on 7 for portals, 2 for
// blasts, passed in their positions) or by the effect itself.
export type ControlPoints = Map<number, THREE.Matrix4>;

export class ParticleInstance {
	readonly def: ParticleSystemDef;
	time = 0;
	particles: Particle[] = [];
	emitting = true;
	cps: ControlPoints;
	// moves control point 0 over time (a blast in flight); called each step
	cpAt: ((t: number) => THREE.Matrix4) | null = null;
	private rand: () => number;
	private emitted = new Map<ParticleOperator, number>();
	private children: {inst: ParticleInstance; delay: number}[] = [];
	private spawned = 0;
	// initializers that read a particle's position run after those that set it
	private initOrder: ParticleOperator[];
	// "restart effect after duration": when the emitters next fire again,
	// and the time their start times count from
	private restartAt = -1;
	private emitBase = 0;

	constructor(def: ParticleSystemDef, lib: ParticleLibrary, cps: ControlPoints, seed: number, depth = 0) {
		this.def = def;
		this.cps = cps;
		this.rand = mulberry(seed);
		const late = (o: ParticleOperator) => o.fn.startsWith('position modify') || o.fn === 'remap initial distance to control point to scalar';
		this.initOrder = [...def.initializers.filter(o => !late(o)), ...def.initializers.filter(late)];
		if (depth < 4) {
			def.children.forEach((c, i) => {
				const d = lib.get(c.name);
				if (d) this.children.push({inst: new ParticleInstance(d, lib, cps, seed * 31 + i + 1, depth + 1), delay: c.delay});
			});
		}
		this.placeControlPoints(0);
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

	// nothing left to show or emit: no particles, and every emitter done
	// (one-shot bursts fired, timed streams over)
	get finished(): boolean {
		if (this.particles.length) return false;
		if (this.emitting) {
			for (const e of this.def.emitters) {
				const start = num(e, 'emission_start_time', 0);
				if (e.fn === 'emit_instantaneously' && !this.emitted.has(e)) return false;
				if (e.fn !== 'emit_instantaneously' && (num(e, 'emission_duration', 0) <= 0 || this.time < start + num(e, 'emission_duration', 0))) return false;
			}
		}
		return this.children.every(c => this.time < c.delay ? false : c.inst.finished);
	}

	// starts the simulation at `t` (for effects that have been running a
	// long while: what was emitted before then is gone anyway)
	skipTo(t: number) {
		this.time = t;
		for (const e of this.def.emitters) if (e.fn === 'emit_instantaneously' && num(e, 'emission_start_time', 0) < t) this.emitted.set(e, 0);
	}

	// a scale on every particle's drawn size, for its children too (the
	// client scales some effects drawn with the view model)
	sizeScale = 1;
	setSizeScale(k: number) {
		this.sizeScale = k;
		for (const c of this.children) c.inst.setSizeScale(k);
	}

	// new control points (ends that move: a beam to a held object), for its
	// children too
	setControlPoints(cps: ControlPoints) {
		this.cps = cps;
		for (const c of this.children) c.inst.setControlPoints(cps);
	}

	stopEmitting() {
		this.emitting = false;
		for (const c of this.children) c.inst.stopEmitting();
	}

	setCpAt(fn: (t: number) => THREE.Matrix4) {
		this.cpAt = fn;
		for (const c of this.children) c.inst.setCpAt(t => fn(t + c.delay));
	}

	// runs the effect up to `t` seconds
	advance(t: number) {
		while (this.time + 1e-6 < t) this.step(Math.min(STEP, t - this.time));
	}

	private cp(n: number): THREE.Matrix4 {
		return this.cps.get(n) ?? this.cps.get(0) ?? new THREE.Matrix4();
	}

	cpPos(n: number): THREE.Vector3 {
		return new THREE.Vector3().setFromMatrixPosition(this.cp(n));
	}

	private r(lo: number, hi: number, exp = 1) {
		return lo + (hi - lo) * Math.pow(this.rand(), exp);
	}

	// "set control point positions": up to four points placed relative to another
	private placeControlPoints(dt: number) {
		for (const o of this.def.operators) {
			if (o.fn === 'set control point positions') {
				const world = num(o, 'Set positions in world space', 0);
				const from = this.cp(num(o, 'Control Point to offset positions from', 0));
				const names = ['First', 'Second', 'Third', 'Fourth'];
				const defaults = [[128, 0, 0], [0, 128, 0], [-128, 0, 0], [0, -128, 0]];
				names.forEach((n, i) => {
					const idx = num(o, `${n} Control Point Number`, i + 1);
					if (idx === 0) return;
					const loc = vec(o, `${n} Control Point Location`, defaults[i]);
					const m = world ? new THREE.Matrix4().makeTranslation(loc[0], loc[1], loc[2]) : from.clone().multiply(new THREE.Matrix4().makeTranslation(loc[0], loc[1], loc[2]));
					this.cps = new Map(this.cps);
					this.cps.set(idx, m);
				});
			} else if (o.fn === 'set control point rotation' && dt > 0) {
				const idx = num(o, 'Control Point', 0);
				if (idx === 0) continue;
				const axis = vec(o, 'Rotation Axis', [0, 0, 1]);
				const rot = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(axis[0], axis[1], axis[2]).normalize(), num(o, 'Rotation Rate', 180) * Math.PI / 180 * dt);
				this.cps = new Map(this.cps);
				this.cps.set(idx, this.cp(idx).clone().multiply(rot));
			}
		}
	}

	private step(dt: number) {
		const t0 = this.time;
		this.time += dt;
		const t = this.time;
		if (this.cpAt) {
			this.cps = new Map(this.cps);
			this.cps.set(0, this.cpAt(t));
		}
		this.placeControlPoints(dt);
		const restart = this.def.operators.find(o => o.fn === 'restart effect after duration');
		if (restart && this.emitting) {
			const next = () => this.r(num(restart, 'Minimum Restart Time', 0), num(restart, 'Maximum Restart Time', 1));
			if (this.restartAt < 0) this.restartAt = next();
			if (t >= this.restartAt) {
				this.emitted.clear();
				this.emitBase = this.restartAt;
				this.restartAt += Math.max(0.05, next());
			}
		}
		if (this.emitting) {
			for (const e of this.def.emitters) {
				const start = num(e, 'emission_start_time', 0) + this.emitBase;
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
		// particles die of old age only while a lifespan operator runs (the
		// portal edges' only does once the portal closes); -2 = killed
		const decay = this.def.operators.find(o => o.fn === 'lifespan decay');
		const ages = !!decay && endCapOk(decay, !this.emitting);
		for (const p of this.particles) this.operate(p, dt);
		// "remap difference of sequential particle vector to scalar": by how
		// far each particle is from the one spawned before it (a rope hides
		// the jump between one burst's end and the next's start)
		const seq = this.def.operators.find(o => o.fn === 'remap difference of sequential particle vector to scalar');
		if (seq && this.particles.length > 1) {
			const ps = [...this.particles].sort((a, b) => a.index - b.index);
			const d0 = num(seq, 'difference minimum', 0), d1 = num(seq, 'difference maximum', 128);
			const o0 = num(seq, 'output minimum', 0), o1 = num(seq, 'output maximum', 1);
			const prev = !!num(seq, 'also set ouput to previous particle', 0);
			const field = num(seq, 'output field', 3);
			if (field === F.ALPHA || field === F.ALPHA2) {
				for (let i = 1; i < ps.length; i++) {
					const k = Math.min(1, Math.max(0, (ps[i].pos.distanceTo(ps[i - 1].pos) - d0) / ((d1 - d0) || 1)));
					const v = Math.max(0, o0 + (o1 - o0) * k);
					ps[i].drawAlpha *= v;
					if (prev) ps[i - 1].drawAlpha *= v;
				}
			}
		}
		this.particles = this.particles.filter(p => p.life !== -2 && !(ages && this.time - p.born >= p.life));
		for (const c of this.children) if (t > c.delay) c.inst.advance(t - c.delay);
	}

	private spawn() {
		const def = this.def;
		const index = this.spawned++;
		const cp0 = this.cp(0);
		const local = (v: number[], m = cp0) => new THREE.Vector3(v[0], v[1], v[2]).transformDirection(m).multiplyScalar(Math.hypot(v[0], v[1], v[2]));
		const c = def.color.map(x => x / 255);
		const p: Particle = {
			index, pos: this.cpPos(0), vel: new THREE.Vector3(), born: this.time, life: 1,
			radius: def.radius, drawRadius: def.radius, rot: def.rotation, rotSpeed: 0,
			color: c.slice(0, 3), baseColor: c.slice(0, 3), alpha: c[3], alpha2: 1, drawAlpha: c[3],
			seq: def.sequence, trail: 0.1, fadeIn: 0.25, fadeOut: 0.25, osc: [],
		};
		const randomDir = () => {
			const z = this.r(-1, 1), a = this.r(0, Math.PI * 2), s = Math.sqrt(1 - z * z);
			return new THREE.Vector3(s * Math.cos(a), s * Math.sin(a), z);
		};
		const scalarOut = (o: ParticleOperator, field: number, value: number, scale: boolean) => {
			setField(p, field, scale ? getField(p, field) * value : value);
			if (field === F.COLOR) p.color = p.color.map(x => x * value);
		};
		for (const o of this.initOrder) {
			switch (o.fn) {
			case 'lifetime random':
				p.life = this.r(num(o, 'lifetime_min', 0), num(o, 'lifetime_max', 0), num(o, 'lifetime_random_exponent', 1));
				break;
			case 'position within sphere random': {
				const m = this.cp(num(o, 'control_point_number', 0));
				p.pos = new THREE.Vector3().setFromMatrixPosition(m);
				const dir = randomDir();
				const bias = vec(o, 'distance_bias', [1, 1, 1]);
				const d = this.r(num(o, 'distance_min', 0), num(o, 'distance_max', 0));
				const off = new THREE.Vector3(dir.x * bias[0], dir.y * bias[1], dir.z * bias[2]).multiplyScalar(d);
				p.pos.add(num(o, 'bias in local system', 0) ? local(off.toArray(), m) : off);
				p.vel.addScaledVector(dir, this.r(num(o, 'speed_min', 0), num(o, 'speed_max', 0), num(o, 'speed_random_exponent', 1)));
				const lo = vec(o, 'speed_in_local_coordinate_system_min', [0, 0, 0]), hi = vec(o, 'speed_in_local_coordinate_system_max', [0, 0, 0]);
				p.vel.add(local([this.r(lo[0], hi[0]), this.r(lo[1], hi[1]), this.r(lo[2], hi[2])], m));
				break;
			}
			case 'position within box random': {
				const lo = vec(o, 'min', [0, 0, 0]), hi = vec(o, 'max', [0, 0, 0]);
				const off = [this.r(lo[0], hi[0]), this.r(lo[1], hi[1]), this.r(lo[2], hi[2])];
				p.pos.add(num(o, 'use local space', 0) ? local(off) : new THREE.Vector3(off[0], off[1], off[2]));
				break;
			}
			case 'position along ring': {
				// evenly or randomly around a circle in the point's XY plane,
				// turned by pitch/yaw/roll
				const m = this.cp(num(o, 'control point number', 0));
				const count = num(o, 'even distribution', 0) && num(o, 'even distribution count', -1) !== -1 ? num(o, 'even distribution count', -1) : 16;
				const theta = num(o, 'even distribution', 0) ? (2 * Math.PI / count) * (index + 1) : this.r(0, 2 * Math.PI);
				const radius = num(o, 'initial radius', 0);
				const pt = new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, 0);
				pt.applyEuler(new THREE.Euler(num(o, 'roll', 0) * Math.PI / 180, num(o, 'pitch', 0) * Math.PI / 180, num(o, 'yaw', 0) * Math.PI / 180, 'ZYX'));
				pt.add(randomDir().multiplyScalar(num(o, 'thickness', 0) * this.rand()));
				p.pos = pt.applyMatrix4(m);
				const speed = this.r(num(o, 'min initial speed', 0), num(o, 'max initial speed', 0));
				if (speed) p.vel.addScaledVector(p.pos.clone().sub(new THREE.Vector3().setFromMatrixPosition(m)).normalize(), speed);
				break;
			}
			case 'position modify warp random': {
				// stretches the particle's offset from the point, per local axis
				const m = this.cp(num(o, 'control point number', 0));
				const lo = vec(o, 'warp min', [1, 1, 1]), hi = vec(o, 'warp max', [1, 1, 1]), k = this.rand();
				const inv = m.clone().invert();
				const l = p.pos.clone().applyMatrix4(inv);
				l.set(l.x * (lo[0] + (hi[0] - lo[0]) * k), l.y * (lo[1] + (hi[1] - lo[1]) * k), l.z * (lo[2] + (hi[2] - lo[2]) * k));
				p.pos = l.applyMatrix4(m);
				break;
			}
			case 'position modify offset random': {
				const lo = vec(o, 'offset min', [0, 0, 0]), hi = vec(o, 'offset max', [0, 0, 0]);
				const off = [this.r(lo[0], hi[0]), this.r(lo[1], hi[1]), this.r(lo[2], hi[2])];
				p.pos.add(num(o, 'offset in local space 0/1', 0) ? local(off, this.cp(num(o, 'control_point_number', 0))) : new THREE.Vector3(off[0], off[1], off[2]));
				break;
			}
			case 'position along path sequential': {
				const a = this.cpPos(num(o, 'start control point number', 0)), b = this.cpPos(num(o, 'end control point number', 0));
				const n = Math.max(1, num(o, 'particles to map from start to end', 100));
				const k = n > 1 ? (index % n) / (n - 1) : 0;
				p.pos = a.lerp(b, k);
				p.pathT = k;  // (kept for "movement lock to saved position along path")
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
				p.radius = this.r(num(o, 'radius_min', 1), num(o, 'radius_max', 1), num(o, 'radius_random_exponent', 1));
				break;
			case 'color random': {
				const a = vec(o, 'color1', [255, 255, 255, 255]), b = vec(o, 'color2', [255, 255, 255, 255]), k = this.rand();
				p.color = [0, 1, 2].map(i => (a[i] + (b[i] - a[i]) * k) / 255);
				break;
			}
			case 'alpha random':
				p.alpha = this.r(num(o, 'alpha_min', 255), num(o, 'alpha_max', 255), num(o, 'alpha_random_exponent', 1)) / 255;
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
				scalarOut(o, num(o, 'output field', 3), num(o, 'output minimum', 0) + (num(o, 'output maximum', 1) - num(o, 'output minimum', 0)) * k, !!num(o, 'output is scalar of initial random range', 0));
				break;
			}
			case 'remap particle count to scalar': {
				const i0 = num(o, 'input minimum', 0), i1 = num(o, 'input maximum', 10);
				if (num(o, 'only active within specified input range', 0) && (index < i0 || index > i1)) break;
				const k = Math.min(1, Math.max(0, (index - i0) / ((i1 - i0) || 1)));
				scalarOut(o, num(o, 'output field', 3), num(o, 'output minimum', 0) + (num(o, 'output maximum', 1) - num(o, 'output minimum', 0)) * k, !!num(o, 'output is scalar of initial random range', 0));
				break;
			}
			case 'remap noise to scalar':
				// smooth noise in the game; a random pick from the same range here
				scalarOut(o, num(o, 'output field', 3), this.r(num(o, 'output minimum', 0), num(o, 'output maximum', 1)), false);
				break;
			case 'remap initial distance to control point to scalar': {
				const d = p.pos.distanceTo(this.cpPos(num(o, 'control point', 0)));
				const d0 = num(o, 'distance minimum', 0), d1 = num(o, 'distance maximum', 128);
				if (num(o, 'only active within specified distance', 0) && (d < d0 || d > d1)) break;
				const k = Math.min(1, Math.max(0, (d - d0) / ((d1 - d0) || 1)));
				scalarOut(o, num(o, 'output field', 3), num(o, 'output minimum', 0) + (num(o, 'output maximum', 1) - num(o, 'output minimum', 0)) * k, !!num(o, 'output is scalar of initial random range', 0));
				break;
			}
			case 'remap control point to vector': {
				// a control point's position read as a value: colours for portals and blasts
				if (num(o, 'output field', 0) !== F.COLOR) break;
				const v = this.cpPos(num(o, 'input control point number', 0));
				const i0 = vec(o, 'input minimum', [0, 0, 0]), i1 = vec(o, 'input maximum', [0, 0, 0]);
				const o0 = vec(o, 'output minimum', [0, 0, 0]), o1 = vec(o, 'output maximum', [0, 0, 0]);
				const comp = [v.x, v.y, v.z].map((x, i) => {
					const k = Math.min(1, Math.max(0, (x - i0[i]) / ((i1[i] - i0[i]) || 1)));
					return o0[i] + (o1[i] - o0[i]) * k;
				});
				p.color = num(o, 'output is scalar of initial random range', 0) ? p.color.map((x, i) => x * comp[i]) : comp;
				break;
			}
			}
		}
		p.baseColor = p.color.slice();
		for (const o of def.operators) {
			if (o.fn === 'alpha fade in random') {
				p.fadeIn = this.r(num(o, 'fade in time min', 0.25), num(o, 'fade in time max', 0.25), num(o, 'fade in time exponent', 1));
			} else if (o.fn === 'alpha fade out random') {
				p.fadeOut = this.r(num(o, 'fade out time min', 0.25), num(o, 'fade out time max', 0.25), num(o, 'fade out time exponent', 1));
			} else if (o.fn === 'oscillate scalar') {
				p.osc.push(this.r(num(o, 'oscillation rate min', 0), num(o, 'oscillation rate max', 0)), this.r(num(o, 'oscillation frequency min', 1), num(o, 'oscillation frequency max', 1)));
			}
		}
		this.particles.push(p);
	}

	private operate(p: Particle, dt: number) {
		const ending = !this.emitting;
		const age = this.time - p.born;
		const frac = p.life > 0 ? Math.min(1, age / p.life) : 1;
		let alpha = 1, radiusScale = 1, osc = 0;
		let moves = false;
		for (const o of this.def.operators) {
			if (!endCapOk(o, ending)) continue;
			switch (o.fn) {
			case 'movement basic': {
				moves = true;
				const g = vec(o, 'gravity', [0, 0, 0]);
				p.vel.x += g[0] * dt;
				p.vel.y += g[1] * dt;
				p.vel.z += g[2] * dt;
				const drag = num(o, 'drag', 0);
				if (drag > 0) p.vel.multiplyScalar(Math.pow(Math.max(0, 1 - drag), dt * 30));
				break;
			}
			case 'movement lock to saved position along path': {
				// carried along as the path's ends move (a beam between two
				// moving points)
				if (p.pathT === undefined) break;
				const at = this.cpPos(num(o, 'start control point number', 0)).lerp(this.cpPos(num(o, 'end control point number', 1)), p.pathT);
				if (p.pathAt) p.pos.add(at.clone().sub(p.pathAt));
				p.pathAt = at;
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
				if (frac >= o1) p.life = -2;  // and kills at the end
				break;
			}
			case 'radius scale': {
				const s0 = num(o, 'start_time', 0), s1 = num(o, 'end_time', 1);
				if (frac < s0 && s0 > 0) {
					radiusScale *= num(o, 'radius_start_scale', 1);
					break;
				}
				let k = Math.min(1, Math.max(0, (frac - s0) / ((s1 - s0) || 1)));
				const b = num(o, 'scale_bias', 0.5);
				if (b !== 0.5) k = Math.pow(k, Math.log(b) / Math.log(0.5));
				radiusScale *= num(o, 'radius_start_scale', 1) + (num(o, 'radius_end_scale', 1) - num(o, 'radius_start_scale', 1)) * k;
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
			case 'oscillate scalar': {
				// the field swings around its value, at a per-particle rate and frequency
				const rate = p.osc[osc * 2] ?? 0, freq = p.osc[osc * 2 + 1] ?? 1;
				osc++;
				const field = num(o, 'oscillation field', 7);
				const tt = num(o, 'proportional 0/1', 1) ? frac : age;
				const s = Math.cos(2 * Math.PI * freq * tt + num(o, 'oscillation start phase', 0.5) * Math.PI);
				setField(p, field, getField(p, field) + rate * s * dt * num(o, 'oscillation multiplier', 2) * 0.5);
				break;
			}
			case 'ramp scalar linear simple': {
				const s0 = num(o, 'start time', 0), s1 = num(o, 'end time', 1);
				if (age >= s0 && age <= s1) {
					const field = num(o, 'ramp field', 3);
					setField(p, field, getField(p, field) + num(o, 'ramp rate', 0) * dt);
				}
				break;
			}
			case 'clamp scalar': {
				const field = num(o, 'output field', 3);
				setField(p, field, Math.min(num(o, 'output maximum', 1), Math.max(num(o, 'output minimum', 0), getField(p, field))));
				break;
			}
			case 'remap distance to control point to scalar': {
				const d = p.pos.distanceTo(this.cpPos(num(o, 'control point', 0)));
				const d0 = num(o, 'distance minimum', 0), d1 = num(o, 'distance maximum', 128);
				const k = Math.min(1, Math.max(0, (d - d0) / ((d1 - d0) || 1)));
				const v = num(o, 'output minimum', 0) + (num(o, 'output maximum', 1) - num(o, 'output minimum', 0)) * k;
				const field = num(o, 'output field', 3);
				if (field === F.ALPHA2) p.alpha2 = v;
				else if (field === F.RADIUS) radiusScale *= v / Math.max(1e-3, p.radius);
				else if (field === F.ALPHA) alpha *= v / Math.max(1e-3, p.alpha);
				break;
			}
			case 'remap control point to vector': {
				if (num(o, 'output field', 0) !== F.COLOR) break;
				const v = this.cpPos(num(o, 'input control point number', 0));
				const i0 = vec(o, 'input minimum', [0, 0, 0]), i1 = vec(o, 'input maximum', [0, 0, 0]);
				const o0 = vec(o, 'output minimum', [0, 0, 0]), o1 = vec(o, 'output maximum', [0, 0, 0]);
				p.color = [v.x, v.y, v.z].map((x, i) => o0[i] + (o1[i] - o0[i]) * Math.min(1, Math.max(0, (x - i0[i]) / ((i1[i] - i0[i]) || 1))));
				break;
			}
			case 'rotation spin roll':
				p.rot += num(o, 'spin_rate_degrees', 0) * dt;
				break;
			case 'rotation basic':
				p.rot += p.rotSpeed * dt;
				break;
			case 'lifespan minimum velocity decay':
				if (age > STEP && p.vel.length() < num(o, 'minimum velocity', 1)) p.life = -2;
				break;
			case 'lifespan minimum radius decay':
				if (p.radius * radiusScale < num(o, 'minimum radius', 1)) p.life = -2;
				break;
			}
		}
		p.drawAlpha = Math.max(0, p.alpha) * alpha * Math.max(0, p.alpha2);
		p.drawRadius = Math.max(0, p.radius * radiusScale) * this.sizeScale;
		if (moves) p.pos.addScaledVector(p.vel, dt);
	}
}

// ---- drawing ----

interface SpriteMaterial {
	material: THREE.ShaderMaterial;
	sheet: SheetSequence[] | null;
	orientation: number;  // SpriteCard $orientation (3: along the particles' normals)
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

	// whether a material draws over everything ($ignorez), once it's loaded
	ignoresDepth(name: string): boolean {
		return this.loaded.get(name)?.material.depthTest === false;
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
		t.wrapS = THREE.RepeatWrapping;  // ropes repeat along their length
		t.wrapT = THREE.ClampToEdgeWrapping;
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
		return {material, sheet: bytes ? readVtfSheet(bytes) : null, orientation: Number(m.params.get('$orientation') ?? 0) || 0};
	}

	// rebuilds the quads of every live particle
	draw(instances: ParticleInstance[], camera: THREE.Camera) {
		const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
		const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
		const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
		const batches = new Map<string, {pos: number[]; uv: number[]; col: number[]}>();
		const quad = (b: {pos: number[]; uv: number[]; col: number[]}, c: THREE.Vector3[], uv: number[][], col: number[][]) => {
			for (const k of [0, 1, 2, 0, 2, 3]) {
				b.pos.push(c[k].x, c[k].y, c[k].z);
				b.uv.push(uv[k][0], uv[k][1]);
				b.col.push(...col[k]);
			}
		};
		for (const inst of instances) {
			const def = inst.def;
			if (!def.material || !inst.particles.length) continue;
			const sprite = this.sprite(def.material);
			if (!sprite) continue;
			const r = def.renderers.find(o => o.fn === 'render_animated_sprites' || o.fn === 'render_sprite_trail' || o.fn === 'render_rope');
			if (!r) continue;
			let b = batches.get(def.material);
			if (!b) batches.set(def.material, b = {pos: [], uv: [], col: []});
			if (r.fn === 'render_rope') {
				this.rope(b, inst, r, camPos, quad, sprite.orientation);
				continue;
			}
			const trail = r.fn === 'render_sprite_trail';
			const rate = num(r, 'animation rate', 0.1);
			const fit = num(r, 'animation_fit_lifetime', 0);
			const flat = num(r, 'orientation_type', 0) === 2;
			for (const p of inst.particles) {
				if (p.drawAlpha <= 0.002 || p.drawRadius <= 0) continue;
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
					ax = dir.clone().cross(toCam).normalize().multiplyScalar(p.drawRadius);
					ay = dir.multiplyScalar(len / 2);
				} else if (flat) {
					const c = Math.cos(p.rot * Math.PI / 180), s = Math.sin(p.rot * Math.PI / 180);
					ax = new THREE.Vector3(c, s, 0).multiplyScalar(p.drawRadius);
					ay = new THREE.Vector3(-s, c, 0).multiplyScalar(p.drawRadius);
				} else {
					const c = Math.cos(p.rot * Math.PI / 180), s = Math.sin(p.rot * Math.PI / 180);
					ax = right.clone().multiplyScalar(c).addScaledVector(up, s).multiplyScalar(p.drawRadius);
					ay = up.clone().multiplyScalar(c).addScaledVector(right, -s).multiplyScalar(p.drawRadius);
				}
				const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([cx, cy]) => center.clone().addScaledVector(ax, cx).addScaledVector(ay, cy));
				const col = [p.color[0], p.color[1], p.color[2], p.drawAlpha];
				quad(b, corners, [[uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]], [uv[0], uv[1]]], [col, col, col, col]);
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

	// A rope through the particles in spawn order, smoothed (Catmull-Rom),
	// facing the camera (or, for $orientation 3 materials, widened across
	// the particles' normals: those that "remap direction to cp to vector"
	// points at a control point, so the rope stands edge-on to it), as wide
	// as each particle's radius; the texture runs along it by distance and
	// scrolls
	private rope(b: {pos: number[]; uv: number[]; col: number[]}, inst: ParticleInstance, r: ParticleOperator, camPos: THREE.Vector3,
		quad: (b: {pos: number[]; uv: number[]; col: number[]}, c: THREE.Vector3[], uv: number[][], col: number[][]) => void, orientation = 0) {
		const aim = orientation === 3 ? inst.def.operators.find(o => o.fn === 'remap direction to cp to vector') : undefined;
		const aimAt = aim ? inst.cpPos(num(aim, 'control point', 0)) : null;
		const ps = [...inst.particles].sort((x, y) => x.index - y.index);
		if (ps.length < 2) return;
		const sub = Math.max(1, Math.floor(num(r, 'subdivision_count', 3)));
		const texel = num(r, 'texel_size', 4);
		const scroll = num(r, 'texture_scroll_rate', 0) * inst.time + num(r, 'texture_offset', 0);
		const pts: {p: THREE.Vector3; w: number; c: number[]}[] = [];
		for (let i = 0; i + 1 < ps.length; i++) {
			const p0 = ps[Math.max(0, i - 1)].pos, p1 = ps[i].pos, p2 = ps[i + 1].pos, p3 = ps[Math.min(ps.length - 1, i + 2)].pos;
			for (let s = 0; s < sub; s++) {
				const t = s / sub, t2 = t * t, t3 = t2 * t;
				const p = new THREE.Vector3(
					0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
					0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
					0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3));
				const a = ps[i], z = ps[i + 1];
				pts.push({p, w: a.drawRadius + (z.drawRadius - a.drawRadius) * t, c: [0, 1, 2].map(k => a.color[k] + (z.color[k] - a.color[k]) * t).concat(a.drawAlpha + (z.drawAlpha - a.drawAlpha) * t)});
			}
		}
		const last = ps[ps.length - 1];
		pts.push({p: last.pos.clone(), w: last.drawRadius, c: [...last.color, last.drawAlpha]});
		let dist = 0;
		for (let i = 0; i + 1 < pts.length; i++) {
			const a = pts[i], z = pts[i + 1];
			const dir = z.p.clone().sub(a.p);
			const len = dir.length();
			if (len < 1e-4) continue;
			dir.divideScalar(len);
			const toward = aimAt ?? camPos;
			const sideA = dir.clone().cross(toward.clone().sub(a.p)).normalize();
			const sideZ = dir.clone().cross(toward.clone().sub(z.p)).normalize();
			const u0 = dist * texel + scroll, u1 = (dist + len) * texel + scroll;
			dist += len;
			quad(b,
				[a.p.clone().addScaledVector(sideA, -a.w), a.p.clone().addScaledVector(sideA, a.w), z.p.clone().addScaledVector(sideZ, z.w), z.p.clone().addScaledVector(sideZ, -z.w)],
				[[u0, 1], [u0, 0], [u1, 0], [u1, 1]],
				[a.c, a.c, z.c, z.c]);
		}
	}

	clear() {
		for (const m of this.meshes.values()) m.geometry.dispose();
		this.meshes.clear();
		this.group.clear();
	}

	// clear, and free the sprite materials and their texture copies
	dispose() {
		this.clear();
		for (const s of this.loaded.values()) {
			if (!s) continue;
			(s.material.uniforms.map.value as THREE.Texture | null)?.dispose();
			s.material.dispose();
		}
		this.loaded.clear();
		this.sprites.clear();
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
