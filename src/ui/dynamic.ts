// Geometry rewritten every frame (particle quads, sprites, bridges): the
// same buffers refilled, grown only when they're too small. A replaced
// attribute's GPU buffer is only freed when its geometry is disposed, so
// growing disposes it first (three uploads everything again on next draw).
import * as THREE from 'three';

// writes `data` into the geometry's attribute `name`; returns how many
// items it holds
export function writeAttribute(g: THREE.BufferGeometry, name: string, data: ArrayLike<number>, itemSize: number): number {
	let a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
	if (!a || a.itemSize !== itemSize || a.array.length < data.length) {
		if (a) g.dispose();
		let size = 64 * itemSize;
		while (size < data.length) size *= 2;
		a = new THREE.BufferAttribute(new Float32Array(size), itemSize).setUsage(THREE.DynamicDrawUsage);
		g.setAttribute(name, a);
	}
	(a.array as Float32Array).set(data);
	a.clearUpdateRanges();
	a.addUpdateRange(0, data.length);
	a.needsUpdate = true;
	return data.length / itemSize;
}
