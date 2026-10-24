// Source BSP (version 21, Portal 2) geometry: world faces, displacements and
// the brush models that brush entities (doors, elevators, panels) use.
import type {GameFS} from './gamefs.ts';
import type {MaterialInfo} from './materials.ts';

const LUMP = {
	ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13,
	MODELS: 14, DISPINFO: 26, DISP_VERTS: 33, GAME_LUMP: 35, PAKFILE: 40, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44,
} as const;

const SURF_SKY2D = 0x2, SURF_SKY = 0x4, SURF_TRIGGER = 0x40, SURF_NODRAW = 0x80, SURF_HINT = 0x100, SURF_SKIP = 0x200;
const SKIP_FLAGS = SURF_SKY2D | SURF_SKY | SURF_TRIGGER | SURF_NODRAW | SURF_HINT | SURF_SKIP;

export type Surface = 'portalable' | 'metal' | 'glass' | 'liquid' | 'other';

export interface MeshData {
	positions: Float32Array;
	normals: Float32Array;
	colors: Float32Array;
}

export interface ModelMesh {
	solid: MeshData;
	translucent: MeshData;  // glass, liquids
	edges: Float32Array;    // face outlines, as line segment pairs
}

export interface StaticProp {
	model: string;
	origin: [number, number, number];
	angles: [number, number, number];
	skin: number;
}

export interface BspMap {
	name: string;
	models: ModelMesh[];  // 0 = world
	staticProps: StaticProp[];
	materialsRead: number;  // surfaces coloured from their material files
	bounds: {min: [number, number, number]; max: [number, number, number]};
	faceCount: number;
	warnings: string[];
}

// Colours by texture name, for when a material file can't be read. Portal 2
// marks surfaces unportalable in their materials; the names are a close
// stand-in (white panels vs black metal).
export function classify(texture: string): Surface {
	const t = texture.toLowerCase();
	if (/glass|window|grate_glass|fizzler/.test(t)) return 'glass';
	if (/water|goo|slime|toxic/.test(t)) return 'liquid';
	if (/white|portal_?able/.test(t) && !/black|noportal/.test(t)) return 'portalable';
	if (/black|noportal/.test(t)) return 'metal';
	return 'other';
}

const SURFACE_COLORS: Record<Exclude<Surface, 'other'>, [number, number, number]> = {
	portalable: [0.9, 0.91, 0.89],
	metal: [0.2, 0.22, 0.25],
	glass: [0.55, 0.78, 0.95],
	liquid: [0.35, 0.42, 0.16],
};

// everything else: the texture's average colour (stored linear), toned down
// so it never competes with the portalable white
function textureColor(r: number, g: number, b: number): [number, number, number] {
	const c = (v: number) => Math.min(0.62, Math.max(0.12, Math.pow(Math.max(0, v), 1 / 2.2) * 0.75));
	return [c(r), c(g), c(b)];
}

// a touch of the texture's own colour, so surfaces of the same kind still
// differ (tiles vs concrete, painted vs bare metal)
function tint(base: [number, number, number], refl: number[], surface: Surface): [number, number, number] {
	if (surface !== 'portalable' && surface !== 'metal') return base;
	const t = textureColor(refl[0], refl[1], refl[2]);
	const k = surface === 'portalable' ? 0.18 : 0.3;
	return [base[0] * (1 - k) + t[0] * k, base[1] * (1 - k) + t[1] * k, base[2] * (1 - k) + t[2] * k];
}

class Builder {
	pos: number[] = [];
	nrm: number[] = [];
	col: number[] = [];

	// wound counter-clockwise around `facing` (the face's front), so
	// back faces can be culled
	tri(a: number[], b: number[], c: number[], color: [number, number, number], facing: number[]) {
		const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
		const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
		let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const l = Math.hypot(nx, ny, nz);
		if (l < 1e-6) return;
		nx /= l; ny /= l; nz /= l;
		if (nx * facing[0] + ny * facing[1] + nz * facing[2] < 0) {
			[b, c] = [c, b];
			nx = -nx; ny = -ny; nz = -nz;
		}
		this.pos.push(...a, ...b, ...c);
		for (let i = 0; i < 3; i++) {
			this.nrm.push(nx, ny, nz);
			this.col.push(...color);
		}
	}

