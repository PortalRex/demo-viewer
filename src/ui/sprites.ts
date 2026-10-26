// Sprites (env_sprite, C_Sprite): a texture on a quad facing the camera,
// as big as the texture times the sprite's scale, tinted by its render
// colour and brightness. Glows (render modes 3 and 9) draw over everything,
// dimmed by how much of their proxy shows and with distance; a plain glow
// keeps one size on screen (StandardGlowBlend).
import * as THREE from 'three';
import {writeAttribute} from './dynamic.ts';
import type {EffectAssets} from './effects.ts';

export interface SpriteSpec {
	material: string;        // under materials/, without .vmt
	origin: THREE.Vector3;
	scale: number;           // m_flSpriteScale
	color: [number, number, number];  // 0..1
	alpha: number;           // brightness, 0..1
	mode: number;            // render mode
	hdrScale: number;        // m_flHDRColorScale
	seen: number;            // how much of its glow proxy shows (0..1)
}

const kRenderNormal = 0, kRenderGlow = 3, kRenderTransAlpha = 4, kRenderWorldGlow = 9;

interface SpriteMaterial {
	material: THREE.MeshBasicMaterial;
	width: number;   // the texture's size: the quad's at scale 1
	height: number;
}

export class Sprites {
	readonly group = new THREE.Group();
	private assets: EffectAssets;
	private materials = new Map<string, Promise<SpriteMaterial | null>>();
	private loaded = new Map<string, SpriteMaterial | null>();
	private meshes = new Map<string, THREE.Mesh>();

	constructor(assets: EffectAssets) {
		this.assets = assets;
	}

	update(sprites: SpriteSpec[], camera: THREE.Camera) {
		const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
		const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
		const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
		const batches = new Map<string, {pos: number[]; uv: number[]; col: number[]}>();
		for (const s of sprites) {
			const key = `${s.material}#${s.mode}`;
			const m = this.material(s.material, s.mode);
			if (!m) continue;
			let scale = s.scale > 0 ? s.scale : 1;
			let blend = 1;
			if (s.mode === kRenderGlow || s.mode === kRenderWorldGlow) {
				const dist = s.origin.distanceTo(eye);
				if (s.seen <= 0 || dist <= 0) continue;
				const reach = s.mode === kRenderWorldGlow ? 2400 : 1200;
				blend = Math.min(1, reach * reach / (dist * dist)) * s.seen;
				// (a plain glow: one size on screen)
				if (s.mode === kRenderGlow) scale *= dist / 200;
			}
			const k = blend * s.hdrScale;
			const c = [s.color[0] * k, s.color[1] * k, s.color[2] * k, s.mode === kRenderNormal ? 1 : s.alpha];
			const ax = right.clone().multiplyScalar(m.width / 2 * scale), ay = up.clone().multiplyScalar(m.height / 2 * scale);
			const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => s.origin.clone().addScaledVector(ax, x).addScaledVector(ay, y));
			const uvs = [[0, 1], [1, 1], [1, 0], [0, 0]];
			let b = batches.get(key);
			if (!b) batches.set(key, b = {pos: [], uv: [], col: []});
			for (const i of [0, 1, 2, 0, 2, 3]) {
				b.pos.push(corners[i].x, corners[i].y, corners[i].z);
				b.uv.push(uvs[i][0], uvs[i][1]);
				b.col.push(...c);
			}
		}
		for (const [key, mesh] of this.meshes) if (!batches.has(key)) mesh.visible = false;
		for (const [key, b] of batches) {
			let mesh = this.meshes.get(key);
			if (!mesh) {
				mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.loaded.get(key)!.material);
				mesh.frustumCulled = false;
				mesh.renderOrder = 3;
				this.meshes.set(key, mesh);
				this.group.add(mesh);
			}
			const g = mesh.geometry;
			g.setDrawRange(0, writeAttribute(g, 'position', b.pos, 3));
			writeAttribute(g, 'uv', b.uv, 2);
			writeAttribute(g, 'color', b.col, 4);
			mesh.visible = true;
		}
	}

	// a sprite material for a render mode (loaded once; null until it has)
	private material(name: string, mode: number): SpriteMaterial | null {
		const key = `${name}#${mode}`;
		if (this.loaded.has(key)) return this.loaded.get(key)!;
		if (!this.materials.has(key)) {
			this.materials.set(key, this.load(name, mode).then(m => {
				this.loaded.set(key, m);
				return m;
			}));
		}
		return null;
	}

	private async load(name: string, mode: number): Promise<SpriteMaterial | null> {
		const raw = await this.assets.materials.raw(name);
		const base = raw?.params.get('$basetexture')?.toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');
		if (!base) return null;
		const tex = await this.assets.texture(base);
		if (tex === this.assets.white) return null;
		const image = tex.image as {width?: number; height?: number} | undefined;
		// glows and additive modes add; translucent ones blend; normal ones
		// are solid; glows ignore depth (their proxy test stands in for it)
		const glow = mode === kRenderGlow || mode === kRenderWorldGlow;
		const material = new THREE.MeshBasicMaterial({
			map: tex, vertexColors: true, transparent: mode !== kRenderNormal, depthWrite: false, depthTest: !glow,
			blending: mode === kRenderTransAlpha || mode === kRenderNormal ? THREE.NormalBlending : THREE.AdditiveBlending,
			side: THREE.DoubleSide, toneMapped: false, fog: false,
		});
		material.userData.effect = true;
		return {material, width: image?.width ?? 64, height: image?.height ?? 64};
	}

	dispose() {
		for (const mesh of this.meshes.values()) mesh.geometry.dispose();
		for (const m of this.loaded.values()) m?.material.dispose();
		this.meshes.clear();
		this.loaded.clear();
		this.materials.clear();
		this.group.clear();
	}
}
