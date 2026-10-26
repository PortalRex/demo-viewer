// Source BSP (version 21, Portal 2): world faces, displacements and the brush
// models brush entities use (doors, elevators, panels), with texture and
// lightmap coordinates; the baked lighting packed into one atlas; static props.
import type {GameFS} from './gamefs.ts';
import type {MaterialInfo} from './materials.ts';
import {AmbientLighting} from './ambient.ts';
import {Visibility} from './vis.ts';

const LUMP = {
	ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, TEXINFO: 6, FACES: 7, LIGHTING: 8, EDGES: 12, SURFEDGES: 13,
	MODELS: 14, DISPINFO: 26, DISP_VERTS: 33, GAME_LUMP: 35, PAKFILE: 40, CUBEMAPS: 42, OVERLAYS: 45, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44,
	LIGHTING_HDR: 53, FACES_HDR: 58,
	VISIBILITY: 4, NODES: 5, LEAFS: 10, WORLDLIGHTS: 15, LEAF_AMBIENT_INDEX_HDR: 51, LEAF_AMBIENT_INDEX: 52, WORLDLIGHTS_HDR: 54,
	LEAF_AMBIENT_LIGHTING_HDR: 55, LEAF_AMBIENT_LIGHTING: 56,
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
	blend?: Float32Array;  // displacements': how far each vertex is $basetexture2 (0..1)
}

export interface MaterialGroup extends MeshData {
	material: string;    // lower case, under materials/
	surface: Surface;
	texSize?: [number, number];  // the size the texture coordinates are over (the compiler's, from the material's texture)
	overlayId?: number;  // an overlay an info_overlay_accessor can change (its texture's frame)
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
	// bump-mapped faces: the light arriving along each of the three bump
	// basis directions (in the face's texture space)
	bump?: Float32Array[];
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
	bump: Float32Array[];  // the same for the three bump directions (flat light for faces without)
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
				for (let layer = -1; layer < 3; layer++) {
					let r = 0, g = 0, bl = 0;
					for (let k = 0; k < b.layers.length; k++) {
						const s = scale[k];
						if (!s) continue;
						const L = b.layers[k];
						const rgb = layer < 0 ? L.rgb : L.bump?.[layer] ?? L.rgb;
						r += rgb[i * 3] * s;
						g += rgb[i * 3 + 1] * s;
						bl += rgb[i * 3 + 2] * s;
					}
					const out = layer < 0 ? lm.data : lm.bump[layer];
					out[o] = r;
					out[o + 1] = g;
					out[o + 2] = bl;
					out[o + 3] = 1;
				}
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
	flags: number;  // STATIC_PROP_* (0x2 use lighting origin, 0x40 no per-vertex lighting...)
	leaves: number[];  // the BSP leaves it's in (for visibility)
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
	overlays: MaterialGroup[];  // info_overlays laid on the faces they cover (uv in texture repeats)
	staticProps: StaticProp[];
	lightmap: Lightmap | null;
	skyFaces: Float32Array;  // the world's sky faces, triangles: the skybox is seen only through them
	ambient: AmbientLighting | null;  // lighting for moving models
	vis: Visibility | null;  // what can be seen from where (vvis)
	cubemaps: [number, number, number][];  // where the map's built cubemaps were taken (materials/maps/<map>/c<x>_<y>_<z>)
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
	blend?: number;
}

