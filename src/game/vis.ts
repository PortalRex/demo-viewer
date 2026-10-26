// The map's potentially visible sets (vvis): which clusters of leaves can be
// seen from which. The engine draws only what's in the camera's cluster's
// set; it's conservative (everything that can show is in it), so culling by
// it changes nothing on screen.

export class Visibility {
	readonly numClusters: number;
	private planes: DataView;
	private nodes: DataView;
	private leaves: DataView;
	private vis: DataView;
	private head: number;
	private sets = new Map<number, Uint8Array>();

	constructor(planes: DataView, nodes: DataView, leaves: DataView, models: DataView, vis: DataView) {
		this.planes = planes;
		this.nodes = nodes;
		this.leaves = leaves;
		this.vis = vis;
		this.head = models.byteLength >= 48 ? models.getInt32(36, true) : 0;
		this.numClusters = vis.byteLength >= 4 ? vis.getInt32(0, true) : 0;
	}

	get available() {
		return this.numClusters > 0 && this.nodes.byteLength > 0;
	}

	leafAt(p: ArrayLike<number>): number {
		let node = this.head;
		for (let guard = 0; guard < 4096 && node >= 0; guard++) {
			const o = node * 32;
			const pn = this.nodes.getInt32(o, true);
			const d = this.planes.getFloat32(pn * 20, true) * p[0] + this.planes.getFloat32(pn * 20 + 4, true) * p[1] + this.planes.getFloat32(pn * 20 + 8, true) * p[2] - this.planes.getFloat32(pn * 20 + 12, true);
			node = this.nodes.getInt32(o + 4 + (d >= 0 ? 0 : 4), true);
		}
		return -1 - node;
	}

	// a leaf's cluster (-1: solid, or outside the map)
	leafCluster(leaf: number): number {
		return leaf >= 0 && leaf * 32 + 6 <= this.leaves.byteLength ? this.leaves.getInt16(leaf * 32 + 4, true) : -1;
	}

	// the clusters of every leaf a box touches (a unit around it, and on
	// both sides of a plane it lies in: flat panels sit right on the floor's)
	clustersInBox(min: ArrayLike<number>, max: ArrayLike<number>): number[] {
		const out = new Set<number>();
		const c = [0, 1, 2].map(i => (min[i] + max[i]) / 2), e = [0, 1, 2].map(i => (max[i] - min[i]) / 2 + 1);
		const stack = [this.head];
		while (stack.length) {
			const node = stack.pop()!;
			if (node < 0) {
				const cluster = this.leafCluster(-1 - node);
				if (cluster >= 0) out.add(cluster);
				continue;
			}
			const o = node * 32, pn = this.nodes.getInt32(o, true);
			const n = [0, 4, 8].map(k => this.planes.getFloat32(pn * 20 + k, true));
			const d = n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - this.planes.getFloat32(pn * 20 + 12, true);
			const r = Math.abs(n[0]) * e[0] + Math.abs(n[1]) * e[1] + Math.abs(n[2]) * e[2];
			if (d >= -r) stack.push(this.nodes.getInt32(o + 4, true));
			if (d <= r) stack.push(this.nodes.getInt32(o + 8, true));
		}
		return [...out];
	}

	clusterAt(p: ArrayLike<number>): number {
		return this.leafCluster(this.leafAt(p));
	}

	// the clusters visible from one, a bit per cluster (null: no set, so
	// everything counts as visible)
	visibleFrom(cluster: number): Uint8Array | null {
		if (cluster < 0 || cluster >= this.numClusters) return null;
		let set = this.sets.get(cluster);
		if (set) return set;
		// run-length coded: a zero byte is followed by how many zero bytes it stands for
		set = new Uint8Array((this.numClusters + 7) >> 3);
		let src = this.vis.getInt32(4 + cluster * 8, true);
		for (let out = 0; out < set.length && src < this.vis.byteLength;) {
			const b = this.vis.getUint8(src++);
			if (b) set[out++] = b;
			else out += src < this.vis.byteLength ? this.vis.getUint8(src++) : set.length;
		}
		this.sets.set(cluster, set);
		return set;
	}
}

// whether any of `clusters` is in a visible set (none known: it counts as
// visible)
export function anyVisible(set: Uint8Array, clusters: ArrayLike<number>): boolean {
	if (!clusters.length) return true;
	for (let i = 0; i < clusters.length; i++) {
		const c = clusters[i];
		if (c >= 0 && set[c >> 3] & (1 << (c & 7))) return true;
	}
	return false;
}
