// Falling gel (paint sprayers' blobs). The game doesn't network the blobs:
// each side fires them from the sprayer's settings (rate, speed, spread, a
// random seed) and moves them itself (sv_gravity, a little air drag) until
// they hit something, drawing them merged as metaballs. Here each blob is
// fired the same way, its path traced against the world once, and the blobs
// in the air drawn merged too (an isosurface through them, per patch of
// space), lit, in their gel's colour; a moment shows the same stream however
// it was reached.
import * as THREE from 'three';
import {MarchingCubes} from 'three/examples/jsm/objects/MarchingCubes.js';

const GRAVITY = 600;        // sv_gravity (x paintblob_gravity_scale 1)
const AIR_DRAG = 0.1;       // paintblob_air_drag: speed lost per second
const STEP = 1 / 30;        // the path's samples
const MAX_LIFE = 5;         // seconds a blob is followed (it lands well before)
// The game's blob renderer, in its units of 10 (its grid, 0.8, is
// paintblob_isosurface_box_width's 8): a blob's surface 1.3 out, its field
// reaching 5.5 (r_paintblob_blr_render_radius, _cutoff_radius); times the
// blob's 0.7..1 radius scale
const RADIUS = 13;
const CUTOFF_RATIO = 5.5 / 1.3;
const GRID = 8;
const CAPACITY = 4096;
const CELL = 160;           // the patches of space a surface is built in
const MAX_CELLS = 32;

export interface Sprayer {
	key: string;
	origin: THREE.Vector3;
	dir: THREE.Vector3;      // spray direction (unit)
	periods: [number, number][];  // when it sprays, in seconds
	rate: number;            // blobs per second
	minSpeed: number;
	maxSpeed: number;
	spreadRadius: number;
	spreadAngle: number;     // degrees
	seed: number;
	color: [number, number, number];  // linear
	light: number;           // how lit the stream is (the light at the sprayer)
}

interface Path {
	points: Float32Array;  // xyz every STEP from firing
	life: number;          // seconds until it hits something
	scale: number;
}

interface Blob {
	pos: THREE.Vector3;
	radius: number;
	color: THREE.Color;
}

