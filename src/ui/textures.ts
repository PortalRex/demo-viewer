// Materials' base textures as three.js textures, loaded once per map.
import * as THREE from 'three';
import type {GameFiles} from '../game/files.ts';
import {readVtf, decodeVtf} from '../game/vtf.ts';

export class TextureCache {
	private files: GameFiles;
	private cache = new Map<string, Promise<THREE.Texture | null>>();
	maxSize: number;

	constructor(files: GameFiles, maxSize = 512) {
		this.files = files;
		this.maxSize = maxSize;
	}

	// `path` under materials/, without .vtf
	get(path: string): Promise<THREE.Texture | null> {
		const key = path.toLowerCase();
		let p = this.cache.get(key);
		if (!p) {
			p = this.load(key).catch(() => null);
			this.cache.set(key, p);
		}
		return p;
	}

	private async load(path: string): Promise<THREE.Texture | null> {
		const bytes = await this.files.read(`materials/${path}.vtf`);
		if (!bytes) return null;
		const img = readVtf(bytes, this.maxSize);
		if (!img) return null;
		const rgba = decodeVtf(img);
		const tex = new THREE.DataTexture(rgba, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
		tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
		tex.colorSpace = THREE.SRGBColorSpace;
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