// Sutherland-Hodgman: a 2D polygon clipped to a convex one (counter-clockwise)
function clipConvex(subject: number[][], clip: number[][]): number[][] {
	let out = subject;
	for (let i = 0; i < clip.length && out.length; i++) {
		const a = clip[i], b = clip[(i + 1) % clip.length];
		const inside = (p: number[]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-4;
		const input = out;
		out = [];
		for (let j = 0; j < input.length; j++) {
			const p = input[j], q = input[(j + 1) % input.length];
			const pin = inside(p), qin = inside(q);
			if (pin) out.push(p);
			if (pin !== qin) {
				const dx = q[0] - p[0], dy = q[1] - p[1];
				const den = (b[0] - a[0]) * dy - (b[1] - a[1]) * dx;
				if (Math.abs(den) > 1e-9) {
					const t = ((b[1] - a[1]) * (p[0] - a[0]) - (b[0] - a[0]) * (p[1] - a[1])) / den;
					out.push([p[0] + dx * t, p[1] + dy * t]);
				}
			}
		}
	}
	return out;
}

// where a point is in a quad A B C D (A to B is s, A to D is t), inverting
// the bilinear map
function invBilinear(p: number[], a: number[], b: number[], c: number[], d: number[]): [number, number] {
	const e = [b[0] - a[0], b[1] - a[1]], f = [d[0] - a[0], d[1] - a[1]];
	const g = [a[0] - b[0] + c[0] - d[0], a[1] - b[1] + c[1] - d[1]], h = [p[0] - a[0], p[1] - a[1]];
	const cross = (u: number[], v: number[]) => u[0] * v[1] - u[1] * v[0];
	const k2 = cross(g, f), k1 = cross(e, f) + cross(h, g), k0 = cross(h, e);
	let t: number;
	if (Math.abs(k2) < 1e-9) t = Math.abs(k1) > 1e-12 ? -k0 / k1 : 0;
	else {
		const w = Math.sqrt(Math.max(0, k1 * k1 - 4 * k0 * k2));
		t = (-k1 - w) / (2 * k2);
		if (t < -0.01 || t > 1.01) t = (-k1 + w) / (2 * k2);
	}
	const den = [e[0] + g[0] * t, e[1] + g[1] * t];
	const s = Math.abs(den[0]) > Math.abs(den[1]) ? (h[0] - f[0] * t) / den[0] : (h[1] - f[1] * t) / (den[1] || 1e-12);
	return [s, t];
}

class Builder {
	pos: number[] = [];
	nrm: number[] = [];
	col: number[] = [];
	uv: number[] = [];
	lm: number[] = [];
	blend: number[] = [];
	blended = false;

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
			this.blend.push(v.blend ?? 0);
			if (v.blend) this.blended = true;
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
	// A face's front: its plane's normal, turned to agree with the vertex
	// winding (clockwise seen from the front). The face's `side` byte isn't
	// a reliable guide to that.
	const facingOf = (f: number, vs: number[][]): {normal: [number, number, number]; dist: number} => {
		const pn = faces.getUint16(f * 56, true);
		const n0 = [planes.getFloat32(pn * 20, true), planes.getFloat32(pn * 20 + 4, true), planes.getFloat32(pn * 20 + 8, true)];
		let wx = 0, wy = 0, wz = 0;
		for (let i = 1; i + 1 < vs.length; i++) {
			const a = vs[0], b = vs[i], c = vs[i + 1];
			const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
			wx += e1[1] * e2[2] - e1[2] * e2[1];
			wy += e1[2] * e2[0] - e1[0] * e2[2];
			wz += e1[0] * e2[1] - e1[1] * e2[0];
		}
		const sign = wx * n0[0] + wy * n0[1] + wz * n0[2] <= 0 ? 1 : -1;
		return {normal: [n0[0] * sign, n0[1] * sign, n0[2] * sign], dist: planes.getFloat32(pn * 20 + 12, true) * sign};
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
			const bumped = (texinfo.getInt32(ti * 72 + 64, true) & SURF_BUMPLIGHT) !== 0;
			const perStyle = b.w * b.h * (bumped ? 4 : 1) * 4;
			const read = (start: number) => {
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
				return rgb;
			};
			const layers: LightmapLayer[] = [];
			for (let k = 0; k < 4; k++) {
				const style = lightFaces.getUint8(o + 16 + k);
				if (style === 255) break;
				const start = base + k * perStyle;
				const layer: LightmapLayer = {style, rgb: read(start)};
				if (bumped) layer.bump = [1, 2, 3].map(n => read(start + n * b.w * b.h * 4));
				layers.push(layer);
				if (style) styleSet.add(style);
			}
			lmBlocks.push({x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2, layers});
		}
		const bump = [0, 1, 2].map(() => data.slice());
		lightmap = {width: W, height: H, data, bump, blocks: lmBlocks, styles: [...styleSet]};
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
			const {normal, dist} = facingOf(f, vs);
			paintFaces.set(f, {x: b.x, y: b.y, w: b.w, h: b.h, mins: b.mins, lmVecs: tex.lmVecs, normal, dist, center: c, radius});
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

	const skyTris: number[] = [];
	{
		const first = models.getInt32(40, true), count = models.getInt32(44, true);
		for (let f = first; f < first + count; f++) {
			const ti = faces.getInt16(f * 56 + 10, true);
			if (ti < 0 || !(texinfo.getInt32(ti * 72 + 64, true) & (SURF_SKY | SURF_SKY2D))) continue;
			const vs = faceVerts(f);
			for (let i = 1; i + 1 < vs.length; i++) skyTris.push(...vs[0], ...vs[i], ...vs[i + 1]);
		}
	}

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
			const facing = facingOf(f, vs).normal;
			for (let i = 0; i < vs.length; i++) edgeList.push(...vs[i], ...vs[(i + 1) % vs.length]);
			if (disp >= 0 && vs.length === 4) {
				// (a displacement's lightmap is laid over its grid evenly, from
				// its start corner: not projected as a flat face's)
				const b = blocks.get(f);
				const luxel = b && lightmap ? (tx: number, ty: number): [number, number] =>
					[(b.x + 0.5 + (b.w - 1) * tx) / lightmap!.width, (b.y + 0.5 + (b.h - 1) * ty) / lightmap!.height] : null;
				buildDisplacement(g.b, vs, dispinfo, dispverts, disp, tex.color, facing, (p, base) => vertexFor(p, tex, f, base), luxel);
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
				uv: new Float32Array(b.uv), lightUv: new Float32Array(b.lm), texSize: tex.size as [number, number],
				blend: b.blended ? new Float32Array(b.blend) : undefined,
			});
		}
		meshes.push({groups: out, edges: new Float32Array(edgeList)});
	}

	// info_overlays, as the engine's overlay manager builds them: the quad
	// (four uv points in the overlay's own plane: basis U packed in the
	// points' z, V = normal x U, negated when point 3's z is 1) clipped to each
	// face it covers, its texture coordinates by where each point falls in the
	// quad (bilinearly), then laid on the face along the overlay's normal
	const overlayLump = await read(LUMP.OVERLAYS);
	// (each one an accessor can change apart: the others, by material)
	const accessed = new Set(entities.filter(e => e.classname === 'info_overlay_accessor').map(e => Number(e.overlayid)));
	const overlayGroups = new Map<string, {tex: TexInfo; b: Builder; id?: number}>();
	const OVERLAY_SIZE = 352;
	for (let o = 0; o + OVERLAY_SIZE <= overlayLump.byteLength; o += OVERLAY_SIZE) {
		const fv = (k: number) => overlayLump.getFloat32(o + k, true);
		const id = overlayLump.getInt32(o, true);
		const ti = overlayLump.getInt16(o + 4, true);
		const faceCount = overlayLump.getUint16(o + 6, true) & 0x3fff;
		if (ti < 0 || ti * 72 >= texinfo.byteLength) continue;
		const tex = texInfoOf(ti);
		const u0 = fv(264), u1 = fv(268), v0 = fv(272), v1 = fv(276);
		const pts = [0, 1, 2, 3].map(i => [fv(280 + i * 12), fv(284 + i * 12), fv(288 + i * 12)]);
		const origin = [fv(328), fv(332), fv(336)], n = [fv(340), fv(344), fv(348)];
		const U = [pts[0][2], pts[1][2], pts[2][2]];
		const ul = Math.hypot(U[0], U[1], U[2]);
		if (ul < 1e-6) continue;
		U[0] /= ul; U[1] /= ul; U[2] /= ul;
		const V = [n[1] * U[2] - n[2] * U[1], n[2] * U[0] - n[0] * U[2], n[0] * U[1] - n[1] * U[0]];
		const vl = Math.hypot(V[0], V[1], V[2]) * (pts[3][2] === 1 ? -1 : 1);
		V[0] /= vl; V[1] /= vl; V[2] /= vl;
		// the quad in overlay-plane coordinates, corners A B C D = points 0 3 2 1
		const quad = pts.map(p => [p[0], p[1]]);
		const A = quad[0], B = quad[3], C = quad[2], D = quad[1];
		const key = accessed.has(id) ? `${tex.material}#${id}` : tex.material;
		let g = overlayGroups.get(key);
		if (!g) {
			g = {tex, b: new Builder(), id: accessed.has(id) ? id : undefined};
			overlayGroups.set(key, g);
		}
		for (let k = 0; k < faceCount; k++) {
			const f = overlayLump.getInt32(o + 8 + k * 4, true);
			if (f < 0 || f >= nFaces) continue;
			const vs = faceVerts(f);
			if (vs.length < 3) continue;
			const {normal, dist} = facingOf(f, vs);
			// the face in overlay-plane coordinates, wound counter-clockwise
			let poly = vs.map(p => {
				const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
				return [d[0] * U[0] + d[1] * U[1] + d[2] * U[2], d[0] * V[0] + d[1] * V[1] + d[2] * V[2]];
			});
			let area = 0;
			for (let i = 0; i < poly.length; i++) {
				const a = poly[i], c = poly[(i + 1) % poly.length];
				area += a[0] * c[1] - c[0] * a[1];
			}
			if (Math.abs(area) < 1e-6) continue;
			if (area < 0) poly = poly.reverse();
			let clipped = clipConvex(quad.slice(), poly);
			if (clipped.length < 3) continue;
			const denom = normal[0] * n[0] + normal[1] * n[1] + normal[2] * n[2];
			const verts: Vert[] = clipped.map(([x, y]) => {
				const [s, t] = invBilinear([x, y], A, B, C, D);
				const P = [origin[0] + x * U[0] + y * V[0], origin[1] + x * U[1] + y * V[1], origin[2] + x * U[2] + y * V[2]];
				// onto the face along the overlay's normal, a hair in front of it
				const toFace = (normal[0] * P[0] + normal[1] * P[1] + normal[2] * P[2] - dist) / (Math.abs(denom) > 1e-6 ? denom : 1);
				const W = [P[0] - n[0] * toFace + normal[0] * 0.1, P[1] - n[1] * toFace + normal[1] * 0.1, P[2] - n[2] * toFace + normal[2] * 0.1];
				const lit = vertexFor(W, texInfoOf(faces.getInt16(f * 56 + 10, true)), f);
				return {p: W, uv: [u0 + s * (u1 - u0), v0 + t * (v1 - v0)], lm: lit.lm};
			});
			for (let i = 1; i + 1 < verts.length; i++) g.b.tri(verts[0], verts[i], verts[i + 1], tex.color, normal);
		}
	}
	const overlays: MaterialGroup[] = [];
	for (const {tex, b: ob, id} of overlayGroups.values()) {
		if (ob.empty) continue;
		overlays.push({
			material: tex.material, surface: tex.surface,
			positions: new Float32Array(ob.pos), normals: new Float32Array(ob.nrm), colors: new Float32Array(ob.col),
			uv: new Float32Array(ob.uv), lightUv: new Float32Array(ob.lm), overlayId: id,
		});
	}

	const b = (i: number) => models.getFloat32(i, true);
	// ambient cubes and world lights (HDR where the map has them)
	const [nodes, leaves, ambIndexHdr, ambLightHdr, lightsHdr, visLump] = await Promise.all([
		read(LUMP.NODES), read(LUMP.LEAFS), read(LUMP.LEAF_AMBIENT_INDEX_HDR), read(LUMP.LEAF_AMBIENT_LIGHTING_HDR), read(LUMP.WORLDLIGHTS_HDR), read(LUMP.VISIBILITY),
	]);
	const vis = new Visibility(planes, nodes, leaves, models, visLump);
	const ambIndex = ambIndexHdr.byteLength ? ambIndexHdr : await read(LUMP.LEAF_AMBIENT_INDEX);
	const ambLight = ambLightHdr.byteLength ? ambLightHdr : await read(LUMP.LEAF_AMBIENT_LIGHTING);
	const worldLights = lightsHdr.byteLength ? lightsHdr : await read(LUMP.WORLDLIGHTS);
	const ambient = new AmbientLighting(planes, nodes, leaves, models, ambIndex, ambLight, worldLights);
	const cubeLump = await read(LUMP.CUBEMAPS);
	const cubemaps: [number, number, number][] = [];
	for (let o = 0; o + 16 <= cubeLump.byteLength; o += 16) cubemaps.push([cubeLump.getInt32(o, true), cubeLump.getInt32(o + 4, true), cubeLump.getInt32(o + 8, true)]);

	return {
		name, models: meshes, overlays, staticProps, lightmap, skyFaces: new Float32Array(skyTris), ambient: ambient.available ? ambient : null, vis: vis.available ? vis : null, cubemaps, paintFaces, entities, materials, pak, materialsRead, faceCount, warnings,
		bounds: {min: [b(0), b(4), b(8)], max: [b(12), b(16), b(20)]},
	};
}