	build(): MeshData {
		return {positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), colors: new Float32Array(this.col)};
	}
}

interface Lump {
	offset: number;
	length: number;
}

export interface BspOptions {
	// properties of every material the map's visible faces use; gets the
	// map's pak file first (maps carry their own patched materials)
	materials?: (names: string[], pak: Uint8Array | null) => Promise<Map<string, MaterialInfo>>;
}

export async function loadBsp(fs: GameFS, path: string, name: string, options: BspOptions = {}): Promise<BspMap> {
	const head = await fs.read(path, 0, 1036);
	if (!head) throw new Error(`${path} not found`);
	const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	if (String.fromCharCode(...head.subarray(0, 4)) !== 'VBSP') throw new Error(`${path} isn't a BSP`);
	const version = hv.getInt32(4, true);
	const fileSize = (await fs.size(path)) ?? Infinity;
	const lumps: Lump[] = [];
	for (let i = 0; i < 64; i++) {
		const o = 8 + i * 16;
		lumps.push({offset: hv.getInt32(o, true), length: hv.getInt32(o + 4, true)});
	}
	// L4D2-style headers put the version first
	if (lumps.some(l => l.length > 0 && (l.offset < 1036 || l.offset + l.length > fileSize))) {
		for (let i = 0; i < 64; i++) {
			const o = 8 + i * 16;
			lumps[i] = {offset: hv.getInt32(o + 4, true), length: hv.getInt32(o + 8, true)};
		}
	}

	const warnings: string[] = [];
	if (version !== 21) warnings.push(`BSP version ${version}; expected 21.`);
	const read = async (i: number) => {
		const l = lumps[i];
		if (!l.length) return new DataView(new ArrayBuffer(0));
		const b = (await fs.read(path, l.offset, l.length))!;
		if (b.length >= 4 && String.fromCharCode(...b.subarray(0, 4)) === 'LZMA') throw new Error('this map uses compressed lumps, which the viewer can\'t read yet');
		return new DataView(b.buffer, b.byteOffset, b.byteLength);
	};

	const [planes, texdata, verts, texinfo, faces, edges, surfedges, models, dispinfo, dispverts, strData, strTable] = await Promise.all(
		[LUMP.PLANES, LUMP.TEXDATA, LUMP.VERTEXES, LUMP.TEXINFO, LUMP.FACES, LUMP.EDGES, LUMP.SURFEDGES, LUMP.MODELS, LUMP.DISPINFO, LUMP.DISP_VERTS, LUMP.TEXDATA_STRING_DATA, LUMP.TEXDATA_STRING_TABLE].map(read),
	);

	const staticProps = await readStaticProps(fs, path, lumps[LUMP.GAME_LUMP], warnings);

	const vert = (i: number) => [verts.getFloat32(i * 12, true), verts.getFloat32(i * 12 + 4, true), verts.getFloat32(i * 12 + 8, true)];
	const textureName = (texinfoIndex: number) => {
		const td = texinfo.getInt32(texinfoIndex * 72 + 68, true);
		if (td < 0 || td * 32 >= texdata.byteLength) return '';
		const sid = texdata.getInt32(td * 32 + 12, true);
		const off = strTable.getInt32(sid * 4, true);
		let s = '';
		for (let i = off; i < strData.byteLength; i++) {
			const c = strData.getUint8(i);
			if (!c) break;
			s += String.fromCharCode(c);
		}
		return s;
	};
	const faceVerts = (f: number) => {
		const o = f * 56;
		const first = faces.getInt32(o + 4, true);
		const n = faces.getInt16(o + 8, true);
		const out: number[][] = [];
		for (let i = 0; i < n; i++) {
			const se = surfedges.getInt32((first + i) * 4, true);
			const e = Math.abs(se);
			out.push(vert(edges.getUint16(e * 4 + (se >= 0 ? 0 : 2), true)));
		}
		return out;
	};

	const nModels = models.byteLength / 48;
	const meshes: ModelMesh[] = [];
	let faceCount = 0;
	// resolve the materials of the faces that will be drawn
	const skipped = (ti: number) => {
		const lower = textureName(ti).toLowerCase();
		return (texinfo.getInt32(ti * 72 + 64, true) & SKIP_FLAGS) !== 0 || (lower.startsWith('tools/') && !lower.includes('toolsblack'));
	};
	let materials = new Map<string, MaterialInfo>();
	if (options.materials) {
		const names = new Set<string>();
		for (let ti = 0; ti < texinfo.byteLength / 72; ti++) if (!skipped(ti)) names.add(textureName(ti).toLowerCase());
		const pak = lumps[LUMP.PAKFILE].length ? await fs.read(path, lumps[LUMP.PAKFILE].offset, lumps[LUMP.PAKFILE].length) : null;
		try {
			materials = await options.materials([...names], pak);
		} catch (e) {
			warnings.push(`Couldn't read materials: ${(e as Error).message}`);
		}
	}
	let materialsRead = 0;

	const textureCache = new Map<number, {surface: Surface; skip: boolean; color: [number, number, number]}>();
	const texInfoOf = (ti: number) => {
		let v = textureCache.get(ti);
		if (!v) {
			const name = textureName(ti);
			const flags = texinfo.getInt32(ti * 72 + 64, true);
			const lower = name.toLowerCase();
			const mat = materials.get(lower);
			let surface: Surface;
			if (mat?.found) {
				materialsRead++;
				surface = mat.liquid ? 'liquid' : mat.translucent ? 'glass' : mat.noPortal ? 'metal' : 'portalable';
			} else {
				surface = classify(name);
			}
			const td = texinfo.getInt32(ti * 72 + 68, true);
			const refl = td >= 0 && td * 32 < texdata.byteLength ? [texdata.getFloat32(td * 32, true), texdata.getFloat32(td * 32 + 4, true), texdata.getFloat32(td * 32 + 8, true)] : [0.4, 0.4, 0.4];
			v = {
				surface,
				skip: (flags & SKIP_FLAGS) !== 0 || (lower.startsWith('tools/') && !lower.includes('toolsblack')),
				color: surface === 'other' ? textureColor(refl[0], refl[1], refl[2]) : tint(SURFACE_COLORS[surface], refl, surface),
			};
			textureCache.set(ti, v);
		}
		return v;
	};

	for (let m = 0; m < nModels; m++) {
		const firstFace = models.getInt32(m * 48 + 40, true);
		const numFaces = models.getInt32(m * 48 + 44, true);
		const solid = new Builder(), translucent = new Builder();
		const edgeList: number[] = [];
		for (let f = firstFace; f < firstFace + numFaces; f++) {
			const o = f * 56;
			const ti = faces.getInt16(o + 10, true);
			if (ti < 0) continue;
			const tex = texInfoOf(ti);
			if (tex.skip) continue;
			const target = tex.surface === 'glass' || tex.surface === 'liquid' ? translucent : solid;
			const color = tex.color;
			const disp = faces.getInt16(o + 12, true);
			const vs = faceVerts(f);
			const pn = faces.getUint16(o, true);
			const flip = faces.getUint8(o + 2) ? -1 : 1;
			const facing = [planes.getFloat32(pn * 20, true) * flip, planes.getFloat32(pn * 20 + 4, true) * flip, planes.getFloat32(pn * 20 + 8, true) * flip];
			for (let i = 0; i < vs.length; i++) edgeList.push(...vs[i], ...vs[(i + 1) % vs.length]);
			if (disp >= 0 && vs.length === 4) {
				buildDisplacement(target, vs, dispinfo, dispverts, disp, color, facing);
			} else {
				for (let i = 1; i + 1 < vs.length; i++) target.tri(vs[0], vs[i], vs[i + 1], color, facing);
			}
			faceCount++;
		}
		meshes.push({solid: solid.build(), translucent: translucent.build(), edges: new Float32Array(edgeList)});
	}

	const b = (i: number) => models.getFloat32(i, true);
	return {
		name, models: meshes, staticProps, materialsRead, faceCount, warnings,
		bounds: {min: [b(0), b(4), b(8)], max: [b(12), b(16), b(20)]},
	};
}

