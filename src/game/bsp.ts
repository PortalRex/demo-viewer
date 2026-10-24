// Source BSP (version 21, Portal 2): world faces, displacements and the brush
// models brush entities use (doors, elevators, panels), with texture and
// lightmap coordinates; the baked lighting packed into one atlas; static props.
import type {GameFS} from './gamefs.ts';
import type {MaterialInfo} from './materials.ts';

const LUMP = {
	ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, TEXINFO: 6, FACES: 7, LIGHTING: 8, EDGES: 12, SURFEDGES: 13,
	MODELS: 14, DISPINFO: 26, DISP_VERTS: 33, GAME_LUMP: 35, PAKFILE: 40, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44,
	LIGHTING_HDR: 53, FACES_HDR: 58,
} as const;

const SURF_SKY2D = 0x2, SURF_SKY = 0x4, SURF_TRIGGER = 0x40, SURF_NODRAW = 0x80, SURF_HINT = 0x100, SURF_SKIP = 0x200;
const SURF_NOLIGHT = 0x400, SURF_BUMPLIGHT = 0x800;
const SKIP_FLAGS = SURF_SKY2D | SURF_SKY | SURF_TRIGGER | SURF_NODRAW | SURF_HINT | SURF_SKIP;

export type Surface = 'portalable' | 'metal' | 'glass' | 'liquid' | 'other';

// One material's triangles. `uv` is in texture repeats, `lightUv` in the
// lightmap atlas (0..1); `colors` are the flat fallback.
export interface MeshData {
	positions: Float32Array;
	normals: Float32Array;
	colors: Float32Array;
	uv?: Float32Array;
	lightUv?: Float32Array;
}

export interface MaterialGroup extends MeshData {
	material: string;    // lower case, under materials/
	surface: Surface;
}

export interface ModelMesh {
	groups: MaterialGroup[];
	edges: Float32Array;  // face outlines, as line segment pairs
}

// One light style's luxels for one face block (with its 1-luxel border),
// linear RGB. A face can have up to four styles: 0 is the always-on light,
// 32 and up are named lights the map switches.
export interface LightmapLayer {
	style: number;
	rgb: Float32Array;
}

export interface LightmapBlock {
	x: number;  // atlas position of the border's corner
	y: number;
	w: number;  // with the border
	h: number;
	layers: LightmapLayer[];
}

export interface Lightmap {
	width: number;
	height: number;
	data: Float32Array;  // RGBA, linear: the layers summed at the current style values
	blocks: LightmapBlock[];
	styles: number[];    // the switchable styles in use (not 0)
}

// Sums the blocks' layers at the given style values (0 = off, 1 = normal).
// `only`: just the blocks using one of these styles. Returns the blocks
// written.
export function composeLightmap(lm: Lightmap, value: (style: number) => number, only?: Set<number>): LightmapBlock[] {
	const done: LightmapBlock[] = [];
	for (const b of lm.blocks) {
		if (only && !b.layers.some(l => only.has(l.style))) continue;
		const scale = b.layers.map(l => value(l.style));
		for (let y = 0; y < b.h; y++) {
			for (let x = 0; x < b.w; x++) {
				const i = y * b.w + x, o = ((b.y + y) * lm.width + b.x + x) * 4;
				let r = 0, g = 0, bl = 0;
				for (let k = 0; k < b.layers.length; k++) {
					const s = scale[k];
					if (!s) continue;
					const rgb = b.layers[k].rgb;
					r += rgb[i * 3] * s;
					g += rgb[i * 3 + 1] * s;
					bl += rgb[i * 3 + 2] * s;
				}
				lm.data[o] = r;
				lm.data[o + 1] = g;
				lm.data[o + 2] = bl;
				lm.data[o + 3] = 1;
			}
		}
		done.push(b);
	}
	return done;
}

// A light style's brightness from its pattern ('a' dark .. 'm' normal ..
// 'z' double), animated at 10 letters a second as the engine does
export function styleValue(pattern: string, time: number): number {
	if (!pattern) return 0;
	const c = pattern.charCodeAt(Math.floor(time * 10) % pattern.length) - 97;
	return Math.max(0, c) * 22 / 264;
}

export interface StaticProp {
	model: string;
	origin: [number, number, number];
	angles: [number, number, number];
	skin: number;
	index: number;  // in the map's list (its vertex lighting file is sp_hdr_<index>.vhv)
}

