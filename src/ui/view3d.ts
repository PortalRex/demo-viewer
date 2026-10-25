// 3D replay: the map's geometry from the viewer's own game files, with the
// recorded entities (portals, brush entities, props) and the player's view.
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {MeshBVH} from 'three-mesh-bvh';
import {composeLightmap, styleValue} from '../game/bsp.ts';
import type {BspMap, MeshData, MaterialGroup, ModelMesh} from '../game/bsp.ts';
import type {GameFiles} from '../game/files.ts';
import type {Materials, MaterialInfo} from '../game/materials.ts';
import {loadModel} from '../game/mdl.ts';
import type {StudioModel, ModelGroup} from '../game/mdl.ts';
import {loadSkeleton, referencePose, samplePose, sequenceRate} from '../game/anim.ts';
import type {Skeleton} from '../game/anim.ts';
import {AnimatedModel, attachmentMatrix, bakePose, boneMatrices, skinMatrices, skinnedGeometry} from './skinning.ts';
import {Laser, Bridge, Funnel, fizzlerMaterial, portalMaterial, vec3, EffectAssets} from './effects.ts';
import {PaintLayer} from './paint.ts';
import {ParticleLibrary, ParticleInstance, ParticleRenderer} from './particles.ts';
import {paintUniforms, ditherUniforms, fogUniforms, gooUniforms, hookWorldMaterial, hookModelMaterial} from './shaderhooks.ts';
import {TextureCache} from './textures.ts';
import {Zip} from '../game/zip.ts';
import {readVhv} from '../game/vhv.ts';
import type {EntityTimeline, EntityTrack, EntityKey} from '../net/entities.ts';
import {keyAt, keyIndexAt} from '../net/entities.ts';
import type {SegmentTrack, ViewState} from '../player/playback.ts';
import type {Vec3} from '../core/model.ts';

export type CameraMode = 'eyes' | 'orbit' | 'free';

// Portal 2's 90° horizontal FOV at 4:3, as a vertical FOV (widescreen keeps it)
const VERTICAL_FOV = 2 * Math.atan(Math.tan(Math.PI / 4) * 3 / 4) * 180 / Math.PI;
const DEFAULT_EYE = 64;
const PORTAL_HALF_W = 32, PORTAL_HALF_H = 56;
// viewmodel_fov 50 (horizontal, at 4:3), as a vertical angle
const VIEWMODEL_FOV = 2 * Math.atan(Math.tan(25 * Math.PI / 180) * 3 / 4) * 180 / Math.PI;

