// Studio models (.mdl + .vvd + .dx90.vtx): the triangles of LOD 0 of each
// body part's default model, in the model's own space. Bones are ignored, so
// animated models show in their reference pose.
import type {GameFiles} from './files.ts';
import type {MeshData} from './bsp.ts';

export interface StudioModel {
	mesh: MeshData;
	min: [number, number, number];
	max: [number, number, number];
}

const VVD_VERTEX = 48;

export async function loadModel(files: GameFiles, name: string, color: [number, number, number]): Promise<StudioModel | null> {
	const base = name.toLowerCase().replace(/\\/g, '/').replace(/\.mdl$/, '');
	const [mdl, vvd, vtx] = await Promise.all([files.read(`${base}.mdl`), files.read(`${base}.vvd`), files.read(`${base}.dx90.vtx`)]);
	if (!mdl || !vvd || !vtx) return null;
	const m = new DataView(mdl.buffer, mdl.byteOffset, mdl.byteLength);
	const d = new DataView(vvd.buffer, vvd.byteOffset, vvd.byteLength);
	const x = new DataView(vtx.buffer, vtx.byteOffset, vtx.byteLength);
	if (m.getUint32(0, true) !== 0x54534449 /* IDST */ || d.getUint32(0, true) !== 0x56534449 /* IDSV */) return null;

	const hull = (o: number): [number, number, number] => [m.getFloat32(o, true), m.getFloat32(o + 4, true), m.getFloat32(o + 8, true)];

	// VVD: LOD 0 vertices, through the fixup table when there is one
	const numFixups = d.getInt32(48, true);
	const fixupStart = d.getInt32(52, true);
	const vertexStart = d.getInt32(56, true);
	let vertexIds: number[] | null = null;
	if (numFixups > 0) {
		vertexIds = [];
		for (let i = 0; i < numFixups; i++) {
			const o = fixupStart + i * 12;
			if (d.getInt32(o, true) < 0) continue;
			const src = d.getInt32(o + 4, true), n = d.getInt32(o + 8, true);
			for (let k = 0; k < n; k++) vertexIds.push(src + k);
		}
	}
	const vertex = (i: number) => {
		const id = vertexIds ? vertexIds[i] : i;
		return vertexStart + id * VVD_VERTEX;
	};

	const pos: number[] = [], nrm: number[] = [], col: number[] = [];
	const bodyParts = m.getInt32(232, true), bodyPartOffset = m.getInt32(236, true);
	const vtxBodyParts = x.getInt32(28, true), vtxBodyPartOffset = x.getInt32(32, true);
	const stripGroupSize = guessStripGroupSize(x, vtxBodyPartOffset);

	for (let b = 0; b < Math.min(bodyParts, vtxBodyParts); b++) {
		const bp = bodyPartOffset + b * 16;
		const models = m.getInt32(bp + 4, true);
		if (!models) continue;
		const model = bp + m.getInt32(bp + 12, true);  // the first (default) model
		const meshes = m.getInt32(model + 72, true);
		const meshOffset = model + m.getInt32(model + 76, true);
		const modelVertexBase = m.getInt32(model + 84, true) / VVD_VERTEX;

		const vbp = vtxBodyPartOffset + b * 8;
		const vModel = vbp + x.getInt32(vbp + 4, true);
		const vLod = vModel + x.getInt32(vModel + 4, true);  // LOD 0
		const vMeshes = x.getInt32(vLod, true);
		const vMeshOffset = vLod + x.getInt32(vLod + 4, true);

		for (let mi = 0; mi < Math.min(meshes, vMeshes); mi++) {
			const mesh = meshOffset + mi * 116;
			const meshVertexBase = modelVertexBase + m.getInt32(mesh + 12, true);
			const vMesh = vMeshOffset + mi * 9;
			const groups = x.getInt32(vMesh, true);
			const groupOffset = vMesh + x.getInt32(vMesh + 4, true);
			for (let g = 0; g < groups; g++) {
				const sg = groupOffset + g * stripGroupSize;
				const numVerts = x.getInt32(sg, true), vertOffset = sg + x.getInt32(sg + 4, true);
				const numIndices = x.getInt32(sg + 8, true), indexOffset = sg + x.getInt32(sg + 12, true);
				for (let i = 0; i + 2 < numIndices; i += 3) {
					for (const k of [0, 2, 1]) {  // studio triangles wind clockwise
						const idx = x.getUint16(indexOffset + (i + k) * 2, true);
						if (idx >= numVerts) continue;
						const orig = x.getUint16(vertOffset + idx * 9 + 4, true);
						const vo = vertex(meshVertexBase + orig);
						if (vo + VVD_VERTEX > vvd.length) continue;
						pos.push(d.getFloat32(vo + 16, true), d.getFloat32(vo + 20, true), d.getFloat32(vo + 24, true));
						nrm.push(d.getFloat32(vo + 28, true), d.getFloat32(vo + 32, true), d.getFloat32(vo + 36, true));
						col.push(...color);
					}
				}
			}
		}
	}
	if (pos.length % 9) pos.length = nrm.length = col.length = pos.length - (pos.length % 9);
	if (!pos.length) return null;
	return {
		mesh: {positions: new Float32Array(pos), normals: new Float32Array(nrm), colors: new Float32Array(col)},
		min: hull(104), max: hull(116),
	};
}

// Strip group headers are 25 bytes, or 33 in files with topology data
// (newer branches). Pick the size whose first group has sane offsets.
function guessStripGroupSize(x: DataView, bodyPartOffset: number): number {
	try {
		const vModel = bodyPartOffset + x.getInt32(bodyPartOffset + 4, true);
		const vLod = vModel + x.getInt32(vModel + 4, true);
		const vMesh = vLod + x.getInt32(vLod + 4, true);
		const groups = x.getInt32(vMesh, true);
		if (groups < 2) return 25;
		const first = vMesh + x.getInt32(vMesh + 4, true);
		for (const size of [25, 33]) {
			const sg = first + size;
			const n = x.getInt32(sg, true), vo = x.getInt32(sg + 4, true), ni = x.getInt32(sg + 8, true);
			if (n > 0 && n < 65536 && ni > 0 && ni < 1 << 20 && sg + vo > 0 && sg + vo < x.byteLength) return size;
		}
	} catch {
		// fall through
	}
	return 25;
}
