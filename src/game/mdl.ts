// Studio models (.mdl + .vvd + .dx90.vtx): the triangles of LOD 0 of each
// body part's default model, in the model's own space, grouped by material
// for the chosen skin. Bones are ignored, so animated models show in their
// reference pose.
import type {GameFiles} from './files.ts';
import type {MeshData} from './bsp.ts';

export interface ModelGroup extends MeshData {
	// where the material can be: each $cdmaterials folder + the texture name
	materialCandidates: string[];
	// for static prop vertex lighting: per vertex, the studio mesh number
	// (times 2^20) plus the index of the vertex in that mesh's hardware vertex
	// list (its strip groups' vertices in order), which the lighting follows
	meshVertex: Uint32Array;
}

export interface StudioModel {
	groups: ModelGroup[];
	min: [number, number, number];
	max: [number, number, number];
	meshes: {vertexCount: number}[];  // the drawn studio meshes, by their number in .vhv files
	checksum: number;
}

const VVD_VERTEX = 48;

function cstr(b: Uint8Array, at: number) {
	let end = at;
	while (end < b.length && b[end]) end++;
	return String.fromCharCode(...b.subarray(at, end));
}

export async function loadModel(files: GameFiles, name: string, color: [number, number, number], skin = 0): Promise<StudioModel | null> {
	const base = name.toLowerCase().replace(/\\/g, '/').replace(/\.mdl$/, '');
	const [mdl, vvd, vtx] = await Promise.all([files.read(`${base}.mdl`), files.read(`${base}.vvd`), files.read(`${base}.dx90.vtx`)]);
	if (!mdl || !vvd || !vtx) return null;
	const m = new DataView(mdl.buffer, mdl.byteOffset, mdl.byteLength);
	const d = new DataView(vvd.buffer, vvd.byteOffset, vvd.byteLength);
	const x = new DataView(vtx.buffer, vtx.byteOffset, vtx.byteLength);
	if (m.getUint32(0, true) !== 0x54534449 /* IDST */ || d.getUint32(0, true) !== 0x56534449 /* IDSV */) return null;

	const hull = (o: number): [number, number, number] => [m.getFloat32(o, true), m.getFloat32(o + 4, true), m.getFloat32(o + 8, true)];

	// textures, material folders and the skin table
	const texCount = m.getInt32(204, true), texOffset = m.getInt32(208, true);
	const textures: string[] = [];
	for (let i = 0; i < texCount; i++) {
		const t = texOffset + i * 64;
		textures.push(cstr(mdl, t + m.getInt32(t, true)).toLowerCase().replace(/\\/g, '/'));
	}
	const dirCount = m.getInt32(212, true), dirOffset = m.getInt32(216, true);
	const dirs: string[] = [];
	for (let i = 0; i < dirCount; i++) dirs.push(cstr(mdl, m.getInt32(dirOffset + i * 4, true)).toLowerCase().replace(/\\/g, '/'));
	const skinRefs = m.getInt32(220, true), skinFamilies = m.getInt32(224, true), skinIndex = m.getInt32(228, true);
	const family = skin >= 0 && skin < skinFamilies ? skin : 0;
	const textureFor = (ref: number) => (ref < skinRefs && skinFamilies > 0 ? m.getInt16(skinIndex + (family * skinRefs + ref) * 2, true) : ref);
	const candidates = (ref: number) => {
		const tex = textures[textureFor(ref)] ?? '';
		const cds = dirs.length ? dirs : [''];
		// texture names can carry their own folder; try them bare as well
		return [...new Set([...cds.map(cd => (cd && !cd.endsWith('/') ? `${cd}/` : cd) + tex), tex])];
	};

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
	const vertex = (i: number) => vertexStart + (vertexIds ? vertexIds[i] : i) * VVD_VERTEX;

	const groups = new Map<number, {pos: number[]; nrm: number[]; col: number[]; uv: number[]; mv: number[]}>();
	const meshList: {vertexCount: number}[] = [];
	const bodyParts = m.getInt32(232, true), bodyPartOffset = m.getInt32(236, true);
	const vtxBodyParts = x.getInt32(28, true), vtxBodyPartOffset = x.getInt32(32, true);
	const stripGroupSize = guessStripGroupSize(x, vtxBodyPartOffset);

	// vertex lighting files number meshes across every model of every body
	// part, so count them all even though only the default model is drawn
	let meshNumber = 0;
	for (let b = 0; b < Math.min(bodyParts, vtxBodyParts); b++) {
		const bp = bodyPartOffset + b * 16;
		const models = m.getInt32(bp + 4, true);
		if (!models) continue;
		const firstMesh = meshNumber;
		for (let k = 0; k < models; k++) meshNumber += m.getInt32(bp + m.getInt32(bp + 12, true) + k * 148 + 72, true);
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
			const ref = m.getInt32(mesh, true);
			const meshVertexBase = modelVertexBase + m.getInt32(mesh + 12, true);
			const meshListIndex = firstMesh + mi;
			let g = groups.get(ref);
			if (!g) {
				g = {pos: [], nrm: [], col: [], uv: [], mv: []};
				groups.set(ref, g);
			}
			const vMesh = vMeshOffset + mi * 9;
			const nGroups = x.getInt32(vMesh, true);
			const groupOffset = vMesh + x.getInt32(vMesh + 4, true);
			let hwBase = 0;  // hardware vertices of the strip groups before this one
			for (let sgi = 0; sgi < nGroups; sgi++, hwBase += x.getInt32(groupOffset + (sgi - 1) * stripGroupSize, true)) {
				const sg = groupOffset + sgi * stripGroupSize;
				const numVerts = x.getInt32(sg, true), vertOffset = sg + x.getInt32(sg + 4, true);
				const numIndices = x.getInt32(sg + 8, true), indexOffset = sg + x.getInt32(sg + 12, true);
				for (let i = 0; i + 2 < numIndices; i += 3) {
					const tri: number[] = [];
					for (const k of [0, 2, 1]) {  // studio triangles wind clockwise
						const idx = x.getUint16(indexOffset + (i + k) * 2, true);
						if (idx >= numVerts) break;
						tri.push(idx);
					}
					if (tri.length < 3) continue;
					for (const idx of tri) {
						const orig = x.getUint16(vertOffset + idx * 9 + 4, true);
						const vo = vertex(meshVertexBase + orig);
						g.pos.push(d.getFloat32(vo + 16, true), d.getFloat32(vo + 20, true), d.getFloat32(vo + 24, true));
						g.nrm.push(d.getFloat32(vo + 28, true), d.getFloat32(vo + 32, true), d.getFloat32(vo + 36, true));
						g.uv.push(d.getFloat32(vo + 40, true), d.getFloat32(vo + 44, true));
						g.col.push(...color);
						g.mv.push(meshListIndex * 1048576 + hwBase + idx);
					}
				}
			}
			meshList[meshListIndex] = {vertexCount: hwBase};
		}
	}

	const out: ModelGroup[] = [];
	for (const [ref, g] of groups) {
		if (!g.pos.length) continue;
		out.push({
			materialCandidates: candidates(ref),
			positions: new Float32Array(g.pos), normals: new Float32Array(g.nrm), colors: new Float32Array(g.col),
			uv: new Float32Array(g.uv), meshVertex: new Uint32Array(g.mv),
		});
	}
	if (!out.length) return null;
	return {groups: out, min: hull(104), max: hull(116), meshes: meshList, checksum: m.getUint32(8, true)};
}

// Strip group headers are 25 bytes, or 33 in files with topology data
// (newer branches). Pick the size whose second group has sane offsets.
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
