// Particle systems, as the game runs them: the definitions from the .pcf
// files (the global manifest, then the map's own), simulated on the CPU
// with the emitters, initializers and operators Portal 2's effects mostly
// use, and drawn as camera-facing sprites (animated through their
// texture's sheet), velocity-stretched trails or ropes.
import * as THREE from 'three';
import {writeAttribute} from './dynamic.ts';
import {readParticleSystems} from '../game/pcf.ts';
import type {ParticleSystemDef, ParticleOperator, DmxValue} from '../game/pcf.ts';
import {readVtfSheet} from '../game/vtf.ts';
import type {SheetSequence} from '../game/vtf.ts';
import type {GameFiles} from '../game/files.ts';
import type {Materials} from '../game/materials.ts';
import type {TextureCache} from './textures.ts';
import {exposureUniforms} from './shaderhooks.ts';

const STEP = 1 / 30;

export class ParticleLibrary {
	private systems = new Map<string, ParticleSystemDef>();
	readonly ready: Promise<void>;
	// the world's light at a point (0..1 per channel, as the engine's
	// GetLightForPoint), for colours tinted by where they're made; white
	// without it
	lightAt: ((point: THREE.Vector3) => [number, number, number]) | null = null;

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

// ---- noise ----

// The particle system's noise (NoiseSIMD): values on a unit lattice, blended
// trilinearly between the eight corners around a point (its position in the
// cell in 1/256 steps), -1..1. Typical values sit well inside that range,
// and nearby points get nearby values. (The lattice is this file's own:
// any random table looks the same.)
const LATTICE = (() => {
	const r: Rng = {a: 0x5eed};
	const perm = () => {
		const a = Array.from({length: 256}, (_, i) => i);
		for (let i = 255; i > 0; i--) {
			const j = Math.floor(nextRandom(r) * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return Uint8Array.from(a);
	};
	return {a: perm(), b: perm(), c: perm(), values: Float32Array.from({length: 256}, () => nextRandom(r))};
})();
function latticeValue(x: number, y: number, z: number): number {
	const {a, b, c, values} = LATTICE;
	return values[c[(z + b[(y + a[x & 255]) & 255]) & 255]];
}
export function noise3(x: number, y: number, z: number): number {
	const cell = (v: number) => {
		const q = Math.floor(v * 256);
		return [q >> 8, (q & 255) / 256];
	};
	const [xi, xf] = cell(x), [yi, yf] = cell(y), [zi, zf] = cell(z);
	const lerp = (u: number, v: number, t: number) => u + (v - u) * t;
	const at = (dx: number, dy: number, dz: number) => latticeValue(xi + dx, yi + dy, zi + dz);
	const x00 = lerp(at(0, 0, 0), at(1, 0, 0), xf), x10 = lerp(at(0, 1, 0), at(1, 1, 0), xf);
	const x01 = lerp(at(0, 0, 1), at(1, 0, 1), xf), x11 = lerp(at(0, 1, 1), at(1, 1, 1), xf);
	return 2 * (lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf) - 0.5);
}
// a noise initializer's value: noise (-1..1) mapped onto min..max, or with
// absolute value (0..1), onto the same
function noiseOutput(noise: number, min: number, max: number, abs: boolean): number {
	return abs ? min + (max - min) * noise : min + (max - min) * 0.5 * (1 + noise);
}
// (the y and z outputs' coordinates moved far off the x's, for separate values)
const NOISE_Y = [100000.5, 300000.25, 9000000.75], NOISE_Z = [110000.25, 310000.75, 9100000.5];

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
	seq2: number;      // field 13: the second sequence ($dualsequence materials)
	trail: number;
	fadeIn: number;    // per-particle random fade times (seconds or proportions)
	fadeOut: number;
	osc: number[];     // per-particle oscillation rates/frequencies
	oscVec?: number[][];  // "oscillate vector": per operator, rates and frequencies per axis, then its start and end
	pathT?: number;    // where along a control point path it was placed (0..1)
	pathAt?: THREE.Vector3;  // that point of the path when last moved with it
	normal?: THREE.Vector3;  // the way its card faces (renderers' orientation_type 3)
	lockedTo?: THREE.Matrix4;  // its locked control point when last moved with it
}

// (its state kept apart, so an instance can be saved and picked up again)
interface Rng {
	a: number;
}
function nextRandom(r: Rng) {
	r.a = (r.a + 0x6d2b79f5) >>> 0;
	let t = r.a;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const copyParticle = (p: Particle): Particle => ({
	...p, pos: p.pos.clone(), vel: p.vel.clone(), color: [...p.color], baseColor: [...p.baseColor], osc: [...p.osc],
	pathAt: p.pathAt?.clone(), normal: p.normal?.clone(), lockedTo: p.lockedTo?.clone(),
});

// everything an instance changes as it runs, for picking it up again later
// (seeking back without simulating from the start)
export interface InstanceState {
	time: number;
	emitting: boolean;
	cps: ControlPoints;
	rng: number;
	lighting: ParticleInstance['lighting'];
	emitted: Map<ParticleOperator, number>;
	pathBulge: THREE.Vector3 | undefined;
	spawned: number;
	epitrochoidCount: Map<ParticleOperator, number>;
	restartCounts: Map<ParticleOperator, number>;
	restartAt: number;
	emitBase: number;
	sizeScale: number;
	particles: Particle[];
	children: InstanceState[];
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
	// the control points the caller keeps setting (live effects): put back
	// before each step, as the game sets them each frame before operators
	// move any; others stay where operators leave them
	private given: ControlPoints | null = null;
	// moves control point 0 over time (a blast in flight); called each step
	cpAt: ((t: number) => THREE.Matrix4) | null = null;
	private rng: Rng;
	private rand: () => number;
	private lib: ParticleLibrary;
	lighting: {cp: number; at: THREE.Vector3; color: [number, number, number]} | null = null;
	private emitted = new Map<ParticleOperator, number>();
	private children: {inst: ParticleInstance; delay: number}[] = [];
	private parent: ParticleInstance | null = null;
	private pathBulge: THREE.Vector3 | undefined;  // a path's random bulge direction
	private spawned = 0;
	private epitrochoidCount = new Map<ParticleOperator, number>();  // the particles each epitrochoid initializer has placed
	// the particles some initializers have made since the effect (re)started
	// (the engine's counts that Restart zeroes: warp, sequential path, count remap)
	private restartCounts = new Map<ParticleOperator, number>();
	// initializers that read a particle's position run after those that set it
	private initOrder: ParticleOperator[];
	// "restart effect after duration": when the emitters next fire again,
	// and the time their start times count from
	private restartAt = -1;
	private emitBase = 0;

	constructor(def: ParticleSystemDef, lib: ParticleLibrary, cps: ControlPoints, seed: number, depth = 0) {
		this.def = def;
		this.cps = cps;
		this.lib = lib;
		const rng: Rng = {a: seed >>> 0};
		this.rng = rng;
		this.rand = () => nextRandom(rng);
		const late = (o: ParticleOperator) => o.fn.startsWith('position modify') || o.fn === 'remap initial distance to control point to scalar';
		this.initOrder = [...def.initializers.filter(o => !late(o)), ...def.initializers.filter(late)];
		if (depth < 4) {
			def.children.forEach((c, i) => {
				const d = lib.get(c.name);
				if (!d) return;
				const child = new ParticleInstance(d, lib, cps, seed * 31 + i + 1, depth + 1);
				child.parent = this;
				this.children.push({inst: child, delay: c.delay});
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
	snapshot(): InstanceState {
		return {
			time: this.time, emitting: this.emitting, cps: new Map([...this.cps].map(([k, m]) => [k, m.clone()])), rng: this.rng.a,
			lighting: this.lighting, emitted: new Map(this.emitted), pathBulge: this.pathBulge?.clone(), spawned: this.spawned, epitrochoidCount: new Map(this.epitrochoidCount), restartCounts: new Map(this.restartCounts),
			restartAt: this.restartAt, emitBase: this.emitBase, sizeScale: this.sizeScale,
			particles: this.particles.map(copyParticle), children: this.children.map(c => c.inst.snapshot()),
		};
	}

	// back to a saved state (the state stays as it was, for using again)
	restore(s: InstanceState) {
		this.time = s.time;
		this.emitting = s.emitting;
		this.cps = new Map([...s.cps].map(([k, m]) => [k, m.clone()]));
		this.rng.a = s.rng;
		this.lighting = s.lighting;
		this.emitted = new Map(s.emitted);
		this.pathBulge = s.pathBulge?.clone();
		this.spawned = s.spawned;
		this.epitrochoidCount = new Map(s.epitrochoidCount);
		this.restartCounts = new Map(s.restartCounts);
		this.restartAt = s.restartAt;
		this.emitBase = s.emitBase;
		this.sizeScale = s.sizeScale;
		this.particles = s.particles.map(copyParticle);
		this.children.forEach((c, i) => s.children[i] && c.inst.restore(s.children[i]));
	}

	skipTo(t: number) {
		// (on the step grid, as advance keeps to it)
		t = Math.floor(t / STEP) * STEP;
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
		this.given = cps;
		this.putBack(cps);
	}

	// the caller's points back over what operators moved, here and in the
	// children (which take them from their parent, not each step themselves)
	private putBack(cps: ControlPoints) {
		this.cps = new Map([...this.cps, ...cps]);
		for (const c of this.children) c.inst.putBack(cps);
	}

	stopEmitting() {
		this.emitting = false;
		for (const c of this.children) c.inst.stopEmitting();
	}

	setCpAt(fn: (t: number) => THREE.Matrix4) {
		this.cpAt = fn;
		for (const c of this.children) c.inst.setCpAt(t => fn(t + c.delay));
	}

	// runs the effect up to `t` seconds, in whole steps from its start (so a
	// moment is the same however it was reached); particles are drawn the
	// rest of the way along their velocity
	ahead = 0;
	advance(t: number) {
		while (this.time + STEP <= t + 1e-6) this.step(STEP);
		this.ahead = Math.max(0, t - this.time);
	}

	private cp(n: number): THREE.Matrix4 {
		return this.cps.get(n) ?? this.cps.get(0) ?? new THREE.Matrix4();
	}

	// the light at a control point (a system's parent's, when it took it at
	// the same point), looked up again once the point moves
	private lightingAt(cp: number): [number, number, number] {
		const parent = this.parent?.lighting;
		if (parent && parent.cp === cp) return parent.color;
		const at = this.cpPos(cp);
		if (!this.lighting || this.lighting.cp !== cp || this.lighting.at.distanceToSquared(at) > 1) {
			this.lighting = {cp, at: at.clone(), color: this.lib.lightAt?.(at) ?? [1, 1, 1]};
		}
		return this.lighting.color;
	}

	cpPos(n: number): THREE.Vector3 {
		return new THREE.Vector3().setFromMatrixPosition(this.cp(n));
	}

	private r(lo: number, hi: number, exp = 1) {
		return lo + (hi - lo) * Math.pow(this.rand(), exp);
	}

	// a control point an operator moves: the engine's SetControlPoint passes
	// it on to the child systems too (portal edges aim their children's
	// ribbons by points the parent places)
	// A point along a path between two control points, as the engine's
	// path parameters shape it: a quadratic curve through a mid point (at
	// "mid point position" along), pushed out by "bulge" x the length along
	// the start's or end's forward axis (less the more the path already runs
	// that way), or a random one
	private pathPoint(o: ParticleOperator, t: number): THREE.Vector3 {
		const si = num(o, 'start control point number', 0), ei = num(o, 'end control point number', 0);
		const a = this.cpPos(si), b = this.cpPos(ei);
		const mid = a.clone().lerp(b, num(o, 'mid point position', 0.5));
		const bulge = num(o, 'bulge', 0);
		if (bulge) {
			const control = num(o, 'bulge control 0=random 1=orientation of start pnt 2=orientation of end point', 0);
			const along = b.clone().sub(a);
			const len = along.length();
			let fwd: THREE.Vector3;
			if (control === 0) {
				if (!this.pathBulge) {
					const z = this.r(-1, 1), ang = this.r(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
					this.pathBulge = new THREE.Vector3(r * Math.cos(ang), r * Math.sin(ang), z);
				}
				fwd = this.pathBulge;
			}
			else fwd = new THREE.Vector3().setFromMatrixColumn(this.cp(control === 2 ? ei : si), 0).normalize();
			const scale = len > 1e-6 ? 1 - Math.abs(along.divideScalar(len).dot(fwd)) : 0;
			mid.addScaledVector(fwd, bulge * len * scale);
		}
		const p0 = a.lerp(mid, t), p1 = mid.lerp(b, t);
		return p0.lerp(p1, t);
	}

	// the emitters fire again from `at` (the engine's Restart, which goes to
	// the child systems too)
	private restartEmitters(at: number) {
		this.emitted.clear();
		this.restartCounts.clear();
		this.emitBase = at;
		for (const c of this.children) c.inst.restartEmitters(at - c.delay);
	}

	private changeCp(n: number, change: (m: THREE.Matrix4) => THREE.Matrix4) {
		this.cps = new Map(this.cps);
		this.cps.set(n, change(this.cp(n)));
		for (const c of this.children) c.inst.changeCp(n, change);
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
					const p = new THREE.Vector3(loc[0], loc[1], loc[2]);
					if (!world) p.applyMatrix4(from);
					// (just the position: the point keeps its turn)
					this.changeCp(idx, m => m.clone().setPosition(p));
				});
			} else if (o.fn === 'set control point rotation' && dt > 0) {
				const idx = num(o, 'Control Point', 0);
				if (idx === 0) continue;
				const axis = vec(o, 'Rotation Axis', [0, 0, 1]);
				const rot = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(axis[0], axis[1], axis[2]).normalize(), num(o, 'Rotation Rate', 180) * Math.PI / 180 * dt);
				this.changeCp(idx, m => m.clone().multiply(rot));
			}
		}
	}

	private step(dt: number) {
		if (this.given) this.putBack(this.given);
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
				this.restartEmitters(this.restartAt);
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
		// "inherit attribute from parent particle": each particle takes the
		// position of its parent system's particle in the same place (every
		// increment-th), so a child rope or sparks follow the parent's strand
		if (this.parent) {
			for (const o of this.def.operators) {
				if (o.fn !== 'inherit attribute from parent particle' || num(o, 'Inherited Field', 0) !== 0) continue;
				const from = [...this.parent.particles].sort((a, b) => a.index - b.index);
				if (!from.length) continue;
				const step = Math.max(1, Math.round(num(o, 'Particle Increment Amount', 1)));
				// (matched against the parent's newest: its last burst)
				const mine = [...this.particles].sort((a, b) => a.index - b.index);
				const base = Math.max(0, from.length - mine.length * step);
				mine.forEach((p, k) => p.pos.copy(from[(base + k * step) % from.length].pos));
			}
		}
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
			seq: def.sequence, seq2: 0, trail: 0.1, fadeIn: 0.25, fadeOut: 0.25, osc: [],
		};
		const randomDir = () => {
			const z = this.r(-1, 1), a = this.r(0, Math.PI * 2), s = Math.sqrt(1 - z * z);
			return new THREE.Vector3(s * Math.cos(a), s * Math.sin(a), z);
		};
		const counted = (o: ParticleOperator) => {
			const n = this.restartCounts.get(o) ?? 0;
			this.restartCounts.set(o, n + 1);
			return n;
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
				// (C_INIT_PositionWarp) stretches the particle's offset from the
				// point, per local axis, and its velocity with it (the engine warps
				// its previous position too): a sphere's burst squashed flat stays
				// flat. With a transition, from min to max over the particles made
				// (or the time) from its start since the effect (re)started: a
				// strand's ends drawn in to its points; else random per axis
				const m = this.cp(num(o, 'control point number', 0));
				let lo = vec(o, 'warp min', [1, 1, 1]), hi = vec(o, 'warp max', [1, 1, 1]);
				if (num(o, 'reverse warp (0/1)', 0)) [lo, hi] = [hi, lo];
				const span = num(o, 'warp transition time (treats min/max as start/end sizes)', 0), from = num(o, 'warp transition start time', 0);
				let s: number[];
				if (span) {
					const at = num(o, 'use particle count instead of time', 0) ? counted(o) : p.born - this.emitBase;
					const k = Math.min(1, Math.max(0, (at - from) / span));
					s = [0, 1, 2].map(i => lo[i] + (hi[i] - lo[i]) * k);
				} else s = [0, 1, 2].map(i => this.r(lo[i], hi[i]));
				const inv = m.clone().invert();
				const l = p.pos.clone().applyMatrix4(inv);
				p.pos = l.set(l.x * s[0], l.y * s[1], l.z * s[2]).applyMatrix4(m);
				const v = p.vel.clone().transformDirection(inv).multiplyScalar(p.vel.length());
				v.set(v.x * s[0], v.y * s[1], v.z * s[2]);
				const speed = v.length();
				p.vel = v.transformDirection(m).multiplyScalar(speed);
				break;
			}
			case 'position modify offset random': {
				const lo = vec(o, 'offset min', [0, 0, 0]), hi = vec(o, 'offset max', [0, 0, 0]);
				const off = [this.r(lo[0], hi[0]), this.r(lo[1], hi[1]), this.r(lo[2], hi[2])];
				p.pos.add(num(o, 'offset in local space 0/1', 0) ? local(off, this.cp(num(o, 'control_point_number', 0))) : new THREE.Vector3(off[0], off[1], off[2]));
				break;
			}
			case 'position along path sequential': {
				const n = Math.max(1, num(o, 'particles to map from start to end', 100));
				const k = n > 1 ? (counted(o) % n) / (n - 1) : 0;
				p.pos = this.pathPoint(o, k);
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
				// (C_INIT_InitialVelocityNoise) at its creation time and where it is
				// then: made before a path initializer places them, a burst's
				// particles all share one velocity
				const lo = vec(o, 'output minimum', [0, 0, 0]), hi = vec(o, 'output maximum', [1, 1, 1]);
				const abs = vec(o, 'Absolute Value', [0, 0, 0]), inv = vec(o, 'Invert Abs Value', [0, 0, 0]);
				const t = (p.born + num(o, 'Time Coordinate Offset', 0)) * num(o, 'Time Noise Coordinate Scale', 1);
				const off = vec(o, 'Spatial Coordinate Offset', [0, 0, 0]), scale = num(o, 'Spatial Noise Coordinate Scale', 0.01);
				const at = [p.pos.x, p.pos.y, p.pos.z].map((v, i) => t + (v + off[i]) * scale);
				const n = [[0, 0, 0], NOISE_Y, NOISE_Z].map((shift, i) => {
					let v = noise3(at[0] + shift[0], at[1] + shift[1], at[2] + shift[2]);
					if (abs[i]) v = inv[i] ? 1 - Math.abs(v) : Math.abs(v);
					return noiseOutput(v, lo[i], hi[i], !!abs[i]);
				});
				p.vel.add(num(o, 'Apply Velocity in Local Space (0/1)', 0) ? local(n, this.cp(num(o, 'Control Point Number', 0))) : new THREE.Vector3(n[0], n[1], n[2]));
				break;
			}
			case 'position along epitrochoid': {
				// (C_INIT_CreateInEpitrochoid) a point on the curve a circle rolling
				// around another traces, by the particle count (or creation time)
				const r1 = num(o, 'radius 1', 40), r2 = num(o, 'radius 2', 24) + 1e-7, offset = num(o, 'point offset', 4);
				const sum = r1 + r2;
				if (!sum) break;
				const useCount = !!num(o, 'use particle count instead of creation time', 0);
				const count = this.epitrochoidCount.get(o) ?? 0;
				if (useCount) this.epitrochoidCount.set(o, count + 1);
				const t = (useCount ? count : p.born) * num(o, 'particle density', 10);
				const v = [0, 0, 0];
				const c1 = num(o, 'first dimension 0-2 (-1 disables)', 0), c2 = num(o, 'second dimension 0-2 (-1 disables)', 1);
				if (c1 >= 0) v[c1] = sum * Math.cos(t) + offset * Math.cos(sum * t / r2);
				if (c2 >= 0) v[c2] = sum * Math.sin(t) + offset * Math.sin(sum * t / r2);
				const m = this.cp(num(o, 'control point number', 0));
				const d = new THREE.Vector3(v[0], v[1], v[2]);
				if (num(o, 'local space', 0)) d.applyMatrix3(new THREE.Matrix3().setFromMatrix4(m));
				if (!num(o, 'offset from existing position', 0)) p.pos.setFromMatrixPosition(m);
				p.pos.add(d);
				break;
			}
			case 'radius random':
				p.radius = this.r(num(o, 'radius_min', 1), num(o, 'radius_max', 1), num(o, 'radius_random_exponent', 1));
				break;
			case 'color random': {
				const a = vec(o, 'color1', [255, 255, 255, 255]), b = vec(o, 'color2', [255, 255, 255, 255]), k = this.rand();
				p.color = [0, 1, 2].map(i => (a[i] + (b[i] - a[i]) * k) / 255);
				// tinted towards the light where it's made (ComputeLitParticleColor):
				// the light clamped to the tint range, amplified, blended in a mode
				const tint = num(o, 'tint_perc', 0);
				if (tint) {
					const light = this.lightingAt(num(o, 'tint control point', 0));
					const lo = vec(o, 'tint clamp min', [0, 0, 0, 0]), hi = vec(o, 'tint clamp max', [255, 255, 255, 255]);
					const amp = num(o, 'light amplification amount', 1) / 255;
					const mode = num(o, 'tint blend mode', 0);
					p.color = p.color.map((c, i) => {
						const l = Math.max(lo[i], Math.min(Math.floor(light[i] * 255), hi[i])) * amp;
						const t = mode === 1 ? (l < 0.5 ? 2 * c * l : 1 - 2 * (1 - c) * (1 - l))  // overlay
							: mode === 2 ? Math.min(c, l) : mode === 3 ? Math.max(c, l) : mode === 4 ? c * l : l;
						return Math.min(1, c + (t - c) * tint);
					});
				}
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
			case 'sequence two random':
				p.seq2 = Math.floor(this.r(num(o, 'sequence_min', 0), num(o, 'sequence_max', 0) + 0.999));
				break;
			case 'velocity set from control point':
				// a control point holding a velocity (a funnel's flow), scaled
				p.vel.copy(this.cpPos(num(o, 'control point number', 1))).multiplyScalar(num(o, 'velocity scale', 1));
				break;
			case 'normal align to cp':
				// facing along its control point's forward axis
				p.normal = new THREE.Vector3().setFromMatrixColumn(this.cp(num(o, 'control_point_number', 0)), 0).normalize();
				break;
			case 'lifetime from sequence': {
				// as long as its sheet sequence's frames take at the rate given
				// (until the sheet has loaded, the default)
				const list = this.def.material ? sheets.get(this.def.material) : undefined;
				const seq = list?.[p.seq] ?? list?.[0];
				if (seq?.frames.length) p.life = seq.frames.length / (num(o, 'Frames Per Second', 30) || 30);
				break;
			}
			case 'lifetime pre-age noise':
				// born already part way through its life (a random pick in the range)
				p.born -= p.life * this.r(num(o, 'start age minimum', 0), num(o, 'start age maximum', 1));
				break;
			case 'rotation yaw flip random':
				// turned half round, some of the time
				if (this.r(0, 1) < num(o, 'Flip Percentage', 0.5)) p.rot += 180;
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
				const i0 = num(o, 'input minimum', 0), i1 = num(o, 'input maximum', 10), count = counted(o);
				if (num(o, 'only active within specified input range', 0) && (count < i0 || count > i1)) break;
				const k = Math.min(1, Math.max(0, (count - i0) / ((i1 - i0) || 1)));
				scalarOut(o, num(o, 'output field', 3), num(o, 'output minimum', 0) + (num(o, 'output maximum', 1) - num(o, 'output minimum', 0)) * k, !!num(o, 'output is scalar of initial random range', 0));
				break;
			}
			case 'remap noise to scalar': {
				// (C_INIT_CreationNoise) at its creation time and where it is
				const t = (p.born + num(o, 'time coordinate offset', 0)) * num(o, 'time noise coordinate scale', 1);
				const off = vec(o, 'spatial coordinate offset', [0, 0, 0]), scale = num(o, 'spatial noise coordinate scale', 0.001);
				let n = noise3(t + (p.pos.x + off[0]) * scale, t + (p.pos.y + off[1]) * scale, t + (p.pos.z + off[2]) * scale);
				const abs = !!num(o, 'absolute value', 0);
				if (abs) n = num(o, 'invert absolute value', 0) ? 1 - Math.abs(n) : Math.abs(n);
				scalarOut(o, num(o, 'output field', 3), noiseOutput(n, num(o, 'output minimum', 0), num(o, 'output maximum', 1), abs), false);
				break;
			}
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
			} else if (o.fn === 'oscillate vector') {
				const r0 = vec(o, 'oscillation rate min', [0, 0, 0]), r1 = vec(o, 'oscillation rate max', [0, 0, 0]);
				const f0 = vec(o, 'oscillation frequency min', [1, 1, 1]), f1 = vec(o, 'oscillation frequency max', [1, 1, 1]);
				(p.oscVec ??= []).push([0, 1, 2].map(i => this.r(r0[i], r1[i])).concat([0, 1, 2].map(i => this.r(f0[i], f1[i]))),
					[this.r(num(o, 'start time min', 0), num(o, 'start time max', 0)), this.r(num(o, 'end time min', 1), num(o, 'end time max', 1))]);
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
		let alpha = 1, radiusScale = 1, osc = 0, oscVec = 0;
		let interpolated: number | null = null;  // the radius scale operators' (see 'radius scale')
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
			case 'normal lock to control point':
				// still facing along it as the control point turns
				p.normal = new THREE.Vector3().setFromMatrixColumn(this.cp(num(o, 'control_point_number', 0)), 0).normalize();
				break;
			case 'movement lock to control point': {
				// carried along as its control point moves (and turns, with
				// lock rotation), fully until the start of the fade-out part of
				// its life, then less to none at its end
				const cur = this.cp(num(o, 'control_point_number', 0));
				const prev = p.lockedTo;
				p.lockedTo = cur.clone();
				if (!prev) break;
				const f0 = (num(o, 'start_fadeout_min', 1) + num(o, 'start_fadeout_max', 1)) / 2;
				const f1 = (num(o, 'end_fadeout_min', 1) + num(o, 'end_fadeout_max', 1)) / 2;
				const strength = frac <= f0 ? 1 : Math.max(0, (f1 - frac) / ((f1 - f0) || 1));
				if (strength <= 0) break;
				if (num(o, 'lock rotation', 0)) {
					const moved = p.pos.clone().applyMatrix4(cur.clone().multiply(prev.clone().invert()));
					p.pos.lerp(moved, strength);
					if (strength >= 1) p.vel.applyMatrix3(new THREE.Matrix3().setFromMatrix4(cur).multiply(new THREE.Matrix3().setFromMatrix4(prev).invert()));
				} else {
					p.pos.add(new THREE.Vector3().setFromMatrixPosition(cur).sub(new THREE.Vector3().setFromMatrixPosition(prev)).multiplyScalar(strength));
				}
				break;
			}
			case 'movement lock to saved position along path': {
				// carried along as the path's ends move (a beam between two
				// moving points)
				if (p.pathT === undefined) break;
				const at = this.pathPoint(o, p.pathT);
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
				// (C_OP_InterpolateRadius: only within its part of the life, and
				// setting the scale: the last one that applies wins)
				const s0 = num(o, 'start_time', 0), s1 = num(o, 'end_time', 1);
				if (frac < s0 || frac > s1) break;
				let k = Math.min(1, Math.max(0, (frac - s0) / ((s1 - s0) || 1)));
				const b = num(o, 'scale_bias', 0.5);
				if (b !== 0.5) k = Math.pow(k, Math.log(b) / Math.log(0.5));
				interpolated = num(o, 'radius_start_scale', 1) + (num(o, 'radius_end_scale', 1) - num(o, 'radius_start_scale', 1)) * k;
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
			case 'oscillate vector': {
				// (C_OP_OscillateVector) the position (or colour) swings, per axis,
				// between a start and end of its life
				const rf = p.oscVec?.[oscVec * 2], window = p.oscVec?.[oscVec * 2 + 1];
				oscVec++;
				if (!rf || !window) break;
				const life = num(o, 'start/end proportional', 1) ? frac : age;
				if (life < window[0] || life >= window[1]) break;
				const mult = num(o, 'oscillation multiplier', 2), phase = num(o, 'oscillation start phase', 0.5);
				const proportional = !!num(o, 'proportional 0/1', 1);
				const d = [0, 1, 2].map(i => {
					const turns = proportional ? mult * rf[3 + i] * frac + phase : rf[3 + i] * (mult * this.time + phase);
					return rf[i] * dt * Math.sin(2 * Math.PI * turns);
				});
				const field = num(o, 'oscillation field', 0);
				if (field === F.COLOR) p.color = p.color.map((c, i) => Math.min(1, Math.max(0, c + d[i])));
				else if (field === 0) p.pos.add(new THREE.Vector3(d[0], d[1], d[2]));
				break;
			}
			case 'movement dampen relative to control point': {
				// (C_OP_DampenToCP) slowed near a point, to a stop at it: its step
				// this frame scaled by (distance / range)^scale
				const range = num(o, 'falloff range', 100);
				if (range <= 0) break;
				const d = p.pos.clone().addScaledVector(p.vel, dt).distanceTo(this.cpPos(num(o, 'control_point_number', 0)));
				if (d <= range) p.vel.multiplyScalar(Math.pow(d / range, num(o, 'dampen scale', 1)));
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
				if (p.radius * radiusScale * (interpolated ?? 1) < num(o, 'minimum radius', 1)) p.life = -2;
				break;
			}
		}
		p.drawAlpha = Math.max(0, p.alpha) * alpha * Math.max(0, p.alpha2);
		p.drawRadius = Math.max(0, p.radius * radiusScale * (interpolated ?? 1)) * this.sizeScale;
		if (moves) p.pos.addScaledVector(p.vel, dt);
	}
}

// sprite sheets by material, once the renderer has loaded them: the
// simulation reads sequence lengths from them ("lifetime from sequence")
const sheets = new Map<string, SheetSequence[] | null>();

// ---- drawing ----

interface SpriteMaterial {
	material: THREE.ShaderMaterial;
	sheet: SheetSequence[] | null;
	orientation: number;  // SpriteCard $orientation (3: along the particles' normals)
	dual: boolean;        // $dualsequence: a second sheet sequence combined with the first
	// $minsize, $maxsize, $startfadesize, $endfadesize: limits on a sprite's
	// radius as a fraction of its distance from the eye (fading out, then
	// gone, between the last two: smoke at the camera)
	size: [number, number, number, number];
	// $depthblend: faded where it meets what's behind it, over this many
	// units ($depthblendscale), else 0
	depthBlend: number;
	height: number;       // the texture's height in texels (a rope's texture repeats every height x texel_size units)
}

// a blob-rendered system's particles this frame, and the blob shape
export interface BlobSet {
	material: string;
	radius: number;
	cutoffRatio: number;
	grid: number;
	points: THREE.Vector3[];
}

// one material's quads, as they're written to its mesh
interface Batch {
	pos: number[];
	uv: number[];
	uv2: number[];  // the second sequence's frame
	col: number[];
}

const VERTEX = `
	attribute vec4 pcolor;
	attribute vec2 uv2;
	varying vec2 vUv;
	varying vec2 vUv2;
	varying vec4 vColor;
	void main() {
		vUv = uv;
		vUv2 = uv2;
		// (SpriteCard's vertex shader takes the particle colour from gamma
		// to linear: GammaToLinear, pow 2.2; alpha as it is)
		vColor = vec4(pow(max(pcolor.rgb, vec3(0.0)), vec3(2.2)), pcolor.a);
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}`;

// SpriteCard's: $addself sprites are drawn premultiplied, brightened by
// that much of themselves; every sprite is at most white once exposed (the
// shader saturates its output). A $dualsequence one combines its second
// sequence's frame by $sequence_blend_mode: averaged, its colour under the
// first's alpha, or laid over the first by its own alpha
const FRAGMENT = `
	uniform sampler2D map;
	uniform float overbright;
	uniform float addSelf;
	uniform float sceneExposure;
	varying vec2 vUv;
	varying vec2 vUv2;
	varying vec4 vColor;
	void main() {
		vec4 t = texture2D(map, vUv);
	#ifdef DUAL
		vec4 t2 = texture2D(map, vUv2);
	#if DUAL == 0
		t = 0.5 * (t + t2);
	#elif DUAL == 1
		t.rgb = t2.rgb;
	#else
		t.rgb = mix(t.rgb, t2.rgb, t2.a);
	#endif
	#endif
		vec3 rgb = t.rgb * overbright;
		float a = t.a * vColor.a;
	#ifdef ADDSELF
		rgb *= a * (1.0 + addSelf);
	#endif
		gl_FragColor = vec4(min(rgb * vColor.rgb, vec3(1.0 / max(sceneExposure, 1e-3))), min(a, 1.0));
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
	// systems drawn as blobs (render_blobs: gel, as the paint renderer
	// draws it), gathered by draw for the view to merge into surfaces
	readonly blobs: BlobSet[] = [];
	// how much of a point the camera sees (0..1), for renderers with a
	// visibility proxy; everything counts as seen without it
	visibility: ((point: THREE.Vector3, camera: THREE.Vector3, radius: number) => number) | null = null;
	// how far from a point along a direction the world's first surface is
	// (Infinity for none within `far`), for $depthblend sprites
	surface: ((from: THREE.Vector3, dir: THREE.Vector3, far: number) => number) | null = null;

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
		t.wrapS = THREE.ClampToEdgeWrapping;
		t.wrapT = THREE.RepeatWrapping;  // ropes repeat along their length
		t.needsUpdate = true;
		const on = (k: string) => {
			const v = m.params.get(k);
			return v !== undefined && v !== '0';
		};
		const addSelf = Number(m.params.get('$addself') ?? 0) || 0;
		const dual = on('$dualsequence');
		const defines: Record<string, string> = {};
		if (addSelf) defines.ADDSELF = '';
		if (dual) defines.DUAL = String(Math.min(2, Math.max(0, Number(m.params.get('$sequence_blend_mode') ?? 0) || 0)));
		const material = new THREE.ShaderMaterial({
			uniforms: {
				map: {value: t}, overbright: {value: Number(m.params.get('$overbrightfactor') ?? 1) || 1}, addSelf: {value: addSelf},
				...exposureUniforms,
			},
			defines,
			vertexShader: VERTEX,
			fragmentShader: FRAGMENT,
			transparent: true,
			depthWrite: false,
			depthTest: !on('$ignorez'),
			blending: addSelf ? THREE.CustomBlending : on('$additive') ? THREE.AdditiveBlending : THREE.NormalBlending,
			blendSrc: THREE.OneFactor,
			blendDst: THREE.OneMinusSrcAlphaFactor,
			side: THREE.DoubleSide,
		});
		const param = (k: string, d: number) => {
			const v = Number(m.params.get(k));
			return Number.isFinite(v) && m.params.has(k) ? v : d;
		};
		const size: [number, number, number, number] = [param('$minsize', 0), param('$maxsize', 20), param('$startfadesize', 10), param('$endfadesize', 20)];
		const sheet = bytes ? readVtfSheet(bytes) : null;
		sheets.set(name, sheet);
		const depthBlend = on('$depthblend') ? param('$depthblendscale', 50) : 0;
		const height = (tex.image as {height?: number} | undefined)?.height || 1;
		return {material, sheet, orientation: Number(m.params.get('$orientation') ?? 0) || 0, dual, size, depthBlend, height};
	}

	// $depthblend, as the shader's (each pixel faded by how far the world
	// behind it is, over the blend scale), taken over the card at its centre
	// and four points around it: how far the surface behind each is
	private depthFade(at: THREE.Vector3, radius: number, camPos: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, scale: number): number {
		const offsets = radius < 16 ? [[0, 0]] : [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]];
		let sum = 0;
		for (const [x, y] of offsets) {
			const p = at.clone().addScaledVector(right, x * radius).addScaledVector(up, y * radius);
			const dir = p.clone().sub(camPos);
			const d = dir.length();
			if (d < 1e-3) {
				sum += 1;
				continue;
			}
			dir.divideScalar(d);
			const hit = this.surface!(camPos, dir, d + scale);
			sum += Math.min(1, Math.max(0, (hit - d) / scale));
		}
		return sum / offsets.length;
	}

	// rebuilds the quads of every live particle
	draw(instances: ParticleInstance[], camera: THREE.Camera) {
		const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
		const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
		const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
		const batches = new Map<string, Batch>();
		const quad = (b: Batch, c: THREE.Vector3[], uv: number[][], col: number[][], uv2 = uv) => {
			for (const k of [0, 1, 2, 0, 2, 3]) {
				b.pos.push(c[k].x, c[k].y, c[k].z);
				b.uv.push(uv[k][0], uv[k][1]);
				b.uv2.push(uv2[k][0], uv2[k][1]);
				b.col.push(...col[k]);
			}
		};
		this.blobs.length = 0;
		for (const inst of instances) {
			const def = inst.def;
			if (!def.material || !inst.particles.length) continue;
			const blob = def.renderers.find(o => o.fn === 'render_blobs');
			if (blob) {
				// (in the blob renderer's units of 10, as the paint's)
				const render = num(blob, 'render_radius', 1.3), cutoff = num(blob, 'cutoff_radius', 3.3);
				this.blobs.push({
					material: def.material, radius: render * 10, cutoffRatio: cutoff / Math.max(render, 1e-3), grid: Math.max(2, num(blob, 'cube_width', 1)),
					points: inst.particles.map(p => inst.ahead ? p.pos.clone().addScaledVector(p.vel, inst.ahead) : p.pos.clone()),
				});
				continue;
			}
			const sprite = this.sprite(def.material);
			if (!sprite) continue;
			let b = batches.get(def.material);
			// (each of its renderers draws it: some draw the sprites twice)
			for (const r of def.renderers) {
				if (r.fn !== 'render_animated_sprites' && r.fn !== 'render_sprite_trail' && r.fn !== 'render_rope') continue;
				if (!b) batches.set(def.material, b = {pos: [], uv: [], uv2: [], col: []});
				if (r.fn === 'render_rope') {
					this.rope(b, inst, r, camPos, quad, sprite.orientation, sprite.height);
					continue;
				}
				const trail = r.fn === 'render_sprite_trail';
				const rate = num(r, 'animation rate', 0.1), rate2 = num(r, 'second sequence animation rate', 0);
				const fit = num(r, 'animation_fit_lifetime', 0);
				const orientation = num(r, 'orientation_type', 0);
				const flat = orientation === 2;
				// a visibility proxy (a light's flare): how much of a control point
				// shows, remapped onto radius and alpha scales
				let visRadius = 1, visAlpha = 1;
				const proxy = num(r, 'Visibility Proxy Input Control Point Number', -1);
				if (proxy >= 0 && this.visibility) {
					const seen = this.visibility(inst.cpPos(proxy), camPos, num(r, 'Visibility Proxy Radius', 1));
					const i0 = num(r, 'Visibility input minimum', 0), i1 = num(r, 'Visibility input maximum', 1);
					const t = Math.min(1, Math.max(0, (seen - i0) / ((i1 - i0) || 1)));
					const lerp = (a: string, da: number, b: string, db: number) => num(r, a, da) + (num(r, b, db) - num(r, a, da)) * t;
					visRadius = lerp('Visibility Radius Scale minimum', 1, 'Visibility Radius Scale maximum', 1);
					visAlpha = lerp('Visibility Alpha Scale minimum', 0, 'Visibility Alpha Scale maximum', 1);
					if (visAlpha <= 0) continue;
				}
				const [minSize, maxSize, startFade, endFade] = sprite.size;
				for (const p of inst.particles) {
					if (p.drawAlpha <= 0.002 || p.drawRadius <= 0) continue;
					// (the sprite shader's size limits, by distance from the eye)
					let radius = p.drawRadius * visRadius, alpha = p.drawAlpha * visAlpha;
					const at = inst.ahead ? p.pos.clone().addScaledVector(p.vel, inst.ahead) : p.pos;
					if (!trail) {
						const l = at.distanceTo(camPos);
						radius = Math.max(radius, minSize * l);
						if (radius > startFade * l) {
							if (radius > endFade * l) continue;
							alpha *= 1 - (radius - startFade * l) / Math.max(1e-6, (endFade - startFade) * l);
						}
						radius = Math.min(radius, maxSize * l);
						if (sprite.depthBlend && this.surface) {
							alpha *= this.depthFade(at, radius, camPos, right, up, sprite.depthBlend);
							if (alpha <= 0.002) continue;
						}
					}
					const age = inst.time + inst.ahead - p.born;
					const uv = frameUv(sprite.sheet, p.seq, fit ? age / Math.max(p.life, 1e-3) : age * rate, !!fit);
					const uv2 = sprite.dual ? frameUv(sprite.sheet, p.seq2, age * rate2, false) : uv;
					let ax: THREE.Vector3, ay: THREE.Vector3, center = at;
					if (trail) {
						// stretched back along the velocity, as wide as the radius
						const speed = p.vel.length();
						const len = Math.min(num(r, 'max length', 2000), Math.max(num(r, 'min length', 0), speed * p.trail));
						if (speed < 1e-3) continue;
						const dir = p.vel.clone().divideScalar(speed);
						center = at.clone().addScaledVector(dir, -len / 2);
						const toCam = camPos.clone().sub(center).normalize();
						ax = dir.clone().cross(toCam).normalize().multiplyScalar(p.drawRadius);
						ay = dir.multiplyScalar(len / 2);
					} else if (flat) {
						const c = Math.cos(p.rot * Math.PI / 180), s = Math.sin(p.rot * Math.PI / 180);
						ax = new THREE.Vector3(c, s, 0).multiplyScalar(radius);
						ay = new THREE.Vector3(-s, c, 0).multiplyScalar(radius);
					} else if (orientation === 3 && p.normal) {
						// in the plane across its normal, turned by its rotation
						const n = p.normal;
						const u0 = new THREE.Vector3(...(Math.abs(n.z) < 0.99 ? [0, 0, 1] : [1, 0, 0]) as [number, number, number]).cross(n).normalize();
						const v0 = n.clone().cross(u0);
						const c = Math.cos(p.rot * Math.PI / 180), s = Math.sin(p.rot * Math.PI / 180);
						ax = u0.clone().multiplyScalar(c).addScaledVector(v0, s).multiplyScalar(radius);
						ay = v0.clone().multiplyScalar(c).addScaledVector(u0, -s).multiplyScalar(radius);
					} else {
						const c = Math.cos(p.rot * Math.PI / 180), s = Math.sin(p.rot * Math.PI / 180);
						ax = right.clone().multiplyScalar(c).addScaledVector(up, s).multiplyScalar(radius);
						ay = up.clone().multiplyScalar(c).addScaledVector(right, -s).multiplyScalar(radius);
					}
					const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([cx, cy]) => center.clone().addScaledVector(ax, cx).addScaledVector(ay, cy));
					const col = [p.color[0], p.color[1], p.color[2], alpha];
					quad(b, corners, [[uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]], [uv[0], uv[1]]], [col, col, col, col],
						[[uv2[0], uv2[3]], [uv2[2], uv2[3]], [uv2[2], uv2[1]], [uv2[0], uv2[1]]]);
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
			const count = writeAttribute(g, 'position', b.pos, 3);
			writeAttribute(g, 'uv', b.uv, 2);
			writeAttribute(g, 'uv2', b.uv2, 2);
			writeAttribute(g, 'pcolor', b.col, 4);
			g.setDrawRange(0, count);
			mesh.visible = count > 0;
		}
	}

	// A rope through the particles in spawn order, smoothed (Catmull-Rom),
	// facing the camera (or, for $orientation 3 materials, widened along
	// the particles' normals: those that "remap direction to cp to vector"
	// points at a control point), its whole width each
	// particle's radius; the texture repeats along it every texture height x texel_size units and scrolls
	private rope(b: Batch, inst: ParticleInstance, r: ParticleOperator, camPos: THREE.Vector3,
		quad: (b: Batch, c: THREE.Vector3[], uv: number[][], col: number[][]) => void, orientation = 0, height = 1) {
		const aim = orientation === 3 ? inst.def.operators.find(o => o.fn === 'remap direction to cp to vector') : undefined;
		const aimAt = aim ? inst.cpPos(num(aim, 'control point', 0)) : null;
		const ps = [...inst.particles].sort((x, y) => x.index - y.index);
		if (ps.length < 2) return;
		// (each the rest of the step along its velocity, as sprites are drawn)
		const pos = ps.map(p => inst.ahead ? p.pos.clone().addScaledVector(p.vel, inst.ahead) : p.pos);
		const sub = Math.max(1, Math.floor(num(r, 'subdivision_count', 3)));
		// (the texture once every height x texel_size units along it,
		// scrolling and offset in units: C_OP_RenderRope)
		const texel = 1 / Math.max(1e-6, height * num(r, 'texel_size', 4));
		const shift = num(r, 'texture_scroll_rate', 0) * inst.time + num(r, 'texture_offset', 0);
		const pts: {p: THREE.Vector3; w: number; c: number[]}[] = [];
		for (let i = 0; i + 1 < ps.length; i++) {
			const p0 = pos[Math.max(0, i - 1)], p1 = pos[i], p2 = pos[i + 1], p3 = pos[Math.min(ps.length - 1, i + 2)];
			for (let s = 0; s < sub; s++) {
				const t = s / sub, t2 = t * t, t3 = t2 * t;
				const p = new THREE.Vector3(
					0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
					0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
					0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3));
				const a = ps[i], z = ps[i + 1];
				// (a particle's radius is the rope's whole width: the spline
				// shader offsets each side by radius * (v - 0.5))
				pts.push({p, w: (a.drawRadius + (z.drawRadius - a.drawRadius) * t) / 2, c: [0, 1, 2].map(k => a.color[k] + (z.color[k] - a.color[k]) * t).concat(a.drawAlpha + (z.drawAlpha - a.drawAlpha) * t)});
			}
		}
		const last = ps[ps.length - 1];
		pts.push({p: pos[pos.length - 1].clone(), w: last.drawRadius / 2, c: [...last.color, last.drawAlpha]});
		let dist = 0;
		for (let i = 0; i + 1 < pts.length; i++) {
			const a = pts[i], z = pts[i + 1];
			const dir = z.p.clone().sub(a.p);
			const len = dir.length();
			if (len < 1e-4) continue;
			dir.divideScalar(len);
			// (facing the camera; or, oriented, widened towards the control
			// point the normals point at, lying flat in the plane that holds
			// it: a portal's edge is a band in the portal's plane)
			const across = (p: THREE.Vector3) => {
				if (!aimAt) return dir.clone().cross(camPos.clone().sub(p)).normalize();
				const to = aimAt.clone().sub(p);
				return to.addScaledVector(dir, -to.dot(dir)).normalize();
			};
			const sideA = across(a.p), sideZ = across(z.p);
			const u0 = (dist + shift) * texel, u1 = (dist + len + shift) * texel;
			dist += len;
			quad(b,
				[a.p.clone().addScaledVector(sideA, -a.w), a.p.clone().addScaledVector(sideA, a.w), z.p.clone().addScaledVector(sideZ, z.w), z.p.clone().addScaledVector(sideZ, -z.w)],
				// (the texture's x across the rope, its y along: rope textures
				// are a cross-section repeated down the image)
				[[1, u0], [0, u0], [0, u1], [1, u1]],
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
