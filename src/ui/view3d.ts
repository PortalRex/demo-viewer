// 3D replay: the map's geometry from the viewer's own game files, with the
// recorded entities (portals, brush entities, props) and the player's view.
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import type {BspMap, MeshData, MaterialGroup, ModelMesh} from '../game/bsp.ts';
import type {GameFiles} from '../game/files.ts';
import type {Materials, MaterialInfo} from '../game/materials.ts';
import {loadModel} from '../game/mdl.ts';
import type {StudioModel, ModelGroup} from '../game/mdl.ts';
import {loadSkeleton, referencePose, samplePose, sequenceRate} from '../game/anim.ts';
import type {Skeleton} from '../game/anim.ts';
import {AnimatedModel, bakePose, skinMatrices, skinnedGeometry} from './skinning.ts';
import {Laser, Bridge, Funnel, fizzlerMaterial, portalMaterial, vec3, EffectAssets} from './effects.ts';
import {PaintLayer} from './paint.ts';
import {paintUniforms, ditherUniforms, hookWorldMaterial, hookModelMaterial} from './shaderhooks.ts';
import {TextureCache} from './textures.ts';
import {Zip} from '../game/zip.ts';
import {readVhv} from '../game/vhv.ts';
import type {EntityTimeline, EntityTrack, EntityKey} from '../net/entities.ts';
import {keyAt, keyIndexAt} from '../net/entities.ts';
import type {SegmentTrack, ViewState} from '../player/playback.ts';
import type {Vec3} from '../core/model.ts';

export type CameraMode = 'eyes' | 'orbit';

// Portal 2's 90° horizontal FOV at 4:3, as a vertical FOV (widescreen keeps it)
const VERTICAL_FOV = 2 * Math.atan(Math.tan(Math.PI / 4) * 3 / 4) * 180 / Math.PI;
const DEFAULT_EYE = 64;
const PORTAL_HALF_W = 32, PORTAL_HALF_H = 56;

// entity classes that aren't worth a box
const HIDDEN_CLASSES = new Set([
	'CWeaponPortalgun', 'CPredictedViewModel', 'CBaseViewModel', 'CFuncPortalBumper', 'CFuncNoPortalVolume',
	'CVGuiScreen', 'CMovieDisplay', 'CBoneFollower', 'CInfoPlacementHelper', 'CEnvProjectedTexture', 'CFogController',
	'CParticleSystem', 'CRopeKeyframe', 'CSprite', 'CSpriteOriented', 'CBeam', 'CPortalGameRulesProxy', 'CPortalGameRules',
	'CTeam', 'CPlayerResource', 'CPortal_PlayerResource', 'CWorld', 'CSun', 'CEnvTonemapController', 'CFunc_LiquidPortal',
	'CEnvScreenOverlay', 'CEnvScreenEffect', 'CPointCamera', 'CPointCommentaryNode', 'CInfoLadderDismount', 'CFuncLadder',
	'CPostProcessController', 'CColorCorrection', 'CColorCorrectionVolume', 'CShadowControl', 'CSceneEntity', 'CInfoOverlayAccessor',
	'CBaseEntity', 'CProp_Portal', 'CLightGlow', 'CSlideshowDisplay', 'CProjectedTractorBeamEntity',
]);

// effects placed in world space from their props, not the entity's transform
const WORLD_SPACE = new Set(['CPortalLaser', 'CProjectedWallEntity', 'CTrigger_TractorBeam']);
const R180Z = new THREE.Matrix4().makeRotationZ(Math.PI);

const toEuler = (a: Vec3) => new THREE.Euler(a[2] * Math.PI / 180, a[0] * Math.PI / 180, a[1] * Math.PI / 180, 'ZYX');

function geometry(m: MeshData) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
	g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
	g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
	if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
	if (m.lightUv) g.setAttribute('uv1', new THREE.BufferAttribute(m.lightUv, 2));
	return g;
}

// How bright the baked lighting is drawn. three's basic material divides
// light maps by pi.
const LIGHTMAP_EXPOSURE = 2.5;

// three.js materials for the map's materials: textured once the texture
// loads (flat colour until then), lit by the lightmap atlas for the world
class MaterialLibrary {
	readonly materials: Materials;
	readonly textures: TextureCache;
	private lightmap: THREE.Texture | null;
	private world = new Map<string, THREE.Material>();
	private model = new Map<string, THREE.Material>();
	private litModel = new Map<string, THREE.Material>();
	onChange = () => {};

	constructor(files: GameFiles, materials: Materials, lightmap: THREE.Texture | null) {
		this.materials = materials;
		this.textures = new TextureCache(files);
		this.lightmap = lightmap;
	}