function buildDisplacement(out: Builder, corners: number[][], info: DataView, dverts: DataView, index: number,
	color: [number, number, number], facing: number[], vertex: (p: number[], base: number[]) => Vert,
	luxel: ((tx: number, ty: number) => [number, number]) | null) {
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
			const v = vertex([
				base[0] + dverts.getFloat32(vo, true) * dist,
				base[1] + dverts.getFloat32(vo + 4, true) * dist,
				base[2] + dverts.getFloat32(vo + 8, true) * dist,
			], base);
			// (the alpha painted on it, 0..255: towards $basetexture2)
			v.blend = dverts.getFloat32(vo + 16, true) / 255;
			// (rows run from the start corner to the next, columns to the last)
			if (luxel) v.lm = luxel(x / (size - 1), y / (size - 1));
			grid.push(v);
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
		const nLeaves = v.getInt32(p, true);
		const leafList = new Uint16Array(nLeaves);
		for (let k = 0; k < nLeaves; k++) leafList[k] = v.getUint16(p + 4 + k * 2, true);
		p += 4 + nLeaves * 2;
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
				flags: v.getUint8(p + 31),
				leaves: [...leafList.subarray(v.getUint16(p + 26, true), v.getUint16(p + 26, true) + v.getUint16(p + 28, true))],
			});
		}
		return props;
	}
	return [];
}
