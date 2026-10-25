// Materials' base textures as three.js textures, kept from map to map:
// those a map's own files supplied, the ones not found (the next map's files
// may have them) and the ones no map has used for a while go when the map
// changes.
import * as THREE from 'three';
import type {GameFiles} from '../game/files.ts';
import {vtfLevel, vtfMips, decodeVtf, VtfFormat} from '../game/vtf.ts';

// DXT textures go to the GPU as they are (with the file's own mip levels)
// where it takes them: no decoding, a quarter to an eighth of the memory.
// Set once the renderer knows: s3tc, and s3tc in sRGB for colour textures.
export const compressedSupport = {dxt: false, srgb: false};

// (maps a texture can go unused for and stay)
const KEEP_MAPS = 2;

export class TextureCache {
	readonly files: GameFiles;
	private cache = new Map<string, Promise<THREE.Texture | null>>();
	private fromMap = new Set<string>();
	private lastUsed = new Map<string, number>();
	private loaded = new Map<string, THREE.Texture | null>();
	private generation = 0;
	maxSize: number;

	constructor(files: GameFiles, maxSize = 512) {
		this.files = files;
		this.maxSize = maxSize;
	}

	// frees every texture loaded
	dispose() {
		for (const p of this.cache.values()) p.then(t => t?.dispose());
		this.cache.clear();
		this.fromMap.clear();
		this.lastUsed.clear();
		this.loaded.clear();
	}

	// a new map: drop what the last map's files supplied, what wasn't found,
	// and what's gone unused (of what has finished loading)
	newMap() {
		this.generation++;
		for (const [key, t] of this.loaded) {
			if (t && !this.fromMap.has(key) && this.generation - (this.lastUsed.get(key) ?? 0) <= KEEP_MAPS) continue;
			t?.dispose();
			this.cache.delete(key);
			this.fromMap.delete(key);
			this.lastUsed.delete(key);
			this.loaded.delete(key);
		}
	}

	// `path` under materials/, without .vtf; `linear`: data, not colour (normal maps)
	get(path: string, linear = false): Promise<THREE.Texture | null> {
		const key = path.toLowerCase() + (linear ? '|linear' : '');
		this.lastUsed.set(key, this.generation);
		let p = this.cache.get(key);
		if (!p) {
			if (this.files.mapPak?.has(`materials/${path.toLowerCase()}.vtf`)) this.fromMap.add(key);
			const loading: Promise<THREE.Texture | null> = this.load(path.toLowerCase(), linear).catch(() => null).then(t => {
				if (this.cache.get(key) === loading) this.loaded.set(key, t);
				return t;
			});
			p = loading;
			this.cache.set(key, p);
		}
		return p;
	}

	private async load(path: string, linear: boolean): Promise<THREE.Texture | null> {
		// the header, then only the level drawn (not the whole file)
		const file = `materials/${path}.vtf`;
		const head = await this.files.readRange(file, 0, 1024);
		if (!head) return null;
		const level = vtfLevel(head, this.maxSize);
		if (!level) return null;
		const data = level.offset + level.size <= head.length
			? head.subarray(level.offset, level.offset + level.size)
			: await this.files.readRange(file, level.offset, level.size);
		if (!data || data.length < level.size) return null;
		const dxt = level.format === VtfFormat.DXT1 || level.format === VtfFormat.DXT1_ONEBITALPHA || level.format === VtfFormat.DXT3 || level.format === VtfFormat.DXT5;
		// (WebGL takes DXT base levels in whole 4x4 blocks only)
		if (dxt && compressedSupport.dxt && (linear || compressedSupport.srgb) && level.width % 4 === 0 && level.height % 4 === 0) {
			const tex = await this.compressed(file, head, level, linear);
			if (tex) return tex;
		}
		const img = {...level, data};
		const rgba = decodeVtf(img);
		const tex = new THREE.DataTexture(rgba, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
		tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
		tex.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
		tex.magFilter = THREE.LinearFilter;
		const pot = (n: number) => (n & (n - 1)) === 0;
		tex.generateMipmaps = pot(img.width) && pot(img.height);
		tex.minFilter = tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
		tex.anisotropy = 4;
		tex.flipY = false;
		tex.needsUpdate = true;
		tex.userData.hasAlpha = img.hasAlpha;
		return tex;
	}

	// the drawn level and every smaller one as one compressed texture (the
	// levels sit together in the file, smallest first)
	private async compressed(file: string, head: Uint8Array, level: NonNullable<ReturnType<typeof vtfLevel>>, linear: boolean): Promise<THREE.Texture | null> {
		const mips = vtfMips(head, this.maxSize);
		if (!mips?.length) return null;
		const start = Math.min(...mips.map(m => m.offset)), end = Math.max(...mips.map(m => m.offset + m.size));
		const bytes = end <= head.length ? head.subarray(start, end) : await this.files.readRange(file, start, end - start);
		if (!bytes || bytes.length < end - start) return null;
		const F = VtfFormat;
		const format = level.format === F.DXT1 ? THREE.RGB_S3TC_DXT1_Format
			: level.format === F.DXT1_ONEBITALPHA ? THREE.RGBA_S3TC_DXT1_Format
			: level.format === F.DXT3 ? THREE.RGBA_S3TC_DXT3_Format : THREE.RGBA_S3TC_DXT5_Format;
		// (a full chain to 1x1, or just the one level)
		const chain = mips[mips.length - 1].width === 1 && mips[mips.length - 1].height === 1 ? mips : mips.slice(0, 1);
		const levels = chain.map(m => ({data: bytes.subarray(m.offset - start, m.offset - start + m.size), width: m.width, height: m.height}));
		const tex = new THREE.CompressedTexture(levels as unknown as ImageData[], level.width, level.height, format);
		tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
		tex.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
		tex.magFilter = THREE.LinearFilter;
		tex.minFilter = levels.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
		tex.generateMipmaps = false;
		tex.anisotropy = 4;
		tex.needsUpdate = true;
		tex.userData.hasAlpha = level.hasAlpha;
		return tex;
	}
}