	private apply(mat: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial, info: MaterialInfo) {
		if (info.translucent || info.liquid) {
			mat.transparent = true;
			mat.depthWrite = false;
			mat.opacity = info.liquid && !info.baseTexture ? 0.6 : info.alpha;
			if (info.additive) mat.blending = THREE.AdditiveBlending;
		} else if (info.alphaTest) {
			mat.alphaTest = 0.5;
		}
		if (info.noCull || info.translucent || info.alphaTest) mat.side = THREE.DoubleSide;
		if (!info.baseTexture) {
			// refraction only (glass): a faint tint of what's behind
			if (info.shader === 'refract') {
				mat.vertexColors = false;
				mat.opacity = 0.18;
				mat.color.setRGB(...info.color);
				mat.needsUpdate = true;
			}
			return;
		}
		this.textures.get(info.baseTexture).then(tex => {
			if (!tex) return;
			mat.map = tex;
			// lit props keep their vertex colours: those are the baked light
			if (!mat.userData.vertexLit) mat.vertexColors = false;
			const k = mat.userData.scale ?? 1;
			mat.color.setRGB(info.color[0] * k, info.color[1] * k, info.color[2] * k);
			mat.needsUpdate = true;
			this.onChange();
		});
	}

	// a skybox face's texture (skybox/<name><side>)
	async skyTexture(material: string): Promise<THREE.Texture | null> {
		const info = await this.materials.get(material);
		if (!info.found || !info.baseTexture) return null;
		const tex = await this.textures.get(info.baseTexture);
		if (!tex) return null;
		const t = tex.clone();
		t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
		t.needsUpdate = true;
		return t;
	}

	forWorld(group: MaterialGroup): THREE.Material {
		const cached = this.world.get(group.material);
		if (cached) return cached;
		const mat = new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.FrontSide});
		hookWorldMaterial(mat);
		if (group.surface === 'glass' || group.surface === 'liquid') {
			mat.transparent = true;
			mat.opacity = 0.35;
			mat.depthWrite = false;
		}
		this.world.set(group.material, mat);
		this.materials.get(group.material).then(info => {
			if (!info.found) return;
			if (!info.unlit && this.lightmap) {
				mat.lightMap = this.lightmap;
				mat.lightMapIntensity = Math.PI * LIGHTMAP_EXPOSURE;
			}
			this.apply(mat, info);
			mat.needsUpdate = true;
			this.onChange();
		});
		return mat;
	}

	// `vertexLit`: the geometry's colours are vrad's baked light (static props)
	forModel(candidates: string[], vertexLit = false): THREE.Material {
		const key = candidates.join('|');
		const cache = vertexLit ? this.litModel : this.model;
		const cached = cache.get(key);
		if (cached) return cached;
		let mat: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial;
		if (vertexLit) {
			mat = new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.DoubleSide});
			mat.userData.vertexLit = true;
			mat.userData.scale = LIGHTMAP_EXPOSURE;
			mat.color.setScalar(LIGHTMAP_EXPOSURE);
		} else {
			mat = new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide});
		}
		hookModelMaterial(mat);
		cache.set(key, mat);
		(async () => {
			for (const c of candidates) {
				const info = await this.materials.get(c);
				if (info.found) {
					this.apply(mat, info);
					return;
				}
			}
		})();
		return mat;
	}
}

interface ModelAsset {
	name: string;
	model: StudioModel;
	skeleton: Skeleton | null;
	parts: {group: ModelGroup; raw: THREE.BufferGeometry; baked: THREE.BufferGeometry; material: THREE.Material; name: string}[];
}

export class View3D {
	readonly container: HTMLElement;
	mode: CameraMode = 'eyes';
	private renderer: THREE.WebGLRenderer | null = null;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(VERTICAL_FOV, 1, 1, 40000);
	private controls: OrbitControls | null = null;
	private library: MaterialLibrary | null = null;
	private mapGroup = new THREE.Group();
	private entityGroup = new THREE.Group();
	private pathLine: THREE.LineSegments | null = null;
	private player: THREE.Mesh;
	private bsp: BspMap | null = null;
	private entities: EntityTimeline | null = null;
	private objects = new Map<EntityTrack, THREE.Object3D>();
	private lastTarget: THREE.Vector3 | null = null;
	private propGroup = new THREE.Group();
	private sky = new THREE.Group();
	// 3D skybox: the map's miniature area seen from sky_camera, scaled up
	private skyCamera: {origin: THREE.Vector3; scale: number; fog: THREE.Fog | null} | null = null;
	private skyView = new THREE.PerspectiveCamera(VERTICAL_FOV, 1, 0.5, 40000);
	private worldFog: THREE.Fog | null = null;
	private files: GameFiles | null = null;
	private models = new Map<string, Promise<ModelAsset | null>>();
	private interval = 1 / 60;
	// portals seen this frame, by entity index, for views and laser hops
	private portals = new Map<number, {obj: THREE.Object3D; link: number; halfW: number; halfH: number}>();
	private portalCam = new THREE.PerspectiveCamera();
	private portalTargets = new Map<THREE.Object3D, THREE.WebGLRenderTarget>();
	private effects: EffectAssets | null = null;
	private fizzlers = new Map<string, THREE.ShaderMaterial>();
	private paint: PaintLayer | null = null;
	private mapToken = 0;
	onLoaded = () => {};