const mulberry = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export class PaintBlobs {
	readonly group = new THREE.Group();
	private material: THREE.ShaderMaterial;
	private cells: MarchingCubes[] = [];
	private paths = new Map<string, Path>();
	private used = new Set<string>();
	private trace: (from: THREE.Vector3, to: THREE.Vector3) => number;

	// `trace`: how far along a segment the world is (Infinity when clear)
	constructor(trace: (from: THREE.Vector3, to: THREE.Vector3) => number) {
		this.trace = trace;
		this.material = new THREE.ShaderMaterial({
			vertexColors: true,
			vertexShader: `
				varying vec3 vN;
				varying vec3 vColor;
				varying vec3 vView;
				void main() {
					vec4 world = modelMatrix * vec4(position, 1.0);
					vN = normalize(mat3(modelMatrix) * normal);
					vColor = color;
					vView = normalize(cameraPosition - world.xyz);
					gl_Position = projectionMatrix * viewMatrix * world;
				}`,
			fragmentShader: `
				varying vec3 vN;
				varying vec3 vColor;
				varying vec3 vView;
				void main() {
					vec3 n = normalize(vN);
					// lit mostly from above, with a wet sheen at the rim
					float diffuse = 0.45 + 0.55 * max(n.z, 0.0);
					float rim = pow(1.0 - abs(dot(n, vView)), 3.0);
					gl_FragColor = vec4(vColor * diffuse + vColor * rim * 0.6, 1.0);
				}`,
		});
		this.material.userData.effect = true;
	}

	// the blobs in the air at `time` (seconds)
	update(sprayers: Sprayer[], time: number) {
		const s = new THREE.Vector3(), p = new THREE.Vector3();
		const blobs: Blob[] = [];
		this.used.clear();
		for (const sp of sprayers) {
			if (sp.rate <= 0) continue;
			for (const [from, to] of sp.periods) {
				const end = Math.min(to, time);
				if (end < from || time - MAX_LIFE > end) continue;
				const first = Math.max(0, Math.ceil((time - MAX_LIFE - from) * sp.rate));
				const last = Math.floor((end - from) * sp.rate);
				for (let i = first; i <= last && blobs.length < CAPACITY; i++) {
					const fired = from + i / sp.rate;
					const age = time - fired;
					if (age < 0) continue;
					const key = `${sp.key}:${from}:${i}`;
					this.used.add(key);
					let path = this.paths.get(key);
					if (!path) {
						path = this.fire(sp, i);
						this.paths.set(key, path);
					}
					if (age >= path.life) continue;
					const f = age / STEP, k = Math.min(Math.floor(f), path.points.length / 3 - 2), t = f - k;
					p.set(path.points[k * 3], path.points[k * 3 + 1], path.points[k * 3 + 2]).lerp(s.set(path.points[k * 3 + 3], path.points[k * 3 + 4], path.points[k * 3 + 5]), t);
					blobs.push({pos: p.clone(), radius: RADIUS * path.scale, color: new THREE.Color(sp.color[0] * sp.light, sp.color[1] * sp.light, sp.color[2] * sp.light)});
				}
			}
		}
		this.draw(blobs);
		// forget the paths no longer in the air
		if (this.paths.size > this.used.size + 512) for (const key of this.paths.keys()) if (!this.used.has(key)) this.paths.delete(key);
	}

	// The blobs as merged surfaces: space cut into cells, each built from the
	// blobs in it and those reaching into it from next door (so neighbours'
	// surfaces meet); a lone blob's surface at its radius
	private draw(blobs: Blob[]) {
		const byCell = new Map<string, {key: number[]; list: Blob[]}>();
		const reach = RADIUS * CUTOFF_RATIO;
		for (const b of blobs) {
			const lo = [0, 1, 2].map(a => Math.floor((b.pos.getComponent(a) - reach) / CELL));
			const hi = [0, 1, 2].map(a => Math.floor((b.pos.getComponent(a) + reach) / CELL));
			for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
				const id = `${x},${y},${z}`;
				let c = byCell.get(id);
				if (!c) byCell.set(id, c = {key: [x, y, z], list: []});
				c.list.push(b);
			}
		}
		let used = 0;
		for (const {key, list} of byCell.values()) {
			if (used >= MAX_CELLS) break;
			let cube = this.cells[used];
			if (!cube) {
				// (the grid covers the cell and a blob's reach either side)
				cube = new MarchingCubes(Math.ceil((CELL + RADIUS * CUTOFF_RATIO * 2) / GRID), this.material, false, true, 30000);
				cube.frustumCulled = false;
				this.cells.push(cube);
				this.group.add(cube);
			}
			used++;
			// (padded by a blob's reach either side: the grid's outer layer isn't drawn)
			const size = CELL + reach * 2;
			const min = new THREE.Vector3(key[0] * CELL - reach, key[1] * CELL - reach, key[2] * CELL - reach);
			cube.position.copy(min).addScalar(size / 2);
			cube.scale.setScalar(size / 2);
			cube.reset();
			// (a ball's field: strength / d^2 - subtract, gone at sqrt(strength /
			// subtract), its surface where it reaches the isolation level: at
			// its radius for this strength, with the reach the game's has)
			const subtract = cube.isolation / (CUTOFF_RATIO * CUTOFF_RATIO - 1);
			for (const b of list) {
				const r = b.radius / size;
				cube.addBall((b.pos.x - min.x) / size, (b.pos.y - min.y) / size, (b.pos.z - min.z) / size, r * r * (cube.isolation + subtract), subtract, b.color);
			}
			cube.update();
			cube.visible = true;
		}
		for (let i = used; i < this.cells.length; i++) this.cells[i].visible = false;
	}

	// a blob as FirePaintBlob fires it: from a random point of the spray
	// circle, away from the cone's apex behind it (or within the spread
	// angle around the spray direction), at a random speed; then falling
	private fire(sp: Sprayer, i: number): Path {
		const rand = mulberry(sp.seed * 7919 + i);
		const dir = sp.dir.clone().normalize();
		const up = Math.abs(dir.z) < 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
		const right = up.clone().cross(dir).normalize();
		const circleUp = dir.clone().cross(right).normalize();
		const around = circleUp.clone().applyAxisAngle(dir, rand() * Math.PI * 2);
		const pos = sp.origin.clone().addScaledVector(around, rand() * sp.spreadRadius);
		const angle = Math.min(89, Math.max(0, sp.spreadAngle)) * Math.PI / 180;
		let fireDir: THREE.Vector3;
		if (sp.spreadRadius > 0) {
			const apex = angle > 1e-3 ? sp.origin.clone().addScaledVector(dir, -sp.spreadRadius / Math.tan(angle)) : pos.clone().addScaledVector(dir, -1);
			fireDir = pos.clone().sub(apex).normalize();
		} else {
			const spread = Math.sin(angle / 2);
			fireDir = dir.clone().addScaledVector(right, (rand() * 2 - 1) * spread).addScaledVector(circleUp, (rand() * 2 - 1) * spread).normalize();
		}
		const vel = fireDir.multiplyScalar(sp.minSpeed + rand() * (sp.maxSpeed - sp.minSpeed));
		const scale = 0.7 + rand() * 0.3;
		const steps = Math.ceil(MAX_LIFE / STEP);
		const points: number[] = [pos.x, pos.y, pos.z];
		let life = MAX_LIFE;
		const next = new THREE.Vector3();
		for (let k = 0; k < steps; k++) {
			vel.multiplyScalar(Math.max(0, 1 - AIR_DRAG * STEP));
			vel.z -= GRAVITY * STEP;
			next.copy(pos).addScaledVector(vel, STEP);
			const hit = this.trace(pos, next);
			if (hit < Infinity) {
				const seg = next.distanceTo(pos);
				life = (k + Math.min(1, hit / Math.max(seg, 1e-3))) * STEP;
				points.push(next.x, next.y, next.z);
				break;
			}
			pos.copy(next);
			points.push(pos.x, pos.y, pos.z);
		}
		if (points.length < 6) points.push(points[0], points[1], points[2]);
		return {points: new Float32Array(points), life, scale};
	}

	clear() {
		this.paths.clear();
		for (const cube of this.cells) cube.visible = false;
	}

	dispose() {
		for (const cube of this.cells) cube.geometry.dispose();
		this.cells = [];
		this.material.dispose();
		this.group.clear();
	}
}
