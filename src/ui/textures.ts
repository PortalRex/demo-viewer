// Materials' base textures as three.js textures, loaded once per map.
import * as THREE from 'three';
import type {GameFiles} from '../game/files.ts';
import {vtfLevel, decodeVtf} from '../game/vtf.ts';

export class TextureCache {
	private files: GameFiles;
	private cache = new Map<string, Promise<THREE.Texture | null>>();
	maxSize: number;

	constructor(files: GameFiles, maxSize = 512) {
		this.files = files;
		this.maxSize = maxSize;
	}

	// `path` under materials/, without .vtf; `linear`: data, not colour (normal maps)
	get(path: string, linear = false): Promise<THREE.Texture | null> {
		const key = path.toLowerCase() + (linear ? '|linear' : '');
		let p = this.cache.get(key);
		if (!p) {
			p = this.load(path.toLowerCase(), linear).catch(() => null);
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
}
