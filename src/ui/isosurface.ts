// A scalar field on a grid and the surface where it crosses a level
// (marching cubes, as three's MarchingCubes builds it: the same tables,
// corner order, winding, gradient normals and colours), but only walked
// over the part of the grid that holds anything, and cleared the same way.
import * as THREE from 'three';
import {edgeTable as edges, triTable as tris} from 'three/examples/jsm/objects/MarchingCubes.js';

// (three's declarations have them as arrays of arrays; they're flat)
const edgeTable = edges as unknown as Int32Array, triTable = tris as unknown as Int32Array;

export class IsoGrid {
	readonly n: number;
	readonly field: Float32Array;
	readonly palette: Float32Array;   // colour sums (rgb per point)
	readonly weight: Float32Array;    // what each colour sum is out of
	readonly mesh: THREE.Mesh;
	private positions: Float32Array;
	private normals: Float32Array;
	private colors: Float32Array;
	private maxVertices: number;
	// the part of the grid written since the last clear (inclusive)
	private lo = [Infinity, Infinity, Infinity];
	private hi = [-Infinity, -Infinity, -Infinity];
	private vlist = new Float32Array(36);
	private nlist = new Float32Array(36);
	private clist = new Float32Array(36);

	constructor(n: number, material: THREE.Material, maxVertices: number) {
		this.n = n;
		this.field = new Float32Array(n * n * n);
		this.palette = new Float32Array(n * n * n * 3);
		this.weight = new Float32Array(n * n * n);
		this.maxVertices = maxVertices;
		this.positions = new Float32Array(maxVertices * 3);
		this.normals = new Float32Array(maxVertices * 3);
		this.colors = new Float32Array(maxVertices * 3);
		const g = new THREE.BufferGeometry();
		for (const [name, array] of [['position', this.positions], ['normal', this.normals], ['color', this.colors]] as const) {
			g.setAttribute(name, new THREE.BufferAttribute(array, 3).setUsage(THREE.DynamicDrawUsage));
		}
		g.setDrawRange(0, 0);
		this.mesh = new THREE.Mesh(g, material);
	}

	// grows the written part to take in a box of grid points
	touch(lo: number[], hi: number[]) {
		for (let a = 0; a < 3; a++) {
			this.lo[a] = Math.min(this.lo[a], lo[a]);
			this.hi[a] = Math.max(this.hi[a], hi[a]);
		}
	}

	// zeroes what was written
	clear() {
		const n = this.n, [x0, y0, z0] = this.lo, [x1, y1, z1] = this.hi;
		if (x1 >= x0) {
			for (let z = z0; z <= z1; z++) {
				for (let y = y0; y <= y1; y++) {
					const row = (z * n + y) * n;
					this.field.fill(0, row + x0, row + x1 + 1);
					this.weight.fill(0, row + x0, row + x1 + 1);
					this.palette.fill(0, (row + x0) * 3, (row + x1 + 1) * 3);
				}
			}
		}
		this.lo = [Infinity, Infinity, Infinity];
		this.hi = [-Infinity, -Infinity, -Infinity];
	}