// A lit world face, for painting: where its luxels are in the lightmap atlas
// and how world positions map onto them
export interface PaintFace {
	x: number;          // block position in the atlas (luxel 0,0)
	y: number;
	w: number;          // luxels
	h: number;
	mins: [number, number];
	lmVecs: number[];   // lightmap s/t vectors (2 x 4)
	normal: [number, number, number];
	dist: number;
	center: [number, number, number];
	radius: number;     // bounding sphere of its vertices
}

export interface BspMap {
	name: string;
	paintFaces: Map<number, PaintFace>;  // by face index (= the engine's surface index)
	models: ModelMesh[];  // 0 = world
	staticProps: StaticProp[];
	lightmap: Lightmap | null;
	entities: Record<string, string>[];
	materials: Map<string, MaterialInfo>;
	pak: Uint8Array | null;
	materialsRead: number;
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

// a texture's average colour (stored linear), toned down so it never
// competes with the portalable white
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

interface Vert {
	p: number[];
	uv: [number, number];
	lm: [number, number];
}

class Builder {
	pos: number[] = [];
	nrm: number[] = [];
	col: number[] = [];
	uv: number[] = [];
	lm: number[] = [];

	// wound counter-clockwise around `facing` (the face's front), so back
	// faces can be culled
	tri(a: Vert, b: Vert, c: Vert, color: [number, number, number], facing: number[]) {
		const ux = b.p[0] - a.p[0], uy = b.p[1] - a.p[1], uz = b.p[2] - a.p[2];
		const vx = c.p[0] - a.p[0], vy = c.p[1] - a.p[1], vz = c.p[2] - a.p[2];
		let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const l = Math.hypot(nx, ny, nz);
		if (l < 1e-6) return;
		nx /= l; ny /= l; nz /= l;
		if (nx * facing[0] + ny * facing[1] + nz * facing[2] < 0) {
			[b, c] = [c, b];
			nx = -nx; ny = -ny; nz = -nz;
		}
		for (const v of [a, b, c]) {
			this.pos.push(v.p[0], v.p[1], v.p[2]);
			this.nrm.push(nx, ny, nz);
			this.col.push(...color);
			this.uv.push(v.uv[0], v.uv[1]);
			this.lm.push(v.lm[0], v.lm[1]);
		}
	}

	get empty() {
		return this.pos.length === 0;
	}
}

// Shelf packing of lightmap blocks into one atlas
class AtlasPacker {
	width: number;
	height = 0;
	private x = 0;
	private y = 0;
	private rowH = 0;

	constructor(width: number) {
		this.width = width;
	}

