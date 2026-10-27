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
	fog: number;             // how fogged it is where it stands (0..1)
	halfSize?: number;       // a beam's halo: this many units each way, as drawn (BeamDrawHalo)
}

// A beam (C_Beam) between two points: its texture across it (u) and once
// along it (v, FBEAM_NOTILE), turned to the camera, added; FBEAM_SHADEOUT
// fades it from its colour at the start to nothing at the end
export interface BeamSpec {
	material: string;
	start: THREE.Vector3;
	end: THREE.Vector3;
	width: number;
	color: [number, number, number];  // 0..1, brightness in
	hdrScale: number;
	fog: number;
}

const kRenderTransAdd = 5;

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

	// called when a new mesh joins the group (its material's shader is to compile)
	onNewMesh = () => {};

	constructor(assets: EffectAssets) {
		this.assets = assets;
	}

	update(sprites: SpriteSpec[], camera: THREE.Camera, beams: BeamSpec[] = []) {
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
			if (s.halfSize !== undefined) {
				// (a halo: its size as given, its fade in its colour)
				if (s.seen <= 0) continue;
				blend = s.seen;
			} else if (s.mode === kRenderGlow || s.mode === kRenderWorldGlow) {
				const dist = s.origin.distanceTo(eye);
				if (s.seen <= 0 || dist <= 0) continue;
				const reach = s.mode === kRenderWorldGlow ? 2400 : 1200;
				blend = Math.min(1, reach * reach / (dist * dist)) * s.seen;
				// (a plain glow: one size on screen)
				if (s.mode === kRenderGlow) scale *= dist / 200;
			}
			// (additive modes fog to black, as the Sprite shader's FogToBlack:
			// they fade out in the fog)
			const additive = s.mode !== kRenderNormal && s.mode !== kRenderTransAlpha;
			// The Sprite shader takes its vertex colour (a glow's blend already
			// in it) and $hdrcolorscale from gamma to linear; a normal sprite
			// has no vertex colour
			const linear = (v: number) => Math.pow(Math.max(0, v), 2.2);
			const rgb = s.mode === kRenderNormal ? [1, 1, 1] : s.color.map(v => linear(v * blend));
			const k = linear(s.hdrScale) * (additive ? 1 - s.fog : 1);
			const c = [rgb[0] * k, rgb[1] * k, rgb[2] * k, s.mode === kRenderNormal ? 1 : s.alpha];
			const ax = right.clone().multiplyScalar(s.halfSize ?? m.width / 2 * scale), ay = up.clone().multiplyScalar(s.halfSize ?? m.height / 2 * scale);
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
		for (const beam of beams) {
			const key = `${beam.material}#${kRenderTransAdd}`;
			if (!this.material(beam.material, kRenderTransAdd)) continue;
			const mid = beam.start.clone().add(beam.end).multiplyScalar(0.5);
			const side = beam.end.clone().sub(beam.start).cross(eye.clone().sub(mid)).normalize().multiplyScalar(beam.width / 2);
			if (!isFinite(side.x)) continue;
			const corners = [beam.start.clone().sub(side), beam.start.clone().add(side), beam.end.clone().add(side), beam.end.clone().sub(side)];
			const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
			// (as the sprites: the colour from gamma to linear, fogging to black)
			const k = Math.pow(Math.max(0, beam.hdrScale), 2.2) * (1 - beam.fog);
			const c = beam.color.map(v => Math.pow(Math.max(0, v), 2.2) * k);
			const shade = [1, 1, 0, 0];
			let b = batches.get(key);
			if (!b) batches.set(key, b = {pos: [], uv: [], col: []});
			for (const i of [0, 1, 2, 0, 2, 3]) {
				b.pos.push(corners[i].x, corners[i].y, corners[i].z);
				b.uv.push(uvs[i][0], uvs[i][1]);
				b.col.push(c[0] * shade[i], c[1] * shade[i], c[2] * shade[i], 1);
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
				this.onNewMesh();
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
