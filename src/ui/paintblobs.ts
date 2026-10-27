// Falling gel (paint sprayers' blobs). The game doesn't network the blobs:
// each side fires them from the sprayer's settings (rate, speed, spread, a
// random seed) and moves them itself (sv_gravity, a little air drag) until
// they hit something, drawing them merged as metaballs. Here each blob is
// fired the same way, its path traced against the world once, and the blobs
// in the air drawn merged too (an isosurface through them, per patch of
// space), lit, in their gel's colour; a moment shows the same stream however
// it was reached.
import * as THREE from 'three';
import {IsoGrid} from './isosurface.ts';

const GRAVITY = 600;        // sv_gravity (x paintblob_gravity_scale 1)
const AIR_DRAG = 0.1;       // paintblob_air_drag: speed lost per second
const STEP = 1 / 30;        // the path's samples
const MAX_LIFE = 5;         // seconds a blob is followed (it lands well before)
// The game's blob renderer, in its units of 10 (its grid, 0.8, is
// paintblob_isosurface_box_width's 8): a blob's surface 1.3 out, its field
// reaching 5.5 (r_paintblob_blr_render_radius, _cutoff_radius); times the
// blob's 0.7..1 radius scale. (Particle systems' blob renderers set their own.)
export interface BlobShape {
	radius: number;       // a lone blob's surface, in world units
	cutoffRatio: number;  // its field's reach, as a multiple of that
	grid: number;         // the isosurface grid's step
}
const PAINT_SHAPE: BlobShape = {radius: 13, cutoffRatio: 5.5 / 1.3, grid: 8};
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
	private cells: IsoGrid[] = [];
	private paths = new Map<string, Path>();
	private used = new Set<string>();
	private trace: (from: THREE.Vector3, to: THREE.Vector3) => number;
	private shape: BlobShape;
	// each cell's grid reaches a blob's field (and a step) past it, in whole
	// steps so neighbouring cells' grids share their points and the surfaces
	// they both build meet exactly
	private pad: number;
	// the field's level at the surface: a lone ball's (1 - d^2/R^2)^3 at its radius
	private iso: number;

	// `trace`: how far along a segment the world is (Infinity when clear)
	constructor(trace: (from: THREE.Vector3, to: THREE.Vector3) => number, shape = PAINT_SHAPE) {
		this.trace = trace;
		// (a grid step that divides the cells, so their grids line up)
		this.shape = {...shape, grid: CELL / Math.max(1, Math.round(CELL / shape.grid))};
		shape = this.shape;
		this.pad = (Math.ceil(shape.radius * shape.cutoffRatio / shape.grid) + 1) * shape.grid;
		this.iso = (1 - 1 / (shape.cutoffRatio * shape.cutoffRatio)) ** 3;
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
	private lastKey = '';
	update(sprayers: Sprayer[], time: number) {
		// (the same moment again, as the co-op partner's view asks first: the
		// surfaces built for it stand)
		const key = `${time}|` + sprayers.map(sp => `${sp.key},${sp.origin.x},${sp.origin.y},${sp.origin.z},${sp.dir.x},${sp.dir.y},${sp.dir.z},${sp.rate},${sp.light}`).join(';');
		if (key === this.lastKey) return;
		this.lastKey = key;
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
					blobs.push({pos: p.clone(), radius: this.shape.radius * path.scale, color: new THREE.Color(sp.color[0] * sp.light, sp.color[1] * sp.light, sp.color[2] * sp.light)});
				}
			}
		}
		this.draw(blobs);
		// forget the paths no longer in the air
		if (this.paths.size > this.used.size + 512) for (const key of this.paths.keys()) if (!this.used.has(key)) this.paths.delete(key);
	}

	// blobs placed by someone else (a particle system's), drawn merged as
	// the sprayers' are, each at the shape's radius
	show(points: {pos: THREE.Vector3; color: THREE.Color}[]) {
		this.lastKey = '';
		this.draw(points.slice(0, CAPACITY).map(p => ({pos: p.pos, radius: this.shape.radius, color: p.color})));
	}

	// The blobs as merged surfaces: space cut into cells, each built from the
	// blobs in it and those reaching into it from next door (so neighbours'
	// surfaces meet); a lone blob's surface at its radius
	private draw(blobs: Blob[]) {
		const {grid: GRID, cutoffRatio} = this.shape, PAD = this.pad;
		const byCell = new Map<string, {key: number[]; list: Blob[]}>();
		const reach = this.shape.radius * cutoffRatio;
		// the cells blobs reach into, each with every blob whose field reaches
		// its padded grid (so cells build the same surface where they overlap)
		const cells = (b: Blob, r: number, each: (id: string, key: number[]) => void) => {
			const lo = [0, 1, 2].map(a => Math.floor((b.pos.getComponent(a) - r) / CELL));
			const hi = [0, 1, 2].map(a => Math.floor((b.pos.getComponent(a) + r) / CELL));
			for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) each(`${x},${y},${z}`, [x, y, z]);
		};
		for (const b of blobs) cells(b, reach, (id, key) => byCell.has(id) || byCell.set(id, {key, list: []}));
		for (const b of blobs) cells(b, reach + PAD, id => byCell.get(id)?.list.push(b));
		let used = 0;
		for (const {key, list} of byCell.values()) {
			if (used >= MAX_CELLS) break;
			let grid = this.cells[used];
			if (!grid) {
				grid = new IsoGrid((CELL + PAD * 2) / GRID, this.material, 30000);
				this.cells.push(grid);
				this.group.add(grid.mesh);
			}
			used++;
			const size = CELL + PAD * 2;
			const min = new THREE.Vector3(key[0] * CELL - PAD, key[1] * CELL - PAD, key[2] * CELL - PAD);
			grid.clear();
			this.fill(grid, list, min);
			grid.polygonize(this.iso, min, GRID);
			// (its bounds: each view leaves out the cells it can't see)
			grid.mesh.geometry.boundingSphere = new THREE.Sphere(min.clone().addScalar(size / 2), size * Math.sqrt(3) / 2);
			grid.mesh.visible = true;
		}
		for (let i = used; i < this.cells.length; i++) this.cells[i].mesh.visible = false;
	}

	// The blobs' field on a cell's grid: each a soft ball (1 - d^2/R^2)^3
	// reaching its cutoff radius R, the surface where a lone one's field is at
	// its render radius, so neighbours within about R of each other run
	// together into one stream; the colour is the blobs' own, weighted by
	// their field
	private fill(grid: IsoGrid, blobs: Blob[], min: THREE.Vector3) {
		const {grid: GRID, cutoffRatio: CUTOFF_RATIO} = this.shape;
		const n = grid.n, n2 = n * n;
		const {field, palette, weight} = grid;
		for (const b of blobs) {
			const reach = b.radius * CUTOFF_RATIO / GRID;  // in grid steps
			const cx = (b.pos.x - min.x) / GRID, cy = (b.pos.y - min.y) / GRID, cz = (b.pos.z - min.z) / GRID;
			// (not the grid's outer layer: its normals aren't defined)
			const lo = (c: number) => Math.max(1, Math.ceil(c - reach)), hi = (c: number) => Math.min(n - 2, Math.floor(c + reach));
			const from = [lo(cx), lo(cy), lo(cz)], to = [hi(cx), hi(cy), hi(cz)];
			if (from.some((v, a) => v > to[a])) continue;
			grid.touch(from, to);
			const inv = 1 / (reach * reach);
			for (let z = lo(cz); z <= hi(cz); z++) {
				const dz2 = (z - cz) ** 2;
				for (let y = lo(cy); y <= hi(cy); y++) {
					const dyz2 = dz2 + (y - cy) ** 2;
					for (let x = lo(cx); x <= hi(cx); x++) {
						const t = 1 - (dyz2 + (x - cx) ** 2) * inv;
						if (t <= 0) continue;
						const v = t * t * t, i = z * n2 + y * n + x;
						field[i] += v;
						weight[i] += v;
						palette[i * 3] += b.color.r * v;
						palette[i * 3 + 1] += b.color.g * v;
						palette[i * 3 + 2] += b.color.b * v;
					}
				}
			}
		}
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
		this.lastKey = '';
		this.paths.clear();
		for (const grid of this.cells) grid.mesh.visible = false;
	}

	dispose() {
		for (const grid of this.cells) grid.dispose();
		this.cells = [];
		this.material.dispose();
		this.group.clear();
	}
}