	// builds the surface at `iso`, the grid's point (i, j, k) at
	// origin + (i, j, k) * step; false if it ran out of room
	polygonize(iso: number, origin: THREE.Vector3, step: number): boolean {
		const n = this.n, n2 = n * n, f = this.field;
		let count = 0;
		// (as three's: cubes 1..n-3, the outer layer's normals being undefined)
		const from = this.lo.map(v => Math.max(1, v - 1)), to = this.hi.map(v => Math.min(n - 3, v));
		const v = this.vlist, nl = this.nlist, cl = this.clist, pal = this.palette, w = this.weight;
		let full = false;
		const grad = (q: number, out: Float32Array, o: number) => {
			out[o] = f[q - 1] - f[q + 1];
			out[o + 1] = f[q - n] - f[q + n];
			out[o + 2] = f[q - n2] - f[q + n2];
		};
		const ga = new Float32Array(3), gb = new Float32Array(3);
		// a point on the edge from grid point qa to qb (b one step along `axis`)
		const edge = (o: number, qa: number, qb: number, va: number, vb: number, x: number, y: number, z: number, axis: number) => {
			const mu = (iso - va) / (vb - va);
			v[o] = origin.x + (x + (axis === 0 ? mu : 0)) * step;
			v[o + 1] = origin.y + (y + (axis === 1 ? mu : 0)) * step;
			v[o + 2] = origin.z + (z + (axis === 2 ? mu : 0)) * step;
			grad(qa, ga, 0);
			grad(qb, gb, 0);
			for (let c = 0; c < 3; c++) {
				nl[o + c] = ga[c] + (gb[c] - ga[c]) * mu;
				// (the colour sums are averaged here, not before: same result)
				const ca = w[qa] ? pal[qa * 3 + c] / w[qa] : 0, cb = w[qb] ? pal[qb * 3 + c] / w[qb] : 0;
				cl[o + c] = ca + (cb - ca) * mu;
			}
		};
		for (let z = from[2]; z <= to[2] && !full; z++) {
			for (let y = from[1]; y <= to[1] && !full; y++) {
				for (let x = from[0]; x <= to[0]; x++) {
					const q = z * n2 + y * n + x;
					const q1 = q + 1, qy = q + n, q1y = q1 + n, qz = q + n2, q1z = q1 + n2, qyz = qy + n2, q1yz = q1y + n2;
					const f0 = f[q], f1 = f[q1], f2 = f[qy], f3 = f[q1y], f4 = f[qz], f5 = f[q1z], f6 = f[qyz], f7 = f[q1yz];
					let cube = 0;
					if (f0 < iso) cube |= 1;
					if (f1 < iso) cube |= 2;
					if (f2 < iso) cube |= 8;
					if (f3 < iso) cube |= 4;
					if (f4 < iso) cube |= 16;
					if (f5 < iso) cube |= 32;
					if (f6 < iso) cube |= 128;
					if (f7 < iso) cube |= 64;
					const bits = edgeTable[cube];
					if (!bits) continue;
					if (bits & 1) edge(0, q, q1, f0, f1, x, y, z, 0);
					if (bits & 2) edge(3, q1, q1y, f1, f3, x + 1, y, z, 1);
					if (bits & 4) edge(6, qy, q1y, f2, f3, x, y + 1, z, 0);
					if (bits & 8) edge(9, q, qy, f0, f2, x, y, z, 1);
					if (bits & 16) edge(12, qz, q1z, f4, f5, x, y, z + 1, 0);
					if (bits & 32) edge(15, q1z, q1yz, f5, f7, x + 1, y, z + 1, 1);
					if (bits & 64) edge(18, qyz, q1yz, f6, f7, x, y + 1, z + 1, 0);
					if (bits & 128) edge(21, qz, qyz, f4, f6, x, y, z + 1, 1);
					if (bits & 256) edge(24, q, qz, f0, f4, x, y, z, 2);
					if (bits & 512) edge(27, q1, q1z, f1, f5, x + 1, y, z, 2);
					if (bits & 1024) edge(30, q1y, q1yz, f3, f7, x + 1, y + 1, z, 2);
					if (bits & 2048) edge(33, qy, qyz, f2, f6, x, y + 1, z, 2);
					const t = cube << 4;
					for (let i = 0; triTable[t + i] !== -1; i += 3) {
						if (count + 3 > this.maxVertices) {
							full = true;
							break;
						}
						for (let k = 0; k < 3; k++) {
							const src = triTable[t + i + k] * 3, dst = (count + k) * 3;
							this.positions[dst] = v[src];
							this.positions[dst + 1] = v[src + 1];
							this.positions[dst + 2] = v[src + 2];
							this.normals[dst] = nl[src];
							this.normals[dst + 1] = nl[src + 1];
							this.normals[dst + 2] = nl[src + 2];
							this.colors[dst] = cl[src];
							this.colors[dst + 1] = cl[src + 1];
							this.colors[dst + 2] = cl[src + 2];
						}
						count += 3;
					}
					if (full) break;
				}
			}
		}
		const g = this.mesh.geometry;
		g.setDrawRange(0, count);
		for (const name of ['position', 'normal', 'color']) {
			const a = g.getAttribute(name) as THREE.BufferAttribute;
			a.clearUpdateRanges();
			a.addUpdateRange(0, count * 3);
			a.needsUpdate = true;
		}
		return !full;
	}

	dispose() {
		this.mesh.geometry.dispose();
	}
}