	place(w: number, h: number): [number, number] {
		if (this.x + w > this.width) {
			this.y += this.rowH;
			this.x = 0;
			this.rowH = 0;
		}
		const at: [number, number] = [this.x, this.y];
		this.x += w;
		this.rowH = Math.max(this.rowH, h);
		this.height = Math.max(this.height, this.y + this.rowH);
		return at;
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

function parseEntities(text: string): Record<string, string>[] {
	const out: Record<string, string>[] = [];
	const re = /\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const e: Record<string, string> = {};
		const kv = /"([^"]*)"\s*"([^"]*)"/g;
		let k: RegExpExecArray | null;
		while ((k = kv.exec(m[1]))) e[k[1].toLowerCase()] = k[2];
		out.push(e);
	}
	return out;
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
	const readBytes = async (i: number) => {
		const l = lumps[i];
		if (!l.length) return new Uint8Array(0);
		const b = (await fs.read(path, l.offset, l.length))!;
		if (b.length >= 4 && String.fromCharCode(...b.subarray(0, 4)) === 'LZMA') throw new Error('this map uses compressed lumps, which the viewer can\'t read yet');
		return b;
	};
	const read = async (i: number) => {
		const b = await readBytes(i);
		return new DataView(b.buffer, b.byteOffset, b.byteLength);
	};

	// HDR lighting when the map has it (Portal 2's maps only have HDR)
	const hdr = lumps[LUMP.LIGHTING_HDR].length > 0;
	const [planes, texdata, verts, texinfo, ldrFaces, hdrFaces, edges, surfedges, models, dispinfo, dispverts, strData, strTable, lighting] = await Promise.all([
		read(LUMP.PLANES), read(LUMP.TEXDATA), read(LUMP.VERTEXES), read(LUMP.TEXINFO), read(LUMP.FACES), read(LUMP.FACES_HDR),
		read(LUMP.EDGES), read(LUMP.SURFEDGES), read(LUMP.MODELS), read(LUMP.DISPINFO), read(LUMP.DISP_VERTS),
		read(LUMP.TEXDATA_STRING_DATA), read(LUMP.TEXDATA_STRING_TABLE), read(hdr ? LUMP.LIGHTING_HDR : LUMP.LIGHTING),
	]);
	const faces = ldrFaces.byteLength ? ldrFaces : hdrFaces;
	const lightFaces = hdr && hdrFaces.byteLength === faces.byteLength ? hdrFaces : faces;
	const entities = parseEntities(new TextDecoder('latin1').decode(await readBytes(LUMP.ENTITIES)));
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

	// resolve the materials of the faces that will be drawn
	const skipped = (ti: number) => {
		const lower = textureName(ti).toLowerCase();
		return (texinfo.getInt32(ti * 72 + 64, true) & SKIP_FLAGS) !== 0 || (lower.startsWith('tools/') && !lower.includes('toolsblack'));
	};
	let materials = new Map<string, MaterialInfo>();
	const pak = lumps[LUMP.PAKFILE].length ? await fs.read(path, lumps[LUMP.PAKFILE].offset, lumps[LUMP.PAKFILE].length) : null;
	if (options.materials) {
		const names = new Set<string>();
		for (let ti = 0; ti < texinfo.byteLength / 72; ti++) if (!skipped(ti)) names.add(textureName(ti).toLowerCase());
		try {
			materials = await options.materials([...names], pak);
		} catch (e) {
			warnings.push(`Couldn't read materials: ${(e as Error).message}`);
		}
	}
	let materialsRead = 0;

	interface TexInfo {
		material: string;
		surface: Surface;
		skip: boolean;
		color: [number, number, number];
		vecs: number[];      // texture s/t vectors (2 x 4)
		lmVecs: number[];    // lightmap s/t vectors (2 x 4)
		size: [number, number];
		lit: boolean;
	}
	const texCache = new Map<number, TexInfo>();
	const texInfoOf = (ti: number): TexInfo => {
		let v = texCache.get(ti);
		if (v) return v;
		const name = textureName(ti);
		const o = ti * 72;
		const flags = texinfo.getInt32(o + 64, true);
		const lower = name.toLowerCase();
		const mat = materials.get(lower);
		let surface: Surface;
		if (mat?.found) {
			materialsRead++;
			surface = mat.liquid ? 'liquid' : mat.translucent ? 'glass' : mat.noPortal ? 'metal' : 'portalable';
		} else {
			surface = classify(name);
		}
		const td = texinfo.getInt32(o + 68, true);
		const hasTd = td >= 0 && td * 32 < texdata.byteLength;
		const refl = hasTd ? [texdata.getFloat32(td * 32, true), texdata.getFloat32(td * 32 + 4, true), texdata.getFloat32(td * 32 + 8, true)] : [0.4, 0.4, 0.4];
		const floats = (start: number) => Array.from({length: 8}, (_, i) => texinfo.getFloat32(o + start + i * 4, true));
		v = {
			material: lower,
			surface,
			skip: skipped(ti),
			color: surface === 'other' ? textureColor(refl[0], refl[1], refl[2]) : tint(SURFACE_COLORS[surface], refl, surface),
			vecs: floats(0),
			lmVecs: floats(32),
			size: hasTd ? [texdata.getInt32(td * 32 + 16, true) || 1, texdata.getInt32(td * 32 + 20, true) || 1] : [1, 1],
			lit: !(flags & SURF_NOLIGHT),
		};
		texCache.set(ti, v);
		return v;
	};

	// ---- lightmap atlas ----
	// Each lit face has a block of (size + 1) luxels per axis (ColorRGBExp32,
	// the first of four for bump-mapped faces). Blocks get a 1-luxel border
	// copied from their edge so filtering doesn't bleed; the top-left corner
	// is white for unlit faces.
	const nFaces = faces.byteLength / 56;
	const packer = new AtlasPacker(2048);
	const WHITE: [number, number] = [1, 1];
	packer.place(4, 4);
	const blocks = new Map<number, {x: number; y: number; w: number; h: number; mins: [number, number]}>();
	if (lighting.byteLength) {
		const order: number[] = [];
		for (let f = 0; f < nFaces; f++) {
			const o = f * 56;
			const ti = faces.getInt16(o + 10, true);
			if (ti < 0 || lightFaces.getInt32(o + 20, true) < 0) continue;
			const tex = texInfoOf(ti);
			if (tex.skip || !tex.lit) continue;
			order.push(f);
		}
		order.sort((a, b) => lightFaces.getInt32(b * 56 + 40, true) - lightFaces.getInt32(a * 56 + 40, true));
		for (const f of order) {
			const o = f * 56;
			const w = lightFaces.getInt32(o + 36, true) + 1, h = lightFaces.getInt32(o + 40, true) + 1;
			if (w <= 0 || h <= 0 || w > 512 || h > 512) continue;
			const [x, y] = packer.place(w + 2, h + 2);
			blocks.set(f, {x: x + 1, y: y + 1, w, h, mins: [lightFaces.getInt32(o + 28, true), lightFaces.getInt32(o + 32, true)]});
		}
	}
	let lightmap: Lightmap | null = null;
	if (blocks.size) {
		const W = packer.width, H = Math.max(4, packer.height);
		const data = new Float32Array(W * H * 4);
		for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) data.set([1, 1, 1, 1], (y * W + x) * 4);
		const lmBlocks: LightmapBlock[] = [];
		const styleSet = new Set<number>();
		// until a recording says otherwise: named lights as the map starts
		// them (spawnflag 1 = initially dark)
		const initial = new Map<number, number>();
		for (const e of entities) {
			const st = Number(e.style);
			if (/^light/.test(e.classname ?? '') && st >= 32) initial.set(st, Number(e.spawnflags) & 1 ? 0 : styleValue(e.pattern || 'm', 0));
		}
		const defaultStyle = (st: number) => initial.get(st) ?? 1;
		const lbytes = new Uint8Array(lighting.buffer, lighting.byteOffset, lighting.byteLength);
		for (const [f, b] of blocks) {
			const o = f * 56;
			const base = lightFaces.getInt32(o + 20, true);
			// each style's samples follow the previous style's (four sets
			// for bump-mapped faces: flat first, then the three bump bases)
			const ti = faces.getInt16(o + 10, true);
			const perStyle = b.w * b.h * ((texinfo.getInt32(ti * 72 + 64, true) & SURF_BUMPLIGHT) ? 4 : 1) * 4;
			const layers: LightmapLayer[] = [];
			for (let k = 0; k < 4; k++) {
				const style = lightFaces.getUint8(o + 16 + k);
				if (style === 255) break;
				const start = base + k * perStyle;
				const rgb = new Float32Array((b.w + 2) * (b.h + 2) * 3);
				for (let y = -1; y <= b.h; y++) {
					for (let x = -1; x <= b.w; x++) {
						const i = start + (Math.min(b.h - 1, Math.max(0, y)) * b.w + Math.min(b.w - 1, Math.max(0, x))) * 4;
						if (i + 4 > lbytes.length) continue;
						const e = 2 ** ((lbytes[i + 3] << 24) >> 24) / 255;
						const j = ((y + 1) * (b.w + 2) + x + 1) * 3;
						rgb[j] = lbytes[i] * e;
						rgb[j + 1] = lbytes[i + 1] * e;
						rgb[j + 2] = lbytes[i + 2] * e;
					}
				}
				layers.push({style, rgb});
				if (style) styleSet.add(style);
			}
			lmBlocks.push({x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2, layers});
		}
		lightmap = {width: W, height: H, data, blocks: lmBlocks, styles: [...styleSet]};
		composeLightmap(lightmap, defaultStyle);
	}