	constructor(container: HTMLElement) {
		this.container = container;
		if (import.meta.env.DEV) (window as unknown as {THREE: typeof THREE}).THREE = THREE;  // for debugging in the console
		this.camera.up.set(0, 0, 1);
		this.scene.background = new THREE.Color(0x0c0e12);
		this.scene.fog = new THREE.Fog(0x0c0e12, 6000, 30000);
		const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3f48, 1.6);
		hemi.position.set(0, 0, 1);
		const sun = new THREE.DirectionalLight(0xffffff, 1.2);
		sun.position.set(0.35, 0.25, 1);
		this.scene.add(hemi, sun, this.mapGroup, this.propGroup, this.entityGroup, this.sky);
		this.sky.renderOrder = -1;

		const body = new THREE.CapsuleGeometry(16, 40, 4, 12);
		body.rotateX(Math.PI / 2);
		body.translate(0, 0, 36);
		this.player = new THREE.Mesh(body, new THREE.MeshLambertMaterial({color: 0x5aa9ff, transparent: true, opacity: 0.85}));
		this.scene.add(this.player);
	}

	private ensureRenderer() {
		if (this.renderer) return this.renderer;
		this.renderer = new THREE.WebGLRenderer({antialias: true});
		// HDR lighting needs its highlights rolled off, as the game's tone
		// mapping does
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.1;
		this.renderer.setPixelRatio(window.devicePixelRatio || 1);
		this.container.appendChild(this.renderer.domElement);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = false;
		this.controls.enabled = this.mode === 'orbit';
		this.controls.addEventListener('change', () => this.render());
		return this.renderer;
	}

	setMode(mode: CameraMode) {
		this.mode = mode;
		if (this.controls) this.controls.enabled = mode === 'orbit';
		this.lastTarget = null;
		if (mode === 'orbit') {
			// start behind and above the player
			const p = this.player.position;
			this.camera.position.set(p.x - 500, p.y - 500, p.z + 450);
			this.controls?.target.set(p.x, p.y, p.z + 36);
			this.controls?.update();
		}
	}

	// a model, loaded once per map and skin (maps can carry their own models):
	// its groups with materials, skeleton, and geometry posed as the game
	// draws it unanimated (sequence 0)
	private model(name: string, skin = 0): Promise<ModelAsset | null> {
		const key = `${name.toLowerCase()}#${skin}`;
		let p = this.models.get(key);
		if (!p) {
			const files = this.files, library = this.library;
			const color: [number, number, number] = /cube|box/.test(key) ? [0.66, 0.73, 0.8] : [0.52, 0.52, 0.5];
			p = files && library
				? loadModel(files, name, color, skin).then(async (m: StudioModel | null) => {
					if (!m) return null;
					const skeleton = await loadSkeleton(files, m.bytes).catch(() => null);
					const rest = skeleton ? referencePose(skeleton) : null;
					const mats = skeleton && rest ? (samplePose(skeleton, 0, 0, rest), skinMatrices(skeleton, rest)) : null;
					const parts = m.groups.map(g => {
						const raw = geometry(g);
						const posed = mats ? bakePose(g, mats) : null;
						const baked = posed ? geometry({...g, positions: posed.positions, normals: posed.normals}) : raw;
						return {group: g, raw, baked, material: library.forModel(g.materialCandidates), name: `${name} ${g.materialCandidates[0]}`};
					});
					return {name, model: m, skeleton, parts};
				}).catch(() => null)
				: Promise.resolve(null);
			this.models.set(key, p);
		}
		return p;
	}

	// the model posed for drawing as is (static props)
	private staticObject(asset: ModelAsset): THREE.Group {
		const group = new THREE.Group();
		for (const part of asset.parts) {
			const mesh = new THREE.Mesh(part.baked, part.material);
			mesh.name = part.name;
			group.add(mesh);
		}
		return group;
	}

	private brushModel(m: ModelMesh): THREE.Group {
		const group = new THREE.Group();
		for (const g of m.groups) {
			const mesh = new THREE.Mesh(geometry(g), this.library!.forWorld(g));
			mesh.name = `brush ${g.material}`;
			if (g.surface === 'glass' || g.surface === 'liquid') mesh.renderOrder = 1;
			group.add(mesh);
		}
		return group;
	}

	setMap(bsp: BspMap | null, files: GameFiles | null = null, materials: Materials | null = null) {
		this.bsp = bsp;
		this.files = files;
		this.models.clear();
		this.mapGroup.clear();
		this.propGroup.clear();
		this.clearEntities();
		const token = ++this.mapToken;
		if (!bsp || !files || !materials) return;

		let lightTex: THREE.DataTexture | null = null;
		if (bsp.lightmap) {
			const lm = bsp.lightmap;
			const half = new Uint16Array(lm.data.length);
			for (let i = 0; i < lm.data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(lm.data[i]);
			lightTex = new THREE.DataTexture(half, lm.width, lm.height, THREE.RGBAFormat, THREE.HalfFloatType);
			lightTex.magFilter = lightTex.minFilter = THREE.LinearFilter;
			lightTex.channel = 1;
			lightTex.flipY = false;
			lightTex.needsUpdate = true;
		}
		this.library = new MaterialLibrary(files, materials, lightTex);
		this.library.onChange = () => this.onLoaded();
		this.effects = new EffectAssets(materials, this.library.textures);
		this.fizzlers.clear();
		this.paint = null;
		paintUniforms.paintOn.value = 0;

		// fog, from the map's fog controller
		const fog = bsp.entities.find(e => e.classname === 'env_fog_controller' && e.fogenable !== '0');
		if (fog) {
			const c = (fog.fogcolor ?? '0 0 0').split(/\s+/).map(Number);
			const color = new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
			this.scene.fog = new THREE.Fog(color, Number(fog.fogstart) || 0, Number(fog.fogend) || 30000);
			this.scene.background = color;
		} else {
			this.scene.fog = null;
			this.scene.background = new THREE.Color(0x000000);
		}

		this.mapGroup.add(this.brushModel(bsp.models[0]));
		this.loadSky(bsp, token);
		this.worldFog = this.scene.fog as THREE.Fog | null;

		const sc = bsp.entities.find(e => e.classname === 'sky_camera');
		this.skyCamera = null;
		if (sc) {
			const o = (sc.origin ?? '0 0 0').split(/\s+/).map(Number);
			let skyFog: THREE.Fog | null = null;
			if (sc.fogenable === '1') {
				const c = (sc.fogcolor ?? '0 0 0').split(/\s+/).map(Number);
				skyFog = new THREE.Fog(new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace), Number(sc.fogstart) || 0, Number(sc.fogend) || 30000);
			}
			this.skyCamera = {origin: new THREE.Vector3(o[0], o[1], o[2]), scale: Number(sc.scale) || 16, fog: skyFog};
			this.skyView.up.set(0, 0, 1);
		}

		// static props, as they load, with vrad's vertex lighting from the pak
		const pak = bsp.pak ? new Zip(bsp.pak) : null;
		for (const prop of bsp.staticProps) {
			Promise.all([
				this.model(prop.model, prop.skin),
				pak ? pak.read(`sp_hdr_${prop.index}.vhv`).then(b => b ?? pak.read(`sp_${prop.index}.vhv`)) : null,
			]).then(([asset, vhv]) => {
				if (!asset || token !== this.mapToken) return;
				const o = this.litProp(asset, vhv) ?? this.staticObject(asset);
				o.position.set(...prop.origin);
				o.rotation.copy(toEuler(prop.angles));
				o.updateMatrixWorld(true);
				o.matrixAutoUpdate = false;
				for (const c of o.children) c.matrixAutoUpdate = false;
				this.propGroup.add(o);
				this.onLoaded();
			});
		}
	}

	// The 2D skybox: six faces around the camera, drawn behind everything.
	// Face orientation follows Quake 2's, which Source kept: rt +X, lf +Y,
	// bk -X, ft -Y; each face's s/t run as in Quake 2's MakeSkyVec.
	private loadSky(bsp: BspMap, token: number) {
		this.sky.clear();
		const name = bsp.entities.find(e => e.classname === 'worldspawn')?.skyname;
		if (!name || !this.library) return;
		const faces: [string, (s: number, t: number) => [number, number, number]][] = [
			['rt', (s, t) => [1, -s, t]],
			['bk', (s, t) => [-1, s, t]],
			['lf', (s, t) => [s, 1, t]],
			['ft', (s, t) => [-s, -1, t]],
			['up', (s, t) => [-t, -s, 1]],
			['dn', (s, t) => [t, -s, -1]],
		];
		const library = this.library;
		for (const [side, at] of faces) {
			// HDR maps use <name>_hdr when it exists
			library.skyTexture(`skybox/${name}_hdr${side}`).then(t => t ?? library.skyTexture(`skybox/${name}${side}`)).then(tex => {
				if (!tex || token !== this.mapToken) return;
				const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
				const pos: number[] = [], uv: number[] = [];
				for (const i of [0, 1, 2, 0, 2, 3]) {
					const [cs, ct] = corners[i];
					pos.push(...at(cs, ct));
					uv.push((cs + 1) / 2, (1 - ct) / 2);
				}
				const g = new THREE.BufferGeometry();
				g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
				g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
				const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({map: tex, side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false}));
				mesh.frustumCulled = false;
				mesh.renderOrder = -1;
				this.sky.add(mesh);
				this.onLoaded();
			});
		}
	}

	// a static prop with its baked vertex light, or null without (usable) data
	private litProp(asset: ModelAsset, vhv: Uint8Array | null): THREE.Object3D | null {
		const light = vhv ? readVhv(vhv) : null;
		if (!light || light.checksum !== asset.model.checksum || !this.library) return null;
		const out = new THREE.Group();
		for (const part of asset.parts) {
			const mv = part.group.meshVertex;
			const colors = new Float32Array(mv.length * 3);
			for (let i = 0; i < mv.length; i++) {
				const vl = light.meshes[Math.floor(mv[i] / 1048576)];
				const k = (mv[i] % 1048576) * 4;
				if (!vl || k + 3 > vl.length) return null;
				colors[i * 3] = vl[k + 2] / 255;      // stored BGRA
				colors[i * 3 + 1] = vl[k + 1] / 255;
				colors[i * 3 + 2] = vl[k] / 255;
			}
			const g = part.baked.clone();
			g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
			const lit = new THREE.Mesh(g, this.library.forModel(part.group.materialCandidates, true));
			lit.name = part.name;
			out.add(lit);
		}
		return out;
	}

	setSegment(track: SegmentTrack, entities: EntityTimeline | null) {
		this.entities = entities;
		this.interval = track.seg.intervalPerTick;
		this.paint = this.bsp && entities?.paint.length ? new PaintLayer(this.bsp, entities.paint) : null;
		paintUniforms.paintMap.value = this.paint?.texture ?? null;
		paintUniforms.paintOn.value = this.paint ? 1 : 0;
		this.clearEntities();
		// the path as line segments, broken at teleports
		if (this.pathLine) this.scene.remove(this.pathLine);
		const views = track.seg.views;
		const pts: number[] = [];
		for (let i = 1; i < views.length; i++) {
			if (track.teleports[i]) continue;
			pts.push(...views[i - 1].origin, ...views[i].origin);
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
		this.pathLine = new THREE.LineSegments(g, new THREE.LineBasicMaterial({color: 0x47c17b, transparent: true, opacity: 0.7}));
		this.scene.add(this.pathLine);
		this.lastTarget = null;
	}

	private clearEntities() {
		this.entityGroup.clear();
		this.objects.clear();
	}

	private objectFor(t: EntityTrack): THREE.Object3D | null {
		let o = this.objects.get(t);
		if (o !== undefined) return o;
		o = this.makeObject(t) ?? new THREE.Group();
		o.visible = false;
		this.objects.set(t, o);
		this.entityGroup.add(o);
		return o;
	}

	private makeObject(t: EntityTrack): THREE.Object3D | null {
		if (t.className === 'CPortal_Player') {
			// the other player in co-op
			if (t === this.entities?.player) return null;
			const body = new THREE.CapsuleGeometry(16, 40, 4, 12);
			body.rotateX(Math.PI / 2);
			body.translate(0, 0, 36);
			return new THREE.Mesh(body, new THREE.MeshLambertMaterial({color: 0xff8a1f}));
		}
		if (t.className === 'CProp_Portal') {
			const group = new THREE.Group();
			const color = t.orange ? new THREE.Color(1.0, 0.45, 0.08) : new THREE.Color(0.15, 0.5, 1.0);
			const material = portalMaterial(color);
			const surface = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
			// plane in XY facing +Z -> facing the portal's forward (+X): its x
			// runs up the portal, y across
			surface.rotation.set(0, Math.PI / 2, 0);
			surface.rotateZ(Math.PI / 2);
			surface.scale.set(PORTAL_HALF_W, PORTAL_HALF_H, 1);
			surface.position.x = 0.6;
			group.add(surface);
			group.userData.portalSurface = surface;
			return group;
		}
		if (t.className === 'CPortalLaser') {
			const laser = new Laser(this.effects);
			laser.group.userData.laser = laser;
			return laser.group;
		}
		if (t.className === 'CProjectedWallEntity') {
			const bridge = new Bridge(this.effects);
			bridge.mesh.userData.bridge = bridge;
			return bridge.mesh;
		}
		if (t.className === 'CTrigger_TractorBeam') {
			const funnel = new Funnel(this.effects);
			funnel.mesh.userData.funnel = funnel;
			return funnel.mesh;
		}
		if (t.className === 'CTriggerPortalCleanser') {
			const b = /^\*(\d+)$/.exec(t.model);
			const m = b && this.bsp?.models[Number(b[1])];
			if (!m) return null;
			const group = new THREE.Group();
			for (const g of m.groups) {
				// each face's own material (fizzler, fizzler_center, edges...)
				let mat = this.fizzlers.get(g.material);
				if (!mat) {
					mat = fizzlerMaterial(this.effects, g.material);
					this.fizzlers.set(g.material, mat);
				}
				const mesh = new THREE.Mesh(geometry(g), mat);
				mesh.renderOrder = 2;
				group.add(mesh);
			}
			return group;
		}
		const brush = /^\*(\d+)$/.exec(t.model);
		if (brush && this.bsp) {
			const m = this.bsp.models[Number(brush[1])];
			if (!m || !m.groups.length || !this.library) return null;
			return this.brushModel(m);
		}
		if (HIDDEN_CLASSES.has(t.className) || !t.model.endsWith('.mdl')) return null;
		const size = [t.maxs[0] - t.mins[0], t.maxs[1] - t.mins[1], t.maxs[2] - t.mins[2]];
		if (size.some(s => s <= 0) || size.some(s => s > 1024)) return null;
		const cube = /cube|box/i.test(t.model);
		const group = new THREE.Group();
		const box = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), new THREE.MeshLambertMaterial({color: cube ? 0x9fb7cf : 0x8a7f6e, transparent: !cube, opacity: cube ? 1 : 0.55}));
		box.position.set((t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, (t.mins[2] + t.maxs[2]) / 2);
		group.add(box);
		// swap the box for the real model when it loads, animated when it can be
		this.model(t.model).then(asset => {
			if (!asset) return;
			group.remove(box);
			if (asset.skeleton && asset.skeleton.sequences.length && t.keys.some(k => k.anim)) {
				const anim = new AnimatedModel(asset.skeleton, asset.parts.map(p => ({geometry: skinnedGeometry(p.group, p.raw), material: p.material})));
				group.add(anim.group);
				group.userData.anim = anim;
				group.userData.skeleton = asset.skeleton;
			} else {
				group.add(this.staticObject(asset));
			}
			this.onLoaded();
		});
		return group;
	}

	// whether an entity's object is drawn at a key
	private shows(t: EntityTrack, k: EntityKey): boolean {
		const e = k.extra ?? {};
		switch (t.className) {
		case 'CProp_Portal': return k.visible && k.active === true;
		case 'CPortalLaser': return Number(e.m_bLaserOn) === 1 && !!vec3(e.m_vEndPoint);
		case 'CProjectedWallEntity': return !!vec3(e.m_vecStartPoint) && !!vec3(e.m_vecEndPoint);
		case 'CTrigger_TractorBeam': return Number(e.m_bDisabled) !== 1 && !!vec3(e.m_vStart);
		case 'CTriggerPortalCleanser': return Number(e.m_bVisible) === 1 && Number(e.m_bDisabled) !== 1;
		default: return k.visible;
		}
	}

	private placeEffect(t: EntityTrack, k: EntityKey, o: THREE.Object3D, time: number) {
		const e = k.extra ?? {};
		o.position.set(0, 0, 0);
		o.rotation.set(0, 0, 0);
		if (o.userData.laser) {
			(o.userData.laser as Laser).set(this.laserPath(vec3(e.m_vStartPoint)!, vec3(e.m_vEndPoint)!), this.camera.position);
		} else if (o.userData.bridge) {
			// across the bridge: the entity's right (-Y), turned by its angles
			const right = new THREE.Vector3(0, -1, 0).applyEuler(toEuler(k.angles));
			(o.userData.bridge as Bridge).set(vec3(e.m_vecStartPoint)!, vec3(e.m_vecEndPoint)!, right, Number(e.m_flWidth) || 64, time);
		} else if (o.userData.funnel) {
			(o.userData.funnel as Funnel).set(vec3(e.m_vStart)!, vec3(e.m_vEnd)!, Number(e.m_flRadius) || 55, Number(e.m_bReversed) === 1, time);
		}
	}

	// the matrix taking things in front of portal `from` to the same place
	// relative to its linked portal (entering one, leaving the other)
	private portalTransform(from: THREE.Object3D, to: THREE.Object3D): THREE.Matrix4 {
		from.updateMatrixWorld();
		to.updateMatrixWorld();
		return to.matrixWorld.clone().multiply(R180Z).multiply(from.matrixWorld.clone().invert());
	}

	// a laser's beam, continued through any portals it ends on (traced
	// against the map from the exit portal)
	private laserPath(start: THREE.Vector3, end: THREE.Vector3): [THREE.Vector3, THREE.Vector3][] {
		const out: [THREE.Vector3, THREE.Vector3][] = [[start, end]];
		let a = start, b = end;
		for (let hop = 0; hop < 4; hop++) {
			const dir = b.clone().sub(a).normalize();
			let through: {from: THREE.Object3D; to: THREE.Object3D} | null = null;
			for (const p of this.portals.values()) {
				const local = p.obj.worldToLocal(b.clone());
				const linked = this.portals.get(p.link);
				if (linked && Math.abs(local.x) < 4 && (local.y / p.halfW) ** 2 + (local.z / p.halfH) ** 2 <= 1.05) {
					through = {from: p.obj, to: linked.obj};
					break;
				}
			}
			if (!through) break;
			const m = this.portalTransform(through.from, through.to);
			const origin = b.clone().applyMatrix4(m);
			const newDir = dir.clone().transformDirection(m);
			const ray = new THREE.Raycaster(origin.clone().addScaledVector(newDir, 2), newDir, 0, 16384);
			const hit = ray.intersectObjects([this.mapGroup, this.propGroup], true)[0];
			a = origin;
			b = hit ? hit.point.clone() : origin.clone().addScaledVector(newDir, 16384);
			out.push([a, b]);
		}
		return out;
	}

	// what each visible, linked portal shows: the scene from the camera moved
	// through the portal pair, clipped at the exit portal
	private renderPortalViews(r: THREE.WebGLRenderer) {
		const size = r.getDrawingBufferSize(new THREE.Vector2());
		const dither = ditherUniforms.ditherOn.value;
		ditherUniforms.ditherOn.value = 0;
		const seen = new Set<THREE.Object3D>();
		for (const p of this.portals.values()) {
			const surface = p.obj.userData.portalSurface as THREE.Mesh;
			const material = surface.material as THREE.ShaderMaterial;
			const linked = this.portals.get(p.link);
			seen.add(p.obj);
			if (!linked) {
				material.uniforms.hasView.value = 0;
				continue;
			}
			let rt = this.portalTargets.get(p.obj);
			if (!rt) {
				rt = new THREE.WebGLRenderTarget(size.x, size.y, {type: THREE.HalfFloatType});
				this.portalTargets.set(p.obj, rt);
			}
			if (rt.width !== size.x || rt.height !== size.y) rt.setSize(size.x, size.y);

			// the main camera's pose moved through the portal pair, set as an
			// ordinary position and rotation so three keeps its matrices
			const m = this.portalTransform(p.obj, linked.obj).multiply(this.camera.matrixWorld);
			const cam = this.portalCam;
			cam.fov = this.camera.fov;
			cam.aspect = this.camera.aspect;
			cam.near = this.camera.near;
			cam.far = this.camera.far;
			cam.updateProjectionMatrix();
			m.decompose(cam.position, cam.quaternion, cam.scale);
			cam.updateMatrixWorld(true);

			// clip away what's behind the exit portal's wall
			const normal = new THREE.Vector3(1, 0, 0).transformDirection(linked.obj.matrixWorld);
			const at = new THREE.Vector3().setFromMatrixPosition(linked.obj.matrixWorld);
			r.clippingPlanes = [new THREE.Plane(normal, -normal.dot(at) + 0.5)];
			const linkedSurface = linked.obj.userData.portalSurface as THREE.Mesh;
			surface.visible = linkedSurface.visible = false;
			this.sky.position.setFromMatrixPosition(cam.matrixWorld);
			r.setRenderTarget(rt);
			r.render(this.scene, cam);
			r.setRenderTarget(null);
			r.clippingPlanes = [];
			surface.visible = linkedSurface.visible = true;

			material.uniforms.view.value = rt.texture;
			material.uniforms.hasView.value = 1;
			material.uniforms.resolution.value.copy(size);
		}
		ditherUniforms.ditherOn.value = dither;
		// targets of portals that are gone
		for (const [obj, rt] of this.portalTargets) {
			if (!seen.has(obj)) {
				rt.dispose();
				this.portalTargets.delete(obj);
			}
		}
	}

	// an entity's sequence and cycle at a tick: the server's cycle,
	// interpolated between updates, or for client-side animation advanced from
	// when the sequence (re)started
	private animAt(t: EntityTrack, tick: number, sk: Skeleton): [number, number] {
		const i = keyIndexAt(t, tick);
		const k = t.keys[i];
		const a = k.anim!;
		const looping = sk.sequences[a.sequence]?.looping ?? false;
		const wrap = (c: number) => (looping ? c - Math.floor(c) : Math.min(1, Math.max(0, c)));
		if (a.clientSide) {
			let start = i;
			while (start > 0) {
				const p = t.keys[start - 1].anim;
				if (!p || p.sequence !== a.sequence || p.parity !== a.parity) break;
				start--;
			}
			const elapsed = (tick - t.keys[start].tick) * this.interval;
			return [a.sequence, wrap(t.keys[start].anim!.cycle + elapsed * a.rate * sequenceRate(sk, a.sequence))];
		}
		const n = t.keys[i + 1]?.anim;
		if (!n || n.sequence !== a.sequence || n.parity !== a.parity) return [a.sequence, a.cycle];
		let c1 = n.cycle;
		if (looping && c1 < a.cycle) c1 += 1;
		const f = (tick - k.tick) / Math.max(1, t.keys[i + 1].tick - k.tick);
		return [a.sequence, wrap(a.cycle + (c1 - a.cycle) * f)];
	}

	resize() {
		const r = this.ensureRenderer();
		const w = this.container.clientWidth, h = this.container.clientHeight;
		if (!w || !h) return;
		const size = r.getSize(new THREE.Vector2());
		if (size.x !== w || size.y !== h) {
			r.setSize(w, h, false);  // CSS sizes the canvas
			this.camera.aspect = w / h;
			this.camera.updateProjectionMatrix();
		}
	}

	update(view: ViewState | null, tick: number) {
		this.resize();
		const ents = this.entities;
		if (ents) {
			this.portals.clear();
			const time = performance.now() / 1000;
			for (const m of this.fizzlers.values()) m.uniforms.time.value = time;
			this.paint?.seek(tick);
			for (const t of ents.tracks) {
				const k = keyAt(t, tick);
				const show = !!k && this.shows(t, k);
				const o = show ? this.objectFor(t) : this.objects.get(t);
				if (!o) continue;
				o.visible = show;
				if (show && k && WORLD_SPACE.has(t.className)) {
					this.placeEffect(t, k, o, time);
					continue;
				}
				if (show && k) {
					const anim = o.userData.anim as AnimatedModel | undefined;
					if (anim && k.anim) {
						const [seq, cycle] = this.animAt(t, tick, o.userData.skeleton);
						anim.setPose(seq, cycle);
					}
					o.position.set(k.origin[0], k.origin[1], k.origin[2]);
					// players turn with their view but don't tilt
					o.rotation.copy(toEuler(t.className === 'CPortal_Player' ? [0, k.angles[1], 0] : k.angles));
					if (o.userData.portalSurface) {
						const e = k.extra ?? {};
						const surface = o.userData.portalSurface as THREE.Mesh;
						const halfW = Number(e.m_fNetworkHalfWidth) || PORTAL_HALF_W, halfH = Number(e.m_fNetworkHalfHeight) || PORTAL_HALF_H;
						surface.scale.set(halfW, halfH, 1);
						(surface.material as THREE.ShaderMaterial).uniforms.time.value = time;
						this.portals.set(t.index, {obj: o, link: Number(e.m_hLinkedPortal ?? -1) & 2047, halfW, halfH});
					}
				}
			}
		}

		// player: the decoded entity where there is one, else the recorded view
		const pk = ents?.player ? keyAt(ents.player, tick) : undefined;
		const feet = pk ? new THREE.Vector3(...pk.origin) : view ? new THREE.Vector3(...view.origin) : null;
		// screen-door dissolve of whatever is between the orbit camera and the player
		ditherUniforms.ditherOn.value = feet && this.mode === 'orbit' ? 1 : 0;
		if (feet) ditherUniforms.ditherTarget.value.copy(feet).add(new THREE.Vector3(0, 0, 36));
		if (feet) {
			this.player.position.copy(feet);
			this.player.visible = this.mode === 'orbit';
			const eye = feet.clone();
			eye.z += pk?.eyeZ ?? DEFAULT_EYE;
			if (this.mode === 'eyes') {
				const ang = view?.angles ?? pk?.angles ?? [0, 0, 0];
				this.camera.position.copy(eye);
				const pitch = ang[0] * Math.PI / 180, yaw = ang[1] * Math.PI / 180;
				const fwd = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch));
				this.camera.lookAt(eye.clone().add(fwd));
			} else if (this.controls) {
				// follow: move the camera with the player, keep the user's angle
				const target = feet.clone();
				target.z += 36;
				if (this.lastTarget) this.camera.position.add(target.clone().sub(this.lastTarget));
				this.controls.target.copy(target);
				this.lastTarget = target;
				this.controls.update();
			}
		}
		this.render();
	}

	render() {
		const r = this.renderer;
		if (!r) return;
		this.camera.updateMatrixWorld();
		if (this.portals.size) this.renderPortalViews(r);
		// the sky stays centred on the camera, inside the far plane
		this.sky.scale.setScalar(this.camera.far * 0.5);
		const sc = this.skyCamera;
		if (!sc) {
			this.sky.position.copy(this.camera.position);
			r.render(this.scene, this.camera);
			return;
		}

		// 3D skybox first: the same scene from sky_camera, at 1/scale of the
		// view's position, with its own fog; then the map over it (its sky
		// faces aren't drawn, so the skybox shows through)
		const background = this.scene.background;
		const hidden = ([this.entityGroup, this.player, this.pathLine] as (THREE.Object3D | null)[]).filter((o): o is THREE.Object3D => !!o && o.visible);
		r.autoClear = false;
		if (background instanceof THREE.Color) r.setClearColor(background);
		r.clear();
		this.scene.background = null;

		this.skyView.position.copy(sc.origin).addScaledVector(this.camera.position, 1 / sc.scale);
		this.skyView.quaternion.copy(this.camera.quaternion);
		this.skyView.fov = this.camera.fov;
		this.skyView.aspect = this.camera.aspect;
		this.skyView.updateProjectionMatrix();
		this.sky.position.copy(this.skyView.position);
		for (const o of hidden) o.visible = false;
		this.scene.fog = sc.fog;
		const dither = ditherUniforms.ditherOn.value;
		ditherUniforms.ditherOn.value = 0;
		r.render(this.scene, this.skyView);
		ditherUniforms.ditherOn.value = dither;
		for (const o of hidden) o.visible = true;

		r.clearDepth();
		this.sky.visible = false;
		this.scene.fog = this.worldFog;
		r.render(this.scene, this.camera);
		this.sky.visible = true;
		this.scene.background = background;
		r.autoClear = true;
	}

	// debugging: what's under a point of the canvas (0..1 coordinates)
	pick(x: number, y: number) {
		const ray = new THREE.Raycaster();
		ray.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), this.camera);
		const hit = ray.intersectObjects([this.mapGroup, this.propGroup, this.entityGroup], true)[0];
		if (!hit) return null;
		let o: THREE.Object3D | null = hit.object;
		const path: string[] = [];
		while (o) {
			path.push(o.name || o.type);
			o = o.parent;
		}
		const mat = (hit.object as THREE.Mesh).material as THREE.MeshBasicMaterial;
		return {path, point: hit.point.toArray().map(Math.round), material: mat.name, hasMap: !!mat.map, vertexColors: mat.vertexColors, type: mat.type};
	}
}