// entity classes that aren't worth a box
const HIDDEN_CLASSES = new Set([
	'CPredictedViewModel', 'CBaseViewModel', 'CFuncPortalBumper', 'CFuncNoPortalVolume',
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
// Portal 2's lightmaps (and prop vertex lighting) come out of the shaders
// 16x brighter than the stored linear values (the integer-HDR lightmap
// scale); the frame is then scaled by the auto exposure and clamped, with no
// filmic curve.
const LIGHTMAP_EXPOSURE = 16;

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
		if (info.shader === 'water' && info.baseTexture) {
			// goo: opaque (its fog ends within inches), flowing, lit
			mat.transparent = false;
			mat.depthWrite = true;
			mat.opacity = 1;
			mat.defines = {...mat.defines, GOO: ''};
		} else if (info.translucent || info.liquid) {
			mat.transparent = true;
			mat.depthWrite = false;
			mat.opacity = info.liquid && !info.baseTexture ? 0.6 : info.alpha;
			if (info.additive) mat.blending = THREE.AdditiveBlending;
		} else if (info.alphaTest) {
			mat.alphaTest = 0.5;
		}
		if (info.noCull || info.translucent || info.alphaTest) {
			mat.side = THREE.DoubleSide;
			mat.userData.twoSided = true;
			if (mat.defines) delete mat.defines.BACKFACE_SHADE;
		}
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

	// draw the backs of the world's one-sided faces too (shaded darker), or not
	setBackFaces(on: boolean) {
		this.backFaces = on;
		for (const m of this.world.values()) this.applyBackFaces(m);
	}
	private backFaces = false;

	private applyBackFaces(m: THREE.Material) {
		if (m.userData.twoSided || m.transparent) return;
		const want = this.backFaces;
		if ((m.side === THREE.DoubleSide) === want) return;
		m.side = want ? THREE.DoubleSide : THREE.FrontSide;
		m.defines ??= {};
		if (want) m.defines.BACKFACE_SHADE = '';
		else delete m.defines.BACKFACE_SHADE;
		m.needsUpdate = true;
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
			this.applyBackFaces(mat);
			mat.needsUpdate = true;
			this.onChange();
		});
		this.applyBackFaces(mat);
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

interface FogSettings {
	color: number[];  // 0..255, gamma
	start: number;
	end: number;
	maxDensity: number;
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
	private lightTex: THREE.DataTexture | null = null;
	private styleValues = new Map<number, number>();  // what the lightmap texture was composed with
	// fog (colour 0..255, gamma) and auto exposure: the map's defaults until
	// the player's controllers say otherwise
	private fogBase: FogSettings | null = null;
	private fog: FogSettings | null = null;
	private exposure = 2;
	private exposureRange: [number, number] = [0.5, 2];
	private meter: THREE.WebGLRenderTarget | null = null;
	private meterCount = 0;
	private lastRender = 0;
	private tracksByIndex = new Map<number, EntityTrack[]>();
	// the world's solid faces, for keeping the orbit camera inside the map
	private collision: MeshBVH | null = null;
	// particle effects: info_particle_system entities, each active run an instance
	private particleLib: ParticleLibrary | null = null;
	private particleRenderer: ParticleRenderer | null = null;
	private particleRuns = new Map<EntityTrack, {start: number; inst: ParticleInstance}>();
	private particlesShown: ParticleInstance[] = [];
	// first-person view model (the portal gun), drawn over the world in
	// Eyes view with its own field of view, as the game does
	private vmScene = new THREE.Scene();
	private vmCam = new THREE.PerspectiveCamera(VIEWMODEL_FOV, 1, 1, 2000);
	private vmObjects = new Map<EntityTrack, THREE.Group>();
	private vmShown: THREE.Group | null = null;
	private eyeAngles: number[] = [0, 0, 0];
	// free camera: held movement keys, view angles (degrees), drag state
	private freeKeys = new Set<string>();
	private freeAngles = [0, 0];  // pitch, yaw
	private freeDrag: {x: number; y: number} | null = null;
	private freeFrame = 0;
	private freeLast = 0;
	private mapToken = 0;
	onLoaded = () => {};

	constructor(container: HTMLElement) {
		this.container = container;
		if (import.meta.env.DEV) (window as unknown as {THREE: typeof THREE}).THREE = THREE;  // for debugging in the console
		this.camera.up.set(0, 0, 1);
		this.scene.background = new THREE.Color(0x0c0e12);
		this.scene.fog = new THREE.Fog(0x0c0e12, 6000, 30000);
		const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3f48, 0.55);
		hemi.position.set(0, 0, 1);
		const sun = new THREE.DirectionalLight(0xffffff, 0.4);
		sun.position.set(0.35, 0.25, 1);
		this.scene.add(hemi, sun, this.mapGroup, this.propGroup, this.entityGroup, this.sky);
		this.sky.renderOrder = 2;

		const body = new THREE.CapsuleGeometry(16, 40, 4, 12);
		body.rotateX(Math.PI / 2);
		body.translate(0, 0, 36);
		this.player = new THREE.Mesh(body, new THREE.MeshLambertMaterial({color: 0x5aa9ff, transparent: true, opacity: 0.85}));
		this.scene.add(this.player);
		const vmHemi = new THREE.HemisphereLight(0xffffff, 0x3a3f48, 0.55);
		vmHemi.position.set(0, 0, 1);
		const vmSun = new THREE.DirectionalLight(0xffffff, 0.4);
		vmSun.position.set(0.35, 0.25, 1);
		this.vmScene.add(vmHemi, vmSun);
		this.vmCam.up.set(0, 0, 1);
	}

	private ensureRenderer() {
		if (this.renderer) return this.renderer;
		this.renderer = new THREE.WebGLRenderer({antialias: true, stencil: true});
		// HDR lighting needs its highlights rolled off, as the game's tone
		// mapping does
		this.renderer.toneMapping = THREE.LinearToneMapping;
		this.renderer.toneMappingExposure = 3;
		this.renderer.setPixelRatio(window.devicePixelRatio || 1);
		this.container.appendChild(this.renderer.domElement);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = false;
		this.controls.enabled = this.mode === 'orbit';
		this.controls.addEventListener('change', () => this.render());
		this.bindFreeCamera(this.renderer.domElement);
		return this.renderer;
	}

	setMode(mode: CameraMode) {
		this.library?.setBackFaces(mode !== 'eyes');
		if (mode === 'free' && this.mode !== 'free') {
			// start from wherever the camera is, looking the same way
			const dir = this.camera.getWorldDirection(new THREE.Vector3());
			this.freeAngles = [-Math.asin(Math.max(-1, Math.min(1, dir.z))) * 180 / Math.PI, Math.atan2(dir.y, dir.x) * 180 / Math.PI];
		}
		this.mode = mode;
		this.freeKeys.clear();
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
		this.lightTex = lightTex;
		this.styleValues.clear();
		this.tracksByIndex.clear();
		this.library = new MaterialLibrary(files, materials, lightTex);
		this.library.setBackFaces(this.mode !== 'eyes');
		this.library.onChange = () => this.onLoaded();
		this.effects = new EffectAssets(materials, this.library.textures);
		if (this.particleRenderer) {
			this.particleRenderer.clear();
			this.scene.remove(this.particleRenderer.group);
		}
		this.particleLib = new ParticleLibrary(files, bsp.name);
		this.particleRenderer = new ParticleRenderer(files, materials, this.library.textures);
		this.scene.add(this.particleRenderer.group);
		this.particleRuns.clear();
		this.fizzlers.clear();
		this.paint = null;
		paintUniforms.paintOn.value = 0;

		// fog until the recording names the player's fog controller: the
		// map's first enabled one
		const fog = bsp.entities.find(e => e.classname === 'env_fog_controller' && e.fogenable !== '0');
		this.fogBase = fog ? {
			color: (fog.fogcolor ?? '0 0 0').split(/\s+/).map(Number).slice(0, 3),
			start: Number(fog.fogstart) || 0,
			end: Number(fog.fogend) || 30000,
			maxDensity: fog.fogmaxdensity ? Number(fog.fogmaxdensity) : 1,
		} : null;
		this.fog = this.fogBase;
		this.scene.fog = fog ? new THREE.Fog(0, 0, 1) : null;
		this.scene.background = new THREE.Color(0x000000);
		// the exposure range Portal 2's test chambers set on the tonemap
		// controller (global_ents' environment relays), until the recording
		// has the controller's own values
		this.exposureRange = [0.5, 3];
		this.exposure = 3;

		this.mapGroup.add(this.brushModel(bsp.models[0]));
		// the sky faces mark (in the stencil) where the 2D skybox shows, as in
		// the game: elsewhere, e.g. the backs of walls when out of bounds,
		// it's the fog colour
		if (bsp.skyFaces.length) {
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(bsp.skyFaces, 3));
			const mask = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
				colorWrite: false, depthWrite: false, side: THREE.DoubleSide, fog: false,
				stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
			}));
			mask.renderOrder = 1;
			mask.name = 'sky mask';
			this.mapGroup.add(mask);
		}
		this.collision = worldCollision(bsp.models[0]);
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
				const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
					map: tex, side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false,
					// only through the sky faces (drawn just before, see setMap)
					stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc,
				}));
				mesh.frustumCulled = false;
				mesh.renderOrder = 2;
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
		this.tracksByIndex.clear();
		for (const t of entities?.tracks ?? []) {
			const list = this.tracksByIndex.get(t.index);
			if (list) list.push(t);
			else this.tracksByIndex.set(t.index, [t]);
		}
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
		this.particleRuns.clear();
		this.particlesShown = [];
		this.entityGroup.clear();
		this.objects.clear();
		for (const g of this.vmObjects.values()) this.vmScene.remove(g);
		this.vmObjects.clear();
		this.vmShown = null;
	}

	private objectFor(t: EntityTrack, skin = 0): THREE.Object3D | null {
		let o = this.objects.get(t);
		if (o !== undefined) {
			if ((o.userData.skin ?? 0) === skin || !t.model.endsWith('.mdl')) return o;
			// a new skin (a cube lighting up on a button): rebuild
			this.entityGroup.remove(o);
			this.objects.delete(t);
		}
		o = this.makeObject(t, skin) ?? new THREE.Group();
		o.userData.skin = skin;
		o.visible = false;
		this.objects.set(t, o);
		this.entityGroup.add(o);
		return o;
	}

	private makeObject(t: EntityTrack, skin = 0): THREE.Object3D | null {
		if (t.className === 'CPortal_Player') {
			// the player's own model (Chell, ATLAS, P-body); a capsule until it loads
			const group = new THREE.Group();
			const body = new THREE.CapsuleGeometry(16, 40, 4, 12);
			body.rotateX(Math.PI / 2);
			body.translate(0, 0, 36);
			const capsule = new THREE.Mesh(body, new THREE.MeshLambertMaterial({color: /eggbot/.test(t.model) ? 0xff8a1f : 0x5aa9ff}));
			group.add(capsule);
			this.model(t.model || 'models/player/chell/player.mdl', skin).then(asset => {
				if (!asset?.skeleton) return;
				group.remove(capsule);
				const anim = new AnimatedModel(asset.skeleton, asset.parts.map(p => ({geometry: skinnedGeometry(p.group, p.raw), material: p.material})));
				group.add(anim.group);
				group.userData.anim = anim;
				group.userData.skeleton = asset.skeleton;
				this.onLoaded();
			});
			return group;
		}
		if (t.className === 'CWeaponPortalgun') {
			// the gun in a player's hand (the third-person model; the
			// network carries the view model's name)
			const group = new THREE.Group();
			// Bone-merged as the game does: the gun's weapon_bone takes the
			// hand's weapon_bone transform, so the mesh is drawn unposed and
			// brought into that bone's space with its bind (pose-to-bone) matrix
			this.model('models/weapons/w_portalgun.mdl', skin).then(asset => {
				if (!asset) return;
				const inner = new THREE.Group();
				for (const part of asset.parts) inner.add(new THREE.Mesh(part.raw, part.material));
				const bone = asset.skeleton?.bones.find(b => b.name.toLowerCase() === 'weapon_bone') ?? asset.skeleton?.bones[0];
				if (bone) {
					const m = bone.poseToBone;
					inner.matrix.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
					inner.matrixAutoUpdate = false;
				}
				group.add(inner);
				this.onLoaded();
			});
			return group;
		}
		if (t.className === 'CProp_Portal') {
			const group = new THREE.Group();
			const material = portalMaterial(this.effects, !!t.orange);
			const surface = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
			// plane in XY facing +Z -> facing the portal's forward (+X): its x
			// runs across the portal (+Y), y up (+Z)
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
		const group = new THREE.Group();
		// a box of the entity's size until the model loads (not for huge
		// ones: room-moving panels and the like just appear)
		let box: THREE.Mesh | null = null;
		if (size.every(s => s > 0 && s <= 512)) {
			const cube = /cube|box/i.test(t.model);
			box = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), new THREE.MeshLambertMaterial({color: cube ? 0x9fb7cf : 0x8a7f6e, transparent: !cube, opacity: cube ? 1 : 0.55}));
			box.position.set((t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, (t.mins[2] + t.maxs[2]) / 2);
			group.add(box);
		}
		// the real model when it loads, animated when it can be
		this.model(t.model, skin).then(asset => {
			if (box) group.remove(box);
			if (!asset) return;
			if (asset.skeleton && asset.skeleton.sequences.length && t.keys.some(k => k.anim)) {
				const anim = new AnimatedModel(asset.skeleton, asset.parts.map(p => ({geometry: skinnedGeometry(p.group, p.raw), material: p.material})));
				group.add(anim.group);
				group.userData.anim = anim;
				group.userData.skeleton = asset.skeleton;
			} else {
				group.add(this.staticObject(asset));
				// as drawn: posed with sequence 0, for anything attached to it
				if (asset.skeleton) {
					group.userData.skeleton = asset.skeleton;
					const pose = referencePose(asset.skeleton);
					if (asset.skeleton.sequences.length) samplePose(asset.skeleton, 0, 0, pose);
					group.userData.staticBones = boneMatrices(asset.skeleton, pose);
				}
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
				// with a stencil, for the sky mask
				rt = new THREE.WebGLRenderTarget(size.x, size.y, {type: THREE.HalfFloatType, stencilBuffer: true});
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
	// Entities attached to others (panels on robot arms, things carried by
	// moving platforms): their origin and angles are relative to the parent,
	// or to an attachment point on the parent's posed model
	private placeAttached(tick: number) {
		for (const [t, o] of this.objects) {
			if (!o.visible) continue;
			const k = keyAt(t, tick);
			if (!k || k.parent === undefined) {
				o.matrixAutoUpdate = true;
				continue;
			}
			const m = this.worldMatrix(t, k, tick, 0);
			if (!m) {
				// not placeable yet (the parent's model is loading): not at the origin
				o.visible = false;
				continue;
			}
			o.matrixAutoUpdate = false;
			o.matrix.copy(m);
			o.matrixWorldNeedsUpdate = true;
		}
	}

	private worldMatrix(t: EntityTrack, k: EntityKey, tick: number, depth: number): THREE.Matrix4 | null {
		if (t.className === 'CWeaponPortalgun' && k.parent !== undefined) return this.handMatrix(k.parent, tick);
		const local = new THREE.Matrix4().compose(
			new THREE.Vector3(k.origin[0], k.origin[1], k.origin[2]),
			new THREE.Quaternion().setFromEuler(toEuler(t.className === 'CPortal_Player' ? [0, k.angles[1], 0] : k.angles)),
			new THREE.Vector3(1, 1, 1));
		if (k.parent === undefined || depth > 8) return local;
		let pt: EntityTrack | undefined, pk: EntityKey | undefined;
		for (const c of this.tracksByIndex.get(k.parent) ?? []) {
			const ck = keyAt(c, tick);
			if (ck) {
				pt = c;
				pk = ck;
				break;
			}
		}
		if (!pt || !pk) return local;
		const parent = this.worldMatrix(pt, pk, tick, depth + 1);
		if (!parent) return null;
		if (k.attachment) {
			const po = this.objects.get(pt) ?? this.objectFor(pt);
			const sk = po?.userData.skeleton as Skeleton | undefined;
			if (!sk) return null;  // until the parent's model loads
			const anim = po!.userData.anim as AnimatedModel | undefined;
			if (anim && pk.anim) {
				const [seq, cycle] = this.animAt(pt, tick, sk);
				anim.setPose(seq, cycle);
			}
			const bones = anim ? boneMatrices(sk, anim.pose) : po!.userData.staticBones as THREE.Matrix4[];
			const att = bones && attachmentMatrix(sk, bones, k.attachment - 1);
			if (att) parent.multiply(att);
		}
		return parent.multiply(local);
	}

	// the tick a portal was last placed (moved or activated) at or before `tick`
	private portalPlacedAt(t: EntityTrack, tick: number): number {
		let i = keyIndexAt(t, tick);
		while (i > 0) {
			const k = t.keys[i], prev = t.keys[i - 1];
			if (prev.active !== k.active || prev.origin.some((v, j) => Math.abs(v - k.origin[j]) > 0.5)) return k.tick;
			i--;
		}
		// first seen already open: placed then, unless that's the recording's start
		return i >= 0 && t.keys[i].tick > 1 ? t.keys[i].tick : tick - 1000;
	}

	// info_particle_system effects: a run from when one is switched on to
	// when it's switched off (its particles then live out their lives),
	// simulated from its start so seeking anywhere shows the same thing
	private updateParticles(tick: number) {
		const ents = this.entities, lib = this.particleLib;
		this.particlesShown = [];
		if (!ents || !lib) return;
		const LINGER = 5;
		for (const t of ents.tracks) {
			if (t.className !== 'CParticleSystem') continue;
			const i = keyIndexAt(t, tick);
			if (i < 0) continue;
			const isOn = (j: number) => Number(t.keys[j].extra?.m_bActive) === 1;
			// the latest run started at or before this tick
			let j = i;
			while (j >= 0 && !isOn(j)) j--;
			if (j < 0) {
				this.particleRuns.delete(t);
				continue;
			}
			let s = j;
			while (s > 0 && isOn(s - 1)) s--;
			let e = j + 1;
			while (e < t.keys.length && isOn(e)) e++;
			const start = t.keys[s].tick, end = e < t.keys.length ? t.keys[e].tick : Infinity;
			const time = (tick - start) * this.interval;
			if (tick > end + LINGER / this.interval) {
				this.particleRuns.delete(t);
				continue;
			}
			const k = t.keys[i];
			const name = ents.particleNames[Number(k.extra?.m_iEffectIndex ?? -1)];
			const def = name ? lib.get(name) : undefined;
			if (!def) continue;
			let run = this.particleRuns.get(t);
			if (!run || run.start !== start || run.inst.time > time + 1e-4 || time - run.inst.time > 3) {
				const cp = this.worldMatrix(t, k, tick, 0) ?? new THREE.Matrix4().setPosition(k.origin[0], k.origin[1], k.origin[2]);
				const inst = new ParticleInstance(def, lib, cp, t.index * 7919 + start);
				if (time > 6) inst.skipTo(time - 6);
				run = {start, inst};
				this.particleRuns.set(t, run);
			}
			const stopAt = (end - start) * this.interval;
			if (time >= stopAt && run.inst.emitting) {
				run.inst.advance(stopAt);
				run.inst.stopEmitting();
			}
			run.inst.advance(time);
			this.particlesShown.push(...run.inst.all);
		}
	}

	// the recording player's view model, posed by its networked animation
	private updateViewModel(tick: number) {
		if (this.vmShown) this.vmShown.visible = false;
		this.vmShown = null;
		const ents = this.entities;
		if (!ents || this.mode !== 'eyes') return;
		const t = ents.tracks.find(c => c.className === 'CPredictedViewModel' && keyAt(c, tick)?.visible && c.model.endsWith('.mdl'));
		const k = t && keyAt(t, tick);
		if (!t || !k) return;
		let g = this.vmObjects.get(t);
		if (!g) {
			const group = new THREE.Group();
			g = group;
			this.vmObjects.set(t, group);
			this.vmScene.add(group);
			this.model(t.model, k.skin ?? 0).then(asset => {
				if (!asset?.skeleton) return;
				const anim = new AnimatedModel(asset.skeleton, asset.parts.map(p => ({geometry: skinnedGeometry(p.group, p.raw), material: p.material})));
				group.add(anim.group);
				group.userData.anim = anim;
				group.userData.skeleton = asset.skeleton;
				this.onLoaded();
			});
		}
		const anim = g.userData.anim as AnimatedModel | undefined;
		if (anim && k.anim) {
			const [seq, cycle] = this.animAt(t, tick, g.userData.skeleton);
			anim.setPose(seq, cycle);
		}
		// at the eye, turned with the view
		g.position.copy(this.camera.position);
		g.rotation.copy(toEuler([this.eyeAngles[0], this.eyeAngles[1], 0]));
		g.visible = true;
		this.vmShown = g;
	}

	// a player's weapon_bone in the world (where a held gun is bone-merged)
	private handMatrix(index: number, tick: number): THREE.Matrix4 | null {
		const pt = (this.tracksByIndex.get(index) ?? []).find(c => c.className === 'CPortal_Player' && keyAt(c, tick));
		const po = pt && this.objects.get(pt);
		const sk = po?.userData.skeleton as Skeleton | undefined;
		const anim = po?.userData.anim as AnimatedModel | undefined;
		if (!po || !sk || !anim) return null;
		const bone = sk.bones.findIndex(b => b.name.toLowerCase() === 'weapon_bone');
		if (bone < 0) return null;
		po.updateMatrixWorld();
		return po.matrixWorld.clone().multiply(boneMatrices(sk, anim.pose)[bone]);
	}

	// A player's animation, picked from their movement as the game's
	// animation state does: idle, run or crouch-walk (blended by direction
	// relative to where they face), or floating in the air
	private playerAnim(t: EntityTrack, tick: number, sk: Skeleton): [number, number, Record<string, number>] {
		const seqs = (sk as Skeleton & {labels?: Map<string, number>}).labels ??= new Map(sk.sequences.map((s, i) => [s.label, i]));
		const k = keyAt(t, tick)!;
		const before = keyAt(t, tick - 6) ?? k;
		const dt = Math.max(1, k.tick - before.tick) * this.interval;
		const v = [0, 1, 2].map(i => (k.origin[i] - before.origin[i]) / Math.max(dt, 6 * this.interval));
		const speed = Math.hypot(v[0], v[1]);
		const crouched = k.eyeZ !== undefined && k.eyeZ < 50;
		const air = Math.abs(v[2]) > 40;
		const pick = (...labels: string[]) => {
			for (const l of labels) {
				const i = seqs.get(l);
				if (i !== undefined) return i;
			}
			return 0;
		};
		let seq: number, rate = 1;
		if (air) seq = pick('portalgun_jumpfloat', 'jump_float', 'jumpfloat');
		else if (speed > 15) {
			seq = crouched ? pick('portalgun_crouchwalk', 'crouchwalk') : pick('portalgun_run', 'run');
			rate = Math.min(2, Math.max(0.4, speed / (crouched ? 63 : 175)));
		} else seq = crouched ? pick('portalgun_crouch_idle', 'crouch_idle') : pick('portalgun_standing_idle', 'standing_idle', 'idle');
		const yaw = k.angles[1] * Math.PI / 180;
		const params: Record<string, number> = {move_x: 0, move_y: 0};
		if (speed > 15) {
			params.move_x = (v[0] * Math.cos(yaw) + v[1] * Math.sin(yaw)) / speed;
			params.move_y = (-v[0] * Math.sin(yaw) + v[1] * Math.cos(yaw)) / speed;
		}
		const time = tick * this.interval;
		const c = time * sequenceRate(sk, seq) * rate;
		return [seq, c - Math.floor(c), params];
	}

	// the entity at a network index at a tick (indices get reused)
	private entityAt(index: number, tick: number, className: string): EntityKey | undefined {
		for (const t of this.tracksByIndex.get(index) ?? []) {
			if (t.className !== className) continue;
			const k = keyAt(t, tick);
			if (k) return k;
		}
		return undefined;
	}

	// the player's fog and tonemap controllers
	private applyControllers(pk: EntityKey | undefined, tick: number) {
		const e = pk?.extra;
		let fog = this.fogBase;
		const fk = e ? this.entityAt(Number(e['m_PlayerFog.m_hCtrl'] ?? -1) & 2047, tick, 'CFogController')?.extra : undefined;
		if (fk) {
			const c = Number(fk['m_fog.colorPrimary'] ?? 0);
			fog = Number(fk['m_fog.enable']) ? {
				color: [c & 255, (c >>> 8) & 255, (c >>> 16) & 255],
				start: Number(fk['m_fog.start'] ?? 0),
				end: Number(fk['m_fog.end'] ?? 30000),
				maxDensity: Number(fk['m_fog.maxdensity'] ?? 1),
			} : null;
		}
		this.fog = fog;
		const tk = e ? this.entityAt(Number(e['localdata.m_hTonemapController'] ?? -1) & 2047, tick, 'CEnvTonemapController')?.extra : undefined;
		if (tk) {
			const lo = Number(tk.m_bUseCustomAutoExposureMin) ? Number(tk.m_flCustomAutoExposureMin) : 0.5;
			const hi = Number(tk.m_bUseCustomAutoExposureMax) ? Number(tk.m_flCustomAutoExposureMax) : 2;
			this.exposureRange = [lo, Math.max(lo, hi)];
		}
	}

	// Auto exposure, as the engine's: every few frames the view is drawn
	// small without exposure, and the scale is set so the 60th percentile of
	// luminance lands at 0.6 (and the brightest 5% don't blow out), within
	// the tonemap controller's range, approached gradually.
	private meterExposure(r: THREE.WebGLRenderer) {
		const now = performance.now();
		const dt = Math.min(0.5, (now - this.lastRender) / 1000);
		this.lastRender = now;
		if (this.meterCount++ % 8 === 0) {
			const w = 64, h = 36;
			this.meter ??= new THREE.WebGLRenderTarget(w, h, {type: THREE.HalfFloatType});
			const fog = this.scene.fog;
			this.scene.fog = null;
			r.setRenderTarget(this.meter);
			r.render(this.scene, this.camera);
			r.setRenderTarget(null);
			this.scene.fog = fog;
			const px = new Uint16Array(w * h * 4);
			r.readRenderTargetPixels(this.meter, 0, 0, w, h, px);
			const lum: number[] = [];
			for (let i = 0; i < px.length; i += 4) {
				const f = THREE.DataUtils.fromHalfFloat;
				lum.push(0.2126 * f(px[i]) + 0.7152 * f(px[i + 1]) + 0.0722 * f(px[i + 2]));
			}
			lum.sort((a, b) => a - b);
			const at = (p: number) => Math.max(1e-4, lum[Math.floor(lum.length * p)]);
			const target = Math.min(0.6 / at(0.6), 1 / at(0.95));
			this.meterTarget = Math.min(this.exposureRange[1], Math.max(this.exposureRange[0], target));
		}
		const t = Math.min(this.exposureRange[1], Math.max(this.exposureRange[0], this.meterTarget ?? this.exposure));
		this.exposure += (t - this.exposure) * Math.min(1, dt * 1.5);
		r.toneMappingExposure = this.exposure;
	}
	private meterTarget: number | null = null;

	// the fog colour as drawn: three mixes fog in after exposure and output
	// encoding, so it's given already exposed and encoded
	private updateFog() {
		const fog = this.fog, sceneFog = this.scene.fog as THREE.Fog | null;
		if (!fog || !sceneFog) {
			if (sceneFog) sceneFog.far = sceneFog.near = 1e9;
			fogUniforms.fogMaxDensity.value = 0;
			return;
		}
		const enc = (v: number) => {
			const lin = Math.min(1, Math.pow(v / 255, 2.2) * this.exposure);
			return lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
		};
		sceneFog.color.setRGB(enc(fog.color[0]), enc(fog.color[1]), enc(fog.color[2]), THREE.LinearSRGBColorSpace);
		sceneFog.near = fog.start;
		sceneFog.far = fog.end;
		fogUniforms.fogMaxDensity.value = fog.maxDensity;
		// the clear colour is encoded but not exposed by three
		if (this.scene.background instanceof THREE.Color) {
			const lin = (v: number) => Math.min(1, Math.pow(v / 255, 2.2) * this.exposure * fog.maxDensity);
			this.scene.background.setRGB(lin(fog.color[0]), lin(fog.color[1]), lin(fog.color[2]), THREE.LinearSRGBColorSpace);
		}
	}

	// switchable lights: the styles' values at this tick, from the
	// recording's "lightstyles" table; the lightmap is re-summed where they
	// changed
	private updateLightStyles(tick: number) {
		const lm = this.bsp?.lightmap, tex = this.lightTex, changes = this.entities?.lightStyles;
		if (!lm || !tex || !changes?.length || !lm.styles.length) return;
		const patterns = new Map<number, string>();
		for (const c of changes) {
			if (c.tick > tick) break;
			patterns.set(c.style, c.pattern);
		}
		const time = tick * this.interval;
		const changed = new Set<number>();
		const value = (style: number) => {
			const p = patterns.get(style);
			return p === undefined ? (style ? this.styleValues.get(style) ?? 1 : 1) : styleValue(p, time);
		};
		for (const st of lm.styles) {
			const v = value(st);
			if (this.styleValues.get(st) !== v) changed.add(st);
		}
		if (!changed.size) return;
		for (const st of changed) this.styleValues.set(st, value(st));
		const half = tex.image.data as unknown as Uint16Array;
		for (const b of composeLightmap(lm, st => (st ? this.styleValues.get(st) ?? 1 : value(0)), changed)) {
			for (let y = 0; y < b.h; y++) {
				const start = ((b.y + y) * lm.width + b.x) * 4;
				for (let i = start; i < start + b.w * 4; i++) half[i] = THREE.DataUtils.toHalfFloat(lm.data[i]);
			}
		}
		tex.needsUpdate = true;
	}

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
			gooUniforms.gooTime.value = time;
			this.paint?.seek(tick);
			this.updateLightStyles(tick);
			for (const t of ents.tracks) {
				const k = keyAt(t, tick);
				const show = !!k && this.shows(t, k);
				const o = show ? this.objectFor(t, k?.skin ?? 0) : this.objects.get(t);
				if (!o) continue;
				o.visible = show;
				if (show && k && WORLD_SPACE.has(t.className)) {
					this.placeEffect(t, k, o, time);
					continue;
				}
				// the recording player (and their gun) are the camera in Eyes view
				if (show && this.mode === 'eyes' && (t === ents.player || (t.className === 'CWeaponPortalgun' && ents.player && k?.parent === ents.player.index))) o.visible = false;
				if (show && k) {
					const anim = o.userData.anim as AnimatedModel | undefined;
					if (anim && k.anim) {
						const [seq, cycle] = this.animAt(t, tick, o.userData.skeleton);
						anim.setPose(seq, cycle);
					} else if (anim && t.className === 'CPortal_Player') {
						const [seq, cycle, params] = this.playerAnim(t, tick, o.userData.skeleton);
						anim.setPose(seq, cycle, params);
					}
					o.position.set(k.origin[0], k.origin[1], k.origin[2]);
					// players turn with their view but don't tilt
					o.rotation.copy(toEuler(t.className === 'CPortal_Player' ? [0, k.angles[1], 0] : k.angles));
					if (o.userData.portalSurface) {
						const e = k.extra ?? {};
						const surface = o.userData.portalSurface as THREE.Mesh;
						const halfW = Number(e.m_fNetworkHalfWidth) || PORTAL_HALF_W, halfH = Number(e.m_fNetworkHalfHeight) || PORTAL_HALF_H;
						// the quad reaches 7.5% past the opening, for the flames
						surface.scale.set(halfW * 1.075, halfH * 1.075, 1);
						const u = (surface.material as THREE.ShaderMaterial).uniforms;
						u.time.value = time;
						u.exposure.value = this.exposure;
						// opens over half a second from where it was placed
						u.open.value = (tick - this.portalPlacedAt(t, tick)) * this.interval * 2;
						this.portals.set(t.index, {obj: o, link: Number(e.m_hLinkedPortal ?? -1) & 2047, halfW, halfH});
					}
				}
			}
		}

		if (ents) this.placeAttached(tick);
		this.updateViewModel(tick);
		this.updateParticles(tick);

		// player: the decoded entity where there is one, else the recorded view
		const pk = ents?.player ? keyAt(ents.player, tick) : undefined;
		const feet = pk ? new THREE.Vector3(...pk.origin) : view ? new THREE.Vector3(...view.origin) : null;
		this.applyControllers(pk, tick);
		// screen-door dissolve of whatever is between the orbit camera and the player
		ditherUniforms.ditherOn.value = feet && this.mode === 'orbit' ? 1 : 0;
		if (feet) ditherUniforms.ditherTarget.value.copy(feet).add(new THREE.Vector3(0, 0, 36));
		if (feet) {
			this.player.position.copy(feet);
			this.player.visible = this.mode !== 'eyes' && !ents?.player;
			const eye = feet.clone();
			eye.z += pk?.eyeZ ?? DEFAULT_EYE;
			if (this.mode === 'eyes') {
				const ang = view?.angles ?? pk?.angles ?? [0, 0, 0];
				this.eyeAngles = ang;
				this.camera.position.copy(eye);
				const pitch = ang[0] * Math.PI / 180, yaw = ang[1] * Math.PI / 180;
				const fwd = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch));
				this.camera.lookAt(eye.clone().add(fwd));
			} else if (this.mode === 'free') {
				// the free camera goes where the user takes it
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
		if (this.bsp) {
			this.meterExposure(r);
			this.updateFog();
		}
		// orbit: the camera stays on the player's side of walls, as a game's
		// third-person camera does (the user's distance is kept for later)
		const saved = this.mode === 'orbit' ? this.pullInCamera() : null;
		this.particleRenderer?.draw(this.particlesShown, this.camera);
		this.renderScene(r);
		if (this.mode === 'eyes' && this.vmShown) {
			this.vmCam.position.copy(this.camera.position);
			this.vmCam.quaternion.copy(this.camera.quaternion);
			this.vmCam.aspect = this.camera.aspect;
			this.vmCam.updateProjectionMatrix();
			const auto = r.autoClear;
			r.autoClear = false;
			r.clearDepth();
			const dither = ditherUniforms.ditherOn.value;
			ditherUniforms.ditherOn.value = 0;
			r.render(this.vmScene, this.vmCam);
			ditherUniforms.ditherOn.value = dither;
			r.autoClear = auto;
		}
		if (saved) {
			this.camera.position.copy(saved);
			this.camera.updateMatrixWorld();
		}
	}

	// Free camera: drag to look, WASD to fly along the view, Q/E down/up,
	// Shift faster, Ctrl slower (as noclip)
	private bindFreeCamera(canvas: HTMLCanvasElement) {
		const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']);
		canvas.addEventListener('pointerdown', e => {
			if (this.mode !== 'free' || e.button !== 0) return;
			this.freeDrag = {x: e.clientX, y: e.clientY};
			canvas.setPointerCapture(e.pointerId);
		});
		canvas.addEventListener('pointermove', e => {
			if (!this.freeDrag) return;
			this.freeAngles[1] -= (e.clientX - this.freeDrag.x) * 0.22;
			this.freeAngles[0] = Math.max(-89, Math.min(89, this.freeAngles[0] + (e.clientY - this.freeDrag.y) * 0.22));
			this.freeDrag = {x: e.clientX, y: e.clientY};
			this.applyFreeView();
			this.render();
		});
		const end = () => (this.freeDrag = null);
		canvas.addEventListener('pointerup', end);
		canvas.addEventListener('pointercancel', end);
		window.addEventListener('keydown', e => {
			if (this.mode !== 'free' || !MOVE_KEYS.has(e.code) || e.metaKey || e.altKey) return;
			if (e.target instanceof Element && e.target.matches('input, select, textarea')) return;
			if (this.container.hidden) return;
			e.preventDefault();
			this.freeKeys.add(e.code);
			if (!this.freeFrame) {
				this.freeLast = document.timeline.currentTime as number ?? performance.now();
				this.freeFrame = requestAnimationFrame(this.freeTick);
			}
		});
		window.addEventListener('keyup', e => this.freeKeys.delete(e.code));
		window.addEventListener('blur', () => this.freeKeys.clear());
	}

	private applyFreeView() {
		const p = this.freeAngles[0] * Math.PI / 180, y = this.freeAngles[1] * Math.PI / 180;
		const c = this.camera.position;
		this.camera.lookAt(c.x + Math.cos(p) * Math.cos(y), c.y + Math.cos(p) * Math.sin(y), c.z - Math.sin(p));
	}

	private freeTick = (now: number) => {
		this.freeFrame = 0;
		const k = this.freeKeys;
		const moving = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].some(c => k.has(c));
		if (this.mode !== 'free' || !moving) return;
		const dt = Math.max(0, Math.min(0.1, (now - this.freeLast) / 1000));
		this.freeLast = now;
		const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 1600 : k.has('ControlLeft') || k.has('ControlRight') ? 120 : 500) * dt;
		const p = this.freeAngles[0] * Math.PI / 180, y = this.freeAngles[1] * Math.PI / 180;
		const fwd = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p));
		const right = new THREE.Vector3(Math.sin(y), -Math.cos(y), 0);
		const move = new THREE.Vector3();
		if (k.has('KeyW')) move.add(fwd);
		if (k.has('KeyS')) move.sub(fwd);
		if (k.has('KeyD')) move.add(right);
		if (k.has('KeyA')) move.sub(right);
		if (k.has('KeyE')) move.z += 1;
		if (k.has('KeyQ')) move.z -= 1;
		if (move.lengthSq()) this.camera.position.addScaledVector(move.normalize(), speed);
		this.applyFreeView();
		this.render();
		this.freeFrame = requestAnimationFrame(this.freeTick);
	};

	private pullInCamera(): THREE.Vector3 | null {
		if (!this.collision || !this.controls) return null;
		const target = this.controls.target;
		const offset = this.camera.position.clone().sub(target);
		const len = offset.length();
		if (len < 1) return null;
		const ray = new THREE.Ray(target.clone(), offset.clone().divideScalar(len));
		const hit = this.collision.raycastFirst(ray, THREE.DoubleSide);
		if (!hit || hit.distance > len) return null;
		const saved = this.camera.position.clone();
		this.camera.position.copy(target).addScaledVector(ray.direction, Math.max(4, hit.distance - 10));
		this.camera.updateMatrixWorld();
		return saved;
	}

	private renderScene(r: THREE.WebGLRenderer) {
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

	// debugging: render at a fixed size, optionally from a given eye and
	// pitch/yaw, and return it as a PNG data URL
	snapshot(w: number, h: number, eye?: number[], ang?: number[]): string {
		const r = this.ensureRenderer();
		const size = r.getSize(new THREE.Vector2());
		const aspect = this.camera.aspect;
		const saved = [this.camera.position.clone(), this.camera.quaternion.clone()] as const;
		if (eye && ang) {
			this.camera.position.set(eye[0], eye[1], eye[2]);
			const p = ang[0] * Math.PI / 180, y = ang[1] * Math.PI / 180;
			this.camera.lookAt(eye[0] + Math.cos(p) * Math.cos(y), eye[1] + Math.cos(p) * Math.sin(y), eye[2] - Math.sin(p));
		}
		r.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.render();
		const url = r.domElement.toDataURL('image/png');
		r.setSize(size.x, size.y, false);
		this.camera.aspect = aspect;
		this.camera.updateProjectionMatrix();
		this.camera.position.copy(saved[0]);
		this.camera.quaternion.copy(saved[1]);
		this.render();
		return url;
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

// one triangle soup of the world's solid faces (not glass or liquids) with a
// BVH, for ray tests
function worldCollision(m: ModelMesh): MeshBVH | null {
	const solid = m.groups.filter(g => g.surface !== 'glass' && g.surface !== 'liquid');
	const count = solid.reduce((n, g) => n + g.positions.length, 0);
	if (!count) return null;
	const pos = new Float32Array(count);
	let o = 0;
	for (const g of solid) {
		pos.set(g.positions, o);
		o += g.positions.length;
	}
	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	return new MeshBVH(geom);
}