function buildDisplacement(out: Builder, corners: number[][], info: DataView, dverts: DataView, index: number, color: [number, number, number], facing: number[]) {
	const o = index * 176;
	const start = [info.getFloat32(o, true), info.getFloat32(o + 4, true), info.getFloat32(o + 8, true)];
	const vertStart = info.getInt32(o + 12, true);
	const power = info.getInt32(o + 20, true);
	const size = (1 << power) + 1;

	// the corner nearest the start position comes first
	let first = 0, best = Infinity;
	corners.forEach((c, i) => {
		const d = Math.hypot(c[0] - start[0], c[1] - start[1], c[2] - start[2]);
		if (d < best) {
			best = d;
			first = i;
		}
	});
	const c = [0, 1, 2, 3].map(i => corners[(first + i) % 4]);
	const lerp = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

	const grid: number[][] = [];
	for (let y = 0; y < size; y++) {
		const t = y / (size - 1);
		const left = lerp(c[0], c[1], t), right = lerp(c[3], c[2], t);
		for (let x = 0; x < size; x++) {
			const base = lerp(left, right, x / (size - 1));
			const vo = (vertStart + y * size + x) * 20;
			const dist = dverts.getFloat32(vo + 12, true);
			grid.push([
				base[0] + dverts.getFloat32(vo, true) * dist,
				base[1] + dverts.getFloat32(vo + 4, true) * dist,
				base[2] + dverts.getFloat32(vo + 8, true) * dist,
			]);
		}
	}
	for (let y = 0; y < size - 1; y++) {
		for (let x = 0; x < size - 1; x++) {
			const a = grid[y * size + x], b = grid[y * size + x + 1], d = grid[(y + 1) * size + x], e = grid[(y + 1) * size + x + 1];
			if ((x + y) % 2) {
				out.tri(a, d, b, color, facing);
				out.tri(b, d, e, color, facing);
			} else {
				out.tri(a, d, e, color, facing);
				out.tri(a, e, b, color, facing);
			}
		}
	}
}