	// faces that can carry paint: lit world faces (model 0)
	const paintFaces = new Map<number, PaintFace>();
	{
		const first = models.getInt32(40, true), count = models.getInt32(44, true);
		for (let f = first; f < first + count; f++) {
			const b = blocks.get(f);
			if (!b) continue;
			const o = f * 56;
			const tex = texInfoOf(faces.getInt16(o + 10, true));
			const vs = faceVerts(f);
			const c: [number, number, number] = [0, 0, 0];
			for (const v of vs) for (let k = 0; k < 3; k++) c[k] += v[k] / vs.length;
			const radius = Math.max(...vs.map(v => Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2])));
			const pn = faces.getUint16(o, true);
			const flip = faces.getUint8(o + 2) ? -1 : 1;
			const n: [number, number, number] = [planes.getFloat32(pn * 20, true) * flip, planes.getFloat32(pn * 20 + 4, true) * flip, planes.getFloat32(pn * 20 + 8, true) * flip];
			paintFaces.set(f, {x: b.x, y: b.y, w: b.w, h: b.h, mins: b.mins, lmVecs: tex.lmVecs, normal: n, dist: planes.getFloat32(pn * 20 + 12, true) * flip, center: c, radius});
		}
	}

	const vertexFor = (p: number[], tex: TexInfo, f: number, base = p): Vert => {
		const tv = tex.vecs, lv = tex.lmVecs;
		const uv: [number, number] = [
			(base[0] * tv[0] + base[1] * tv[1] + base[2] * tv[2] + tv[3]) / tex.size[0],
			(base[0] * tv[4] + base[1] * tv[5] + base[2] * tv[6] + tv[7]) / tex.size[1],
		];
		let lm: [number, number] = [WHITE[0] / (lightmap?.width ?? 4), WHITE[1] / (lightmap?.height ?? 4)];
		const b = blocks.get(f);
		if (b && lightmap) {
			const s = base[0] * lv[0] + base[1] * lv[1] + base[2] * lv[2] + lv[3] - b.mins[0];
			const t = base[0] * lv[4] + base[1] * lv[5] + base[2] * lv[6] + lv[7] - b.mins[1];
			lm = [(b.x + s + 0.5) / lightmap.width, (b.y + t + 0.5) / lightmap.height];
		}
		return {p, uv, lm};
	};

	const nModels = models.byteLength / 48;
	const meshes: ModelMesh[] = [];
	let faceCount = 0;

	for (let m = 0; m < nModels; m++) {
		const firstFace = models.getInt32(m * 48 + 40, true);
		const numFaces = models.getInt32(m * 48 + 44, true);
		const groups = new Map<string, {tex: TexInfo; b: Builder}>();
		const edgeList: number[] = [];
		for (let f = firstFace; f < firstFace + numFaces; f++) {
			const o = f * 56;
			const ti = faces.getInt16(o + 10, true);
			if (ti < 0) continue;
			const tex = texInfoOf(ti);
			if (tex.skip) continue;
			// one group per material (the texture size can differ per texinfo,
			// but uv is divided by the material's own texture size later)
			let g = groups.get(tex.material);
			if (!g) {
				g = {tex, b: new Builder()};
				groups.set(tex.material, g);
			}
			const disp = faces.getInt16(o + 12, true);
			const vs = faceVerts(f);
			const pn = faces.getUint16(o, true);
			const flip = faces.getUint8(o + 2) ? -1 : 1;
			const facing = [planes.getFloat32(pn * 20, true) * flip, planes.getFloat32(pn * 20 + 4, true) * flip, planes.getFloat32(pn * 20 + 8, true) * flip];
			for (let i = 0; i < vs.length; i++) edgeList.push(...vs[i], ...vs[(i + 1) % vs.length]);
			if (disp >= 0 && vs.length === 4) {
				buildDisplacement(g.b, vs, dispinfo, dispverts, disp, tex.color, facing, (p, base) => vertexFor(p, tex, f, base));
			} else {
				const vv = vs.map(p => vertexFor(p, tex, f));
				for (let i = 1; i + 1 < vv.length; i++) g.b.tri(vv[0], vv[i], vv[i + 1], tex.color, facing);
			}
			faceCount++;
		}
		const out: MaterialGroup[] = [];
		for (const [material, {tex, b}] of groups) {
			if (b.empty) continue;
			out.push({
				material, surface: tex.surface,
				positions: new Float32Array(b.pos), normals: new Float32Array(b.nrm), colors: new Float32Array(b.col),
				uv: new Float32Array(b.uv), lightUv: new Float32Array(b.lm),
			});
		}
		meshes.push({groups: out, edges: new Float32Array(edgeList)});
	}

	const b = (i: number) => models.getFloat32(i, true);
	return {
		name, models: meshes, staticProps, lightmap, paintFaces, entities, materials, pak, materialsRead, faceCount, warnings,
		bounds: {min: [b(0), b(4), b(8)], max: [b(12), b(16), b(20)]},
	};
}

function buildDisplacement(out: Builder, corners: number[][], info: DataView, dverts: DataView, index: number,
	color: [number, number, number], facing: number[], vertex: (p: number[], base: number[]) => Vert) {
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

	// texture and lightmap coordinates follow the flat face under the bumps
	const grid: Vert[] = [];
	for (let y = 0; y < size; y++) {
		const t = y / (size - 1);
		const left = lerp(c[0], c[1], t), right = lerp(c[3], c[2], t);
		for (let x = 0; x < size; x++) {
			const base = lerp(left, right, x / (size - 1));
			const vo = (vertStart + y * size + x) * 20;
			const dist = dverts.getFloat32(vo + 12, true);
			grid.push(vertex([
				base[0] + dverts.getFloat32(vo, true) * dist,
				base[1] + dverts.getFloat32(vo + 4, true) * dist,
				base[2] + dverts.getFloat32(vo + 8, true) * dist,
			], base));
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
				index: k,
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
