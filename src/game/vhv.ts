// Static prop vertex lighting (.vhv, in a map's pak file as sp_hdr_<n>.vhv or
// sp_<n>.vhv): vrad's light at every vertex of each LOD 0 mesh, as BGR bytes
// (gamma-encoded and halved: linear^(1/2.2) x 0.5) and the sun's share in A.

export interface VertexLighting {
	checksum: number;            // the model's
	meshes: (Uint8Array | null)[];  // BGRA per vertex, by mesh number
}

export function readVhv(bytes: Uint8Array): VertexLighting | null {
	if (bytes.length < 40) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getInt32(0, true) !== 2) return null;
	const checksum = v.getUint32(4, true);
	const vertexSize = v.getUint32(12, true);
	const numMeshes = v.getInt32(20, true);
	if (vertexSize !== 4) return null;
	const meshes: (Uint8Array | null)[] = [];
	let n = 0;
	for (let i = 0; i < numMeshes; i++) {
		const o = 40 + i * 28;
		const lod = v.getUint32(o, true), count = v.getUint32(o + 4, true), offset = v.getUint32(o + 8, true);
		if (lod !== 0) continue;
		meshes[n++] = offset + count * 4 <= bytes.length ? bytes.subarray(offset, offset + count * 4) : null;
	}
	return {checksum, meshes};
}