// Static props: the game lump's "sprp" entry. Entries grew over versions;
// the origin, angles and model index sit at the start of all of them.
async function readStaticProps(fs: GameFS, path: string, lump: {offset: number; length: number}, warnings: string[]): Promise<StaticProp[]> {
	if (lump.length < 4) return [];
	const gl = await fs.read(path, lump.offset, lump.length);
	if (!gl) return [];
	const g = new DataView(gl.buffer, gl.byteOffset, gl.byteLength);
	const count = g.getInt32(0, true);
	for (let i = 0; i < count; i++) {
		const o = 4 + i * 16;
		if (g.getUint32(o, true) !== 0x73707270) continue;  // 'sprp'
		const flags = g.getUint16(o + 4, true);
		const offset = g.getInt32(o + 8, true), length = g.getInt32(o + 12, true);
		if (flags & 1) {
			warnings.push("Static props are compressed in this map, so they aren't shown.");
			return [];
		}
		const b = await fs.read(path, offset, length);
		if (!b) return [];
		const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
		let p = 0;
		const dict: string[] = [];
		const nDict = v.getInt32(p, true);
		p += 4;
		for (let k = 0; k < nDict; k++, p += 128) {
			const raw = b.subarray(p, p + 128);
			const end = raw.indexOf(0);
			dict.push(String.fromCharCode(...raw.subarray(0, end < 0 ? 128 : end)));
		}
		p += 4 + v.getInt32(p, true) * 2;  // leaves
		const nProps = v.getInt32(p, true);
		p += 4;
		const size = nProps ? Math.floor((b.length - p) / nProps) : 0;
		const props: StaticProp[] = [];
		for (let k = 0; k < nProps; k++, p += size) {
			const f = (o: number) => v.getFloat32(p + o, true);
			props.push({
				origin: [f(0), f(4), f(8)],
				angles: [f(12), f(16), f(20)],
				model: dict[v.getUint16(p + 24, true)] ?? '',
				skin: size >= 36 ? v.getInt32(p + 32, true) : 0,
			});
		}
		return props;
	}
	return [];
}
