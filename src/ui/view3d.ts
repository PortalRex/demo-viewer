// 3D replay: the map's geometry from the viewer's own game files, with the
// recorded entities (portals, brush entities, props) and the player's view.
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {MeshBVH, acceleratedRaycast} from 'three-mesh-bvh';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {composeLightmap, styleValue} from '../game/bsp.ts';
import type {BspMap, MeshData, MaterialGroup, ModelMesh} from '../game/bsp.ts';
import type {GameFiles} from '../game/files.ts';
import type {Materials, MaterialInfo} from '../game/materials.ts';
import {readVtfCube, decodeVtf, VtfFormat} from '../game/vtf.ts';
import {loadModel} from '../game/mdl.ts';
import type {StudioModel, ModelGroup} from '../game/mdl.ts';
import {loadSkeleton, referencePose, samplePose, sequenceRate} from '../game/anim.ts';
import type {Skeleton} from '../game/anim.ts';
import {AnimatedModel, attachmentMatrix, bakePose, boneMatrices, skinMatrices, skinnedGeometry} from './skinning.ts';
import {Laser, Bridge, Funnel, fizzlerMaterial, portalMaterial, vec3, EffectAssets} from './effects.ts';
import {PaintLayer} from './paint.ts';
import {ParticleLibrary, ParticleInstance, ParticleRenderer, isEndless} from './particles.ts';
import type {ControlPoints} from './particles.ts';
import {AMBIENT_SCALE, exposureUniforms, paintUniforms, ditherUniforms, fogUniforms, gooUniforms, hookWorldMaterial, hookModelMaterial, useModelLighting, ownLitMaterial, bumpLightUniforms, setWorldEnv, setWorldDetail} from './shaderhooks.ts';
import {TextureCache, compressedSupport} from './textures.ts';
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
// held objects sit about 70 units in front of the eye; further than this
// they're held through a portal (see placeHeld)
const HOLD_MAX = 120;
const HOLD_OFFSET = new THREE.Vector3(70, 0, -15);
// an angle in [-180, 180)
const normPitch = (p: number) => ((p + 180) % 360 + 360) % 360 - 180;

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
// The stored linear light times 1.5 (matched against frames the game
// renders, in a map whose tonemap range pins the exposure); the frame is then
// scaled by the auto exposure and clamped, with no filmic curve.
const LIGHTMAP_EXPOSURE = 1.5;

// a static prop's stored vertex light (a byte) as linear light, in the
// lightmaps' units
const vertexLight = (b: number) => Math.pow(b / 255 * 2, 2.2);

// The engine's tonemap target from a histogram of the frame as drawn at
// `exposure` (RGBA half floats, unexposed): only the middle 90% x 85% of
// the view counts; pixels go in 16 buckets of linear luminance (edges
// (k/16)^2.5, with everything over 1 in the top one; the engine's
// mat_show_histogram says linear); the scale aims to put
// the brightest 2% at 0.6 (holding still when 0.6 is already in their
// bucket), or the median at 0.03 if that's brighter. Null with nothing to
// measure.
function histogramTarget(px: Uint16Array, w: number, h: number, exposure: number): number | null {
	const BUCKETS = 16;
	const edges = Array.from({length: BUCKETS + 1}, (_, k) => Math.pow(k / BUCKETS, 2.5));
	const counts = new Array(BUCKETS).fill(0);
	const f = THREE.DataUtils.fromHalfFloat;
	const enc = (v: number) => Math.min(1, Math.max(0, v * exposure));
	let total = 0;
	for (let y = Math.floor(h * 0.075); y < Math.ceil(h * 0.925); y++) {
		for (let x = Math.floor(w * 0.05); x < Math.ceil(w * 0.95); x++) {
			const i = (y * w + x) * 4;
			const lum = 0.2126 * enc(f(px[i])) + 0.7152 * enc(f(px[i + 1])) + 0.0722 * enc(f(px[i + 2]));
			let b = 0;
			while (b < BUCKETS - 1 && lum >= edges[b + 1]) b++;
			counts[b]++;
			total++;
		}
	}
	if (!total) return null;
	// where the brightest `percent` of pixels start (snapping to `snap` when
	// it lies in that bucket)
	const location = (percent: number, snap = -1) => {
		let pixels = 0, range = 0;
		for (let b = BUCKETS - 1; b >= 0; b--) {
			const need = percent - pixels, share = counts[b] / total, width = edges[b + 1] - edges[b];
			if (share >= need) {
				if (snap >= 0 && edges[b] <= snap && snap <= edges[b + 1]) return snap;
				const at = 1 - (range + width * (need / share));
				return Math.max(edges[b], Math.min(edges[b + 1], at));
			}
			pixels += share;
			range += width;
		}
		return -1;
	};
	let at = location(0.02, 0.6);
	if (at < 0) at = 0.6;
	let target = 0.6 / Math.max(1e-4, at);
	const median = location(0.5);
	if (median > 0) target = Math.max(target, 0.03 / median);
	return target * exposure;
}

// three.js materials for the map's materials: textured once the texture
// loads (flat colour until then), lit by the lightmap atlas for the world
class MaterialLibrary {
	readonly materials: Materials;
	readonly textures: TextureCache;
	private lightmap: THREE.Texture | null;
	private world = new Map<string, THREE.Material>();
	private model = new Map<string, THREE.Material>();
	private litModel = new Map<string, THREE.Material>();

	// frees the map's materials and textures (when the map changes)
	dispose() {
		for (const cache of [this.world, this.model, this.litModel]) {
			for (const m of cache.values()) m.dispose();
			cache.clear();
		}
		this.textures.dispose();
	}
	onChange = () => {};

	constructor(files: GameFiles, materials: Materials, lightmap: THREE.Texture | null) {
		this.materials = materials;
		this.textures = new TextureCache(files);
		this.lightmap = lightmap;
	}

	private apply(mat: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial, info: MaterialInfo) {
		if (info.shader === 'refract') {
			this.applyRefract(mat, info);
			return;
		}
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
			mat.userData.textureless = true;
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

	// glass and other Refract surfaces: what's behind them multiplied by
	// their tint (and tint texture), unlit, as the shader draws them
	private applyRefract(mat: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial, info: MaterialInfo) {
		if (info.baseTexture) {
			// with a $basetexture the shader refracts that instead of the
			// screen: the texture times the tint, unlit and unscaled (light covers)
			mat.userData.textureless = true;
			mat.vertexColors = false;
			mat.toneMapped = false;
			mat.lightMap = null;
			mat.defines = {...mat.defines, REFRACT_TINT: '', REFRACT_UNSCALED: ''};
			delete mat.defines.BACKFACE_SHADE;
			mat.color.setRGB(info.refractTint[0], info.refractTint[1], info.refractTint[2], THREE.LinearSRGBColorSpace);
			mat.needsUpdate = true;
			this.textures.get(info.baseTexture).then(tex => {
				if (!tex) return;
				mat.map = tex;
				mat.needsUpdate = true;
				this.onChange();
			});
			return;
		}
		mat.transparent = true;
		mat.depthWrite = false;
		mat.side = THREE.DoubleSide;
		mat.userData.twoSided = true;
		mat.userData.textureless = true;
		mat.vertexColors = false;
		mat.blending = THREE.CustomBlending;
		mat.blendEquation = THREE.AddEquation;
		mat.blendSrc = THREE.ZeroFactor;
		mat.blendDst = THREE.SrcColorFactor;
		mat.toneMapped = false;
		mat.fog = false;
		mat.lightMap = null;
		mat.defines = {...mat.defines, REFRACT_TINT: ''};
		delete mat.defines.BACKFACE_SHADE;
		const k = info.refractTintTexture ? 2 : 1;
		mat.color.setRGB(info.refractTint[0] * k, info.refractTint[1] * k, info.refractTint[2] * k, THREE.LinearSRGBColorSpace);
		mat.needsUpdate = true;
		if (info.refractTintTexture) {
			this.textures.get(info.refractTintTexture).then(tex => {
				if (!tex) return;
				mat.map = tex;
				mat.needsUpdate = true;
				this.onChange();
			});
		}
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

	get showsBackFaces() {
		return this.backFaces;
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
				if (info.bumpMap && bumpLightUniforms.bumpLight0.value) {
					this.textures.get(info.bumpMap, true).then(tex => {
						if (!tex) return;
						mat.userData.bumpNormal = tex;
						mat.defines = {...mat.defines, BUMPLIGHT: ''};
						if (info.ssbump) mat.defines.SSBUMP = '';
						mat.needsUpdate = true;
						this.onChange();
					});
				}
			}
			this.apply(mat, info);
			this.applyBackFaces(mat);
			mat.needsUpdate = true;
			this.onChange();
			if (info.envMap && info.envMap !== 'env_cubemap' && !info.translucent) this.applyEnv(mat, info);
			// detail modes drawn: mod2x, additive, two-pattern mod2x, multiply, ssbump detail
			if (info.detail && !info.unlit && [0, 1, 7, 8, 10].includes(info.detailBlendMode) && info.shader === 'lightmappedgeneric') {
				// (linear: only the fade and over modes are sRGB)
				this.textures.get(info.detail, true).then(tex => {
					if (!tex) return;
					setWorldDetail(mat, tex, info.detailScale, info.detailBlendFactor, info.detailBlendMode);
					this.onChange();
				});
			}
		});
		this.applyBackFaces(mat);
		return mat;
	}

	// a world material's reflection: its cubemap (map patches name the
	// nearest of the map's built ones), mask and tint
	private async applyEnv(mat: THREE.Material, info: MaterialInfo) {
		const [cube, maskMap] = await Promise.all([
			this.cube(info.envMap),
			info.envMask === 'texture' && info.envMaskTexture ? this.textures.get(info.envMaskTexture, true) : Promise.resolve(null),
		]);
		if (!cube) return;
		if (info.envMask === 'bump' && !mat.userData.bumpNormal) {
			// the mask is in the bump map's alpha
			const bump = info.bumpMap ? await this.textures.get(info.bumpMap, true) : null;
			if (!bump) return;
			mat.userData.bumpNormal = bump;
		}
		setWorldEnv(mat, {cube: cube.texture, tint: info.envTint, scale: cube.scale, contrast: info.envContrast, saturation: info.envSaturation, maskMap, lightScale: info.envLightScale}, info.envMask);
		this.onChange();
	}

	private cubes = new Map<string, Promise<{texture: THREE.CubeTexture; scale: number} | null>>();

	// a cubemap: the HDR version where there is one, else the plain one;
	// both drawn as stored (linear)
	private cube(path: string): Promise<{texture: THREE.CubeTexture; scale: number} | null> {
		let p = this.cubes.get(path);
		if (!p) {
			p = (async () => {
				for (const [ext, scale] of [['.hdr.vtf', 1], ['.vtf', 1]] as const) {
					const bytes = await this.materials.files.read(`materials/${path}${ext}`);
					const faces = bytes && readVtfCube(bytes, 128);
					if (!faces) continue;
					const half = faces[0].format === VtfFormat.RGBA16161616F;
					const images = faces.map(f => {
						const t = half
							? new THREE.DataTexture(new Uint16Array(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.width * f.height * 8)), f.width, f.height, THREE.RGBAFormat, THREE.HalfFloatType)
							: new THREE.DataTexture(decodeVtf(f), f.width, f.height, THREE.RGBAFormat, THREE.UnsignedByteType);
						return t;
					});
					const texture = new THREE.CubeTexture(images as unknown as HTMLImageElement[]);
					texture.type = half ? THREE.HalfFloatType : THREE.UnsignedByteType;
					texture.format = THREE.RGBAFormat;
					texture.colorSpace = THREE.NoColorSpace;
					texture.magFilter = THREE.LinearFilter;
					texture.minFilter = THREE.LinearFilter;
					texture.generateMipmaps = false;
					texture.needsUpdate = true;
					return {texture, scale};
				}
				return null;
			})().catch(() => null);
			this.cubes.set(path, p);
		}
		return p;
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
			// lit per object from the map's ambient cubes and lights (see View3D.lightModels)
			mat.userData.ambientLit = true;
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
	private bumpTex: THREE.DataTexture[] = [];  // the bump directions' lightmaps
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
	private particleRuns = new Map<string, {start: number; inst: ParticleInstance}>();
	private particlesShown: ParticleInstance[] = [];
	private vmParticlesShown: ParticleInstance[] = [];  // first-person effects, drawn with the view model
	private vmParticleRenderer: ParticleRenderer | null = null;
	// first-person view model (the portal gun), drawn over the world in
	// Eyes view with its own field of view, as the game does
	private vmScene = new THREE.Scene();
	private vmCam = new THREE.PerspectiveCamera(VIEWMODEL_FOV, 1, 1, 2000);
	private vmObjects = new Map<EntityTrack, THREE.Group>();
	private vmShown: THREE.Group | null = null;
	private eyeAngles: number[] = [0, 0, 0];
	// the player the camera follows (co-op: either one); null = the recording player
	private followed: EntityTrack | null = null;
	// free camera: held movement keys, view angles (degrees), drag state
	private freeKeys = new Set<string>();
	private freeAngles = [0, 0];  // pitch, yaw
	private freeDrag: {x: number; y: number} | null = null;
	private freeFrame = 0;
	private freeLast = 0;
	private mapToken = 0;
	onLoaded = () => {};

	// something finished loading: redraw, and once loading goes quiet,
	// compile the shaders of everything in the scene, hidden entities too,
	// so nothing stalls the first time it shows
	private loaded() {
		this.compileNeeded = true;
		this.onLoaded();
		clearTimeout(this.precompileTimer);
		this.precompileTimer = setTimeout(() => {
			if (this.freezeStatics()) {
				this.mergeProps();
				this.mergeFrozenKids();
			}
			this.precompile();
		}, 400);
	}
	private precompileTimer: ReturnType<typeof setTimeout> | undefined;

	private precompile() {
		const r = this.renderer;
		if (!r) return;
		const hidden: THREE.Object3D[] = [];
		for (const g of [this.entityGroup, this.vmScene]) {
			g.traverse(o => {
				if (!o.visible) {
					hidden.push(o);
					o.visible = true;
				}
			});
		}
		// (for the HDR frame, which is what scenes are drawn into)
		const target = r.getRenderTarget();
		if (this.frame) r.setRenderTarget(this.frame);
		try {
			r.compile(this.scene, this.camera);
			r.compile(this.vmScene, this.vmCam);
			// and the world as the other camera modes draw it (with or
			// without back faces), so switching is instant
			const lib = this.library;
			if (lib) {
				const on = lib.showsBackFaces;
				lib.setBackFaces(!on);
				r.compile(this.scene, this.camera);
				lib.setBackFaces(on);
			}
		} finally {
			r.setRenderTarget(target);
			for (const o of hidden) o.visible = false;
		}
	}

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
		// (antialiased in the frame target instead: see render)
		this.renderer = new THREE.WebGLRenderer({antialias: false, stencil: false, depth: false});
		// HDR lighting needs its highlights rolled off, as the game's tone
		// mapping does
		this.renderer.toneMapping = THREE.LinearToneMapping;
		this.renderer.toneMappingExposure = 3;
		this.renderer.setPixelRatio(window.devicePixelRatio || 1);
		compressedSupport.dxt = this.renderer.extensions.has('WEBGL_compressed_texture_s3tc');
		compressedSupport.srgb = this.renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb');
		this.container.appendChild(this.renderer.domElement);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = false;
		this.controls.enabled = this.mode === 'orbit';
		this.controls.addEventListener('change', () => this.render());
		this.bindFreeCamera(this.renderer.domElement);
		return this.renderer;
	}

	setMode(mode: CameraMode) {
		this.compileNeeded = true;  // (the back faces change the world's shaders)
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
	private model(name: string, skin = 0, body = 0): Promise<ModelAsset | null> {
		const key = `${name.toLowerCase()}#${skin}#${body}`;
		let p = this.models.get(key);
		if (!p) {
			const files = this.files, library = this.library;
			const color: [number, number, number] = /cube|box/.test(key) ? [0.66, 0.73, 0.8] : [0.52, 0.52, 0.5];
			p = files && library
				? loadModel(files, name, color, skin, body).then(async (m: StudioModel | null) => {
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
		this.clearEntities();
		// the last map's GPU resources: its geometry (the world's and the
		// props', each their own), materials, textures, light maps, portal views
		for (const g of [this.mapGroup, this.propGroup, this.sky]) {
			g.traverse(o => {
				const mesh = o as THREE.Mesh;
				if (mesh.isMesh) mesh.geometry.dispose();
			});
			g.clear();
		}
		this.models.forEach(p => p.then(a => a?.parts.forEach(part => {
			part.raw.dispose();
			if (part.baked !== part.raw) part.baked.dispose();
		})));
		this.models.clear();
		this.readyModels.clear();
		this.windowed = [];
		this.library?.dispose();
		this.lightTex?.dispose();
		for (const t of this.bumpTex) t.dispose();
		for (const rt of this.portalTargets.values()) rt.dispose();
		this.portalTargets.clear();
		this.particleRenderer?.dispose();
		this.vmParticleRenderer?.dispose();
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
		this.bumpTex = bsp.lightmap ? bsp.lightmap.bump.map(d => {
			const t = new THREE.DataTexture(new Uint16Array(d.length), bsp.lightmap!.width, bsp.lightmap!.height, THREE.RGBAFormat, THREE.HalfFloatType);
			const half = t.image.data as unknown as Uint16Array;
			for (let i = 0; i < d.length; i++) half[i] = THREE.DataUtils.toHalfFloat(d[i]);
			t.magFilter = t.minFilter = THREE.LinearFilter;
			t.flipY = false;
			t.needsUpdate = true;
			return t;
		}) : [];
		bumpLightUniforms.bumpLight0.value = this.bumpTex[0] ?? null;
		bumpLightUniforms.bumpLight1.value = this.bumpTex[1] ?? null;
		bumpLightUniforms.bumpLight2.value = this.bumpTex[2] ?? null;
		this.styleValues.clear();
		this.tracksByIndex.clear();
		this.library = new MaterialLibrary(files, materials, lightTex);
		this.library.setBackFaces(this.mode !== 'eyes');
		this.library.onChange = () => this.loaded();
		this.effects = new EffectAssets(materials, this.library.textures);
		if (this.particleRenderer) {
			this.particleRenderer.clear();
			this.scene.remove(this.particleRenderer.group);
		}
		this.particleLib = new ParticleLibrary(files, bsp.name);
		this.particleRenderer = new ParticleRenderer(files, materials, this.library.textures);
		this.scene.add(this.particleRenderer.group);
		if (this.vmParticleRenderer) {
			this.vmParticleRenderer.clear();
			this.vmScene.remove(this.vmParticleRenderer.group);
		}
		this.vmParticleRenderer = new ParticleRenderer(files, materials, this.library.textures);
		this.vmScene.add(this.vmParticleRenderer.group);
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
		const placing: Promise<unknown>[] = [];
		for (const prop of bsp.staticProps) {
			placing.push(Promise.all([
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
				this.loaded();
			}));
		}
		// once all are in: drawn merged
		Promise.allSettled(placing).then(() => {
			if (token !== this.mapToken) return;
			this.mergeProps();
			this.loaded();
		});
	}

	// Dynamic props that, all recording long, are there from the start and
	// never move, animate, change skin or hide are drawn as static props:
	// posed once, lit once (the ambient cube and lights baked into vertex
	// colours, as the model shader would light them), merged with the rest
	private frozen = new Set<EntityTrack>();
	private windowed: THREE.Object3D[] = [];  // frozen props shown over some ticks only
	private readyModels = new Map<string, ModelAsset | null>();
	private frozenCandidates: EntityTrack[] | null = null;

	private freezeStatics(): boolean {
		const ents = this.entities, amb = this.bsp?.ambient, library = this.library;
		if (!ents || !amb || !library) return false;
		if (!this.frozenCandidates) {
			const first = Math.min(...ents.tracks.filter(t => t.keys.length).map(t => t.keys[0].tick));
			const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
			// placed in the map and shown from the start (sent once in view),
			// rather than spawned, or enabled by the map's logic later: no
			// name for inputs to reach it, not StartDisabled
			const placed = new Set((this.bsp?.entities ?? []).filter(e => /^prop_dynamic/.test(e.classname ?? '') && e.model && e.origin && !e.targetname && e.startdisabled !== '1')
				.map(e => `${(e.model ?? '').toLowerCase().replace(/\\/g, '/')}@${(e.origin ?? '').split(/\s+/).map(v => Math.round(Number(v))).join(',')}`));
			const inMap = (t: EntityTrack) => placed.has(`${t.model.toLowerCase()}@${t.keys[0].origin.map(v => Math.round(v)).join(',')}`);
			this.frozenCandidates = ents.tracks.filter(t => {
				if (t.className !== 'CDynamicProp' || !t.model.endsWith('.mdl') || !t.keys.length) return false;
				// shown from the start (placed in the map), or from when it
				// appears; until it's removed, for good
				const gone = t.keys.findIndex(k => k.removed);
				if (gone === 0 || (gone > 0 && t.keys.slice(gone).some(k => !k.removed))) return false;
				const live = gone > 0 ? t.keys.slice(0, gone) : t.keys;
				t.userData ??= {};
				t.userData.frozenWindow = [t.keys[0].tick <= first + 2 || inMap(t) ? -Infinity : t.keys[0].tick, gone > 0 ? t.keys[gone].tick : Infinity];
				const k0 = t.keys[0];
				// (on a parent: fixed to it, moving with it)
				return live.every(k => !k.removed && !k.nodraw && (k.visible || k.dormant) && k.parent === k0.parent && k.attachment === undefined
					&& same(k.origin, k0.origin) && same(k.angles, k0.angles) && (k.skin ?? 0) === (k0.skin ?? 0)
					&& Number(k.extra?.m_nBody ?? 0) === Number(k0.extra?.m_nBody ?? 0)
					&& (!k.anim || (k0.anim && k.anim.sequence === k0.anim.sequence && k.anim.cycle === k0.anim.cycle && (!k.anim.clientSide || !k.anim.rate))));
			});
		}
		let added = false;
		for (const t of this.frozenCandidates) {
			if (this.frozen.has(t)) continue;
			const k = t.keys[0];
			// its model (loaded now if it hasn't been; this runs again once
			// loading goes quiet)
			const key = `${t.model.toLowerCase()}#${k.skin ?? 0}#${Number(k.extra?.m_nBody ?? 0)}`;
			const pending = this.models.get(key);
			if (!pending) {
				this.model(t.model, k.skin ?? 0, Number(k.extra?.m_nBody ?? 0)).then(() => this.loaded());
				continue;
			}
			const asset = this.readyModels.get(key);
			if (asset === undefined) {
				pending.then(a => {
					this.readyModels.set(key, a);
					this.loaded();
				});
				continue;
			}
			if (!asset) {
				this.frozen.add(t);  // (no model: nothing to draw either way)
				continue;
			}
			if (k.parent !== undefined) {
				if (this.freezeOnParent(t, k, asset)) added = true;
				continue;
			}
			const o = this.objects.get(t);
			const world = new THREE.Matrix4().compose(new THREE.Vector3(...k.origin), new THREE.Quaternion().setFromEuler(toEuler(k.angles)), new THREE.Vector3(1, 1, 1));
			// the pose: its sequence at its cycle, or sequence 0 as static props
			const sk = asset.skeleton;
			let mats: THREE.Matrix4[] | null = null;
			if (sk && sk.sequences.length) {
				const pose = referencePose(sk);
				samplePose(sk, k.anim ? k.anim.sequence : 0, k.anim ? k.anim.cycle : 0, pose);
				mats = skinMatrices(sk, pose);
			}
			// lit at the model's centre, as lightModels does
			const box = new THREE.Box3();
			for (const part of asset.parts) {
				part.raw.computeBoundingBox();
				if (part.raw.boundingBox) box.union(part.raw.boundingBox);
			}
			const centre = box.isEmpty() ? new THREE.Vector3(...k.origin) : box.getCenter(new THREE.Vector3()).applyMatrix4(world);
			const light = amb.at([centre.x, centre.y, centre.z]);
			const normalMat = new THREE.Matrix3().getNormalMatrix(world);
			const p = new THREE.Vector3(), n = new THREE.Vector3(), l = new THREE.Vector3();
			const k2 = AMBIENT_SCALE / LIGHTMAP_EXPOSURE;
			for (const part of asset.parts) {
				const posed = mats ? bakePose(part.group, mats) : null;
				const positions = posed?.positions ?? part.group.positions, normals = posed?.normals ?? part.group.normals;
				const count = positions.length / 3;
				const outPos = new Float32Array(count * 3), outNrm = new Float32Array(count * 3), colors = new Float32Array(count * 3);
				for (let i = 0; i < count; i++) {
					p.fromArray(positions, i * 3).applyMatrix4(world);
					n.fromArray(normals, i * 3).applyMatrix3(normalMat).normalize();
					p.toArray(outPos, i * 3);
					n.toArray(outNrm, i * 3);
					for (let c = 0; c < 3; c++) {
						const cube = light.cube;
						let v = n.x * n.x * cube[(n.x >= 0 ? 0 : 3) + c] + n.y * n.y * cube[(n.y >= 0 ? 6 : 9) + c] + n.z * n.z * cube[(n.z >= 0 ? 12 : 15) + c];
						for (const li of light.lights.slice(0, 2)) {
							l.set(li.pos[0] - p.x, li.pos[1] - p.y, li.pos[2] - p.z).normalize();
							v += li.color[c] * Math.max(0, n.dot(l));
						}
						colors[i * 3 + c] = v * k2;
					}
				}
				const g = new THREE.BufferGeometry();
				g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
				g.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
				g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
				if (part.group.uv) g.setAttribute('uv', new THREE.BufferAttribute(part.group.uv, 2));
				const mesh = new THREE.Mesh(g, library.forModel(part.group.materialCandidates, true));
				mesh.name = `frozen ${part.name}`;
				mesh.matrixAutoUpdate = false;
				mesh.userData.window = t.userData?.frozenWindow;
				this.propGroup.add(mesh);
			}
			this.frozen.add(t);
			if (o) o.visible = false;
			added = true;
		}
		return added;
	}

	// A prop fixed to a moving parent: its parts in the parent's space, in a
	// group on the parent's object (moving and lit with it), merged per
	// material with its siblings'; false until the parent is there
	private freezeOnParent(t: EntityTrack, k: EntityKey, asset: ModelAsset): boolean {
		const pt = (this.tracksByIndex.get(k.parent!) ?? []).find(c => c.keys.length && c.keys[0].tick <= k.tick + 2 && c.keys[c.keys.length - 1].tick >= k.tick);
		const pk = pt && keyAt(pt, Math.max(k.tick, pt.keys[0].tick));
		const po = pt && pk ? this.objectFor(pt, pk.skin ?? 0, Number(pk.extra?.m_nBody ?? 0)) : null;
		if (!po || !this.library) return false;
		let kids = po.userData.frozenKids as THREE.Group | undefined;
		if (!kids) {
			kids = new THREE.Group();
			kids.name = 'frozen children';
			po.userData.frozenKids = kids;
			po.add(kids);
		}
		const local = new THREE.Matrix4().compose(new THREE.Vector3(...k.origin), new THREE.Quaternion().setFromEuler(toEuler(k.angles)), new THREE.Vector3(1, 1, 1));
		const sk = asset.skeleton;
		let mats: THREE.Matrix4[] | null = null;
		if (sk && sk.sequences.length) {
			const pose = referencePose(sk);
			samplePose(sk, k.anim ? k.anim.sequence : 0, k.anim ? k.anim.cycle : 0, pose);
			mats = skinMatrices(sk, pose);
		}
		const normalMat = new THREE.Matrix3().getNormalMatrix(local);
		for (const part of asset.parts) {
			const posed = mats ? bakePose(part.group, mats) : null;
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posed?.positions ?? part.group.positions), 3));
			g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(posed?.normals ?? part.group.normals), 3));
			g.setAttribute('color', new THREE.BufferAttribute(part.group.colors, 3));
			if (part.group.uv) g.setAttribute('uv', new THREE.BufferAttribute(part.group.uv, 2));
			g.applyMatrix4(local);
			(g.getAttribute('normal') as THREE.BufferAttribute).applyNormalMatrix(normalMat);
			const mesh = new THREE.Mesh(g, part.material);
			mesh.name = `frozen ${part.name}`;
			mesh.userData.window = t.userData?.frozenWindow;
			mesh.userData.frozenKid = true;
			kids.add(mesh);
		}
		this.frozen.add(t);
		const own = this.objects.get(t);
		if (own) {
			own.removeFromParent();
			disposeOwn(own);
			this.objects.delete(t);
		}
		kids.userData.dirty = true;
		return true;
	}

	// a parent's frozen children merged per material and visible ticks (the
	// bounds of what's drawn with the parent's lighting)
	private mergeFrozenKids() {
		this.windowedKids = [];
		for (const o of this.objects.values()) {
			const kids = o.userData.frozenKids as THREE.Group | undefined;
			if (!kids) continue;
			if (kids.userData.dirty) {
				kids.userData.dirty = false;
				const by = new Map<string, THREE.Mesh[]>();
				for (const c of kids.children as THREE.Mesh[]) {
					const key = `${(c.material as THREE.Material).uuid}@${String(c.userData.window ?? '')}@${Object.keys(c.geometry.attributes).sort().join(',')}`;
					by.set(key, [...(by.get(key) ?? []), c]);
				}
				for (const list of by.values()) {
					if (list.length < 2) continue;
					const merged = mergeGeometries(list.map(m => m.geometry));
					if (!merged) continue;
					const mesh = new THREE.Mesh(merged, list[0].material);
					mesh.name = `merged ${list[0].name}`;
					mesh.userData.window = list[0].userData.window;
					mesh.userData.frozenKid = true;
					for (const m of list) {
						m.removeFromParent();
						m.geometry.dispose();
					}
					kids.add(mesh);
				}
			}
			for (const c of kids.children) {
				const w = c.userData.window;
				if (w && (w[0] > -Infinity || w[1] < Infinity)) this.windowedKids.push(c);
			}
		}
	}
	private windowedKids: THREE.Object3D[] = [];

	// Static props with baked vertex light never move or change: their parts
	// that share a material become one mesh (hundreds of draw calls fewer),
	// with a bounds tree for ray tests
	private mergeProps() {
		const byMaterial = new Map<THREE.Material, THREE.Mesh[]>();
		this.propGroup.traverse(c => {
			const mesh = c as THREE.Mesh;
			if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.material.userData?.vertexLit) return;
			const g = mesh.geometry;
			const key = mesh.material;
			// (merged only with parts of the same layout)
			// (and shown over the same ticks)
			const sig = Object.keys(g.attributes).sort().join(',') + (g.index ? '+i' : '') + '@' + String(mesh.userData.window ?? '');
			(mesh.userData as {mergeSig?: string}).mergeSig = sig;
			const list = byMaterial.get(key) ?? [];
			list.push(mesh);
			byMaterial.set(key, list);
		});
		for (const [material, meshes] of byMaterial) {
			const bySig = new Map<string, THREE.Mesh[]>();
			for (const m of meshes) {
				const sig = (m.userData as {mergeSig: string}).mergeSig;
				bySig.set(sig, [...(bySig.get(sig) ?? []), m]);
			}
			for (const list of bySig.values()) {
				if (list.length < 2) continue;
				const parts = list.map(m => {
					m.updateWorldMatrix(true, false);
					return m.geometry.clone().applyMatrix4(m.matrixWorld);
				});
				const merged = mergeGeometries(parts);
				parts.forEach(p => p.dispose());
				if (!merged) continue;
				const mesh = new THREE.Mesh(merged, material);
				// (its bounds tree built on the first ray test)
				mesh.raycast = function (this: THREE.Mesh, ray: THREE.Raycaster, hits: THREE.Intersection[]) {
					merged.boundsTree ??= new MeshBVH(merged);
					acceleratedRaycast.call(this, ray, hits);
				};
				mesh.name = `merged props ${list[0].name}`;
				mesh.matrixAutoUpdate = false;
				mesh.userData.window = list[0].userData.window;
				for (const m of list) {
					m.removeFromParent();
					m.geometry.dispose();  // (each lit prop's own copy, see litProp)
				}
				this.propGroup.add(mesh);
			}
		}
		// prop groups left empty
		for (const o of [...this.propGroup.children]) if (!(o as THREE.Mesh).isMesh && !o.children.length) o.removeFromParent();
		this.windowed = this.propGroup.children.filter(o => o.userData.window && (o.userData.window[0] > -Infinity || o.userData.window[1] < Infinity));
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
				this.loaded();
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
				// stored BGRA, as vrad writes vertex light: linear^(1/2.2) x 0.5
				colors[i * 3] = vertexLight(vl[k + 2]);
				colors[i * 3 + 1] = vertexLight(vl[k + 1]);
				colors[i * 3 + 2] = vertexLight(vl[k]);
			}
			const g = part.baked.clone();
			g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
			const lit = new THREE.Mesh(g, this.library.forModel(part.group.materialCandidates, true));
			lit.name = part.name;
			out.add(lit);
		}
		return out;
	}

	// the players a co-op recording has, for following either
	players(): {index: number; name: string; recording: boolean}[] {
		const ents = this.entities;
		if (!ents) return [];
		const seen = new Map<number, {index: number; name: string; recording: boolean}>();
		for (const t of ents.tracks) {
			if (t.className !== 'CPortal_Player' || !t.keys.length || seen.has(t.index)) continue;
			const name = /eggbot/.test(t.model) ? 'P-body' : /ballbot/.test(t.model) ? 'ATLAS' : 'Chell';
			seen.set(t.index, {index: t.index, name, recording: t === ents.player});
		}
		return [...seen.values()];
	}

	follow(index: number | null) {
		const t = index === null ? null : this.entities?.tracks.find(c => c.className === 'CPortal_Player' && c.index === index) ?? null;
		this.followed = t && t !== this.entities?.player ? t : null;
		this.lastTarget = null;
	}

	private get followTrack(): EntityTrack | undefined {
		return this.followed ?? this.entities?.player;
	}

	setSegment(track: SegmentTrack, entities: EntityTimeline | null) {
		this.entities = entities;
		this.followed = null;
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
		if (this.pathLine) {
			this.scene.remove(this.pathLine);
			this.pathLine.geometry.dispose();
			(this.pathLine.material as THREE.Material).dispose();
		}
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
		disposeOwn(this.entityGroup);
		this.windowedKids = [];
		this.entityGroup.clear();
		this.frozen.clear();
		this.frozenCandidates = null;
		this.objects.clear();
		for (const g of this.vmObjects.values()) this.vmScene.remove(g);
		this.vmObjects.clear();
		this.vmShown = null;
	}

	private objectFor(t: EntityTrack, skin = 0, body = 0): THREE.Object3D | null {
		let o = this.objects.get(t);
		if (o !== undefined) {
			if (((o.userData.skin ?? 0) === skin && (o.userData.body ?? 0) === body) || !t.model.endsWith('.mdl')) return o;
			// a new skin (a cube lighting up on a button) or body groups
			// (PotatOS on the gun): rebuild
			this.entityGroup.remove(o);
			this.objects.delete(t);
		}
		o = this.makeObject(t, skin, body) ?? new THREE.Group();
		o.userData.skin = skin;
		o.userData.body = body;
		o.visible = false;
		this.objects.set(t, o);
		this.entityGroup.add(o);
		return o;
	}

	private makeObject(t: EntityTrack, skin = 0, body = 0): THREE.Object3D | null {
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
				this.loaded();
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
			this.model('models/weapons/w_portalgun.mdl', skin, body).then(asset => {
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
				if (asset.skeleton) group.userData.skeleton = asset.skeleton;
				this.loaded();
			});
			return group;
		}
		if (t.className === 'CProp_Portal') {
			const group = new THREE.Group();
			// co-op portals are tinted with their player's colours
			const team = Number(t.keys.find(k => Number(k.extra?.m_iTeamNum) >= 2)?.extra?.m_iTeamNum ?? 0);
			const coop = this.bsp?.name.startsWith('mp_') && (team === 2 || team === 3);
			const material = portalMaterial(this.effects, !!t.orange, coop ? this.portalColor(!!t.orange, team).map(c => c / 255) : null);
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
			group.userData.asset = asset;
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
			this.loaded();
		});
		return group;
	}

	// whether an entity's object is drawn at a key
	private shows(t: EntityTrack, k: EntityKey): boolean {
		const e = k.extra ?? {};
		switch (t.className) {
		case 'CProp_Portal': return (k.visible || (!!k.dormant && !k.nodraw)) && k.active === true;
		case 'CPortalLaser': return Number(e.m_bLaserOn) === 1 && !!vec3(e.m_vEndPoint);
		case 'CProjectedWallEntity': return !!vec3(e.m_vecStartPoint) && !!vec3(e.m_vecEndPoint);
		case 'CTrigger_TractorBeam': return Number(e.m_bDisabled) !== 1 && !!vec3(e.m_vStart);
		case 'CTriggerPortalCleanser': return Number(e.m_bVisible) === 1 && Number(e.m_bDisabled) !== 1;
		// out of the recording player's view: as last seen (what the game
		// would show anyone else looking), until deleted
		default: return k.visible || (!!k.dormant && !k.nodraw);
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
			(o.userData.funnel as Funnel).set(vec3(e.m_vStart)!, vec3(e.m_vEnd)!, Number(e.m_flRadius) || 55, Number(e.m_bReversed) === 1, time, Number(e.m_bFromPortal) === 1, Number(e.m_bToPortal) === 1);
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
			// the world through its bounds tree (solid faces: lasers pass glass),
			// and the (merged, tree-backed) props
			const world = this.collision?.raycastFirst(ray.ray, THREE.DoubleSide);
			const prop = ray.intersectObjects([this.propGroup], true)[0];
			const hit = [world, prop].filter((h): h is THREE.Intersection => !!h && h.distance <= 16384).sort((x, y) => x.distance - y.distance)[0];
			a = origin;
			b = hit ? hit.point.clone() : origin.clone().addScaledVector(newDir, 16384);
			out.push([a, b]);
		}
		return out;
	}

	// a mesh's bounds on screen in pixels (from the top left), padded a
	// little; null when part of it is behind the camera
	private screenRect(mesh: THREE.Mesh, size: THREE.Vector2): {x: number; y: number; w: number; h: number} | null {
		const g = mesh.geometry;
		g.boundingBox ?? g.computeBoundingBox();
		const b = g.boundingBox!;
		mesh.updateMatrixWorld();
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		const v = new THREE.Vector4();
		for (let i = 0; i < 8; i++) {
			v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z, 1)
				.applyMatrix4(mesh.matrixWorld).applyMatrix4(this.camera.matrixWorldInverse).applyMatrix4(this.camera.projectionMatrix);
			if (v.w <= 0.01) return null;
			const sx = (v.x / v.w * 0.5 + 0.5) * size.x, sy = (0.5 - v.y / v.w * 0.5) * size.y;
			x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
			y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
		}
		const x = Math.max(0, Math.floor(x0) - 2), y = Math.max(0, Math.floor(y0) - 2);
		const w = Math.min(size.x, Math.ceil(x1) + 2) - x, h = Math.min(size.y, Math.ceil(y1) + 2) - y;
		return w > 0 && h > 0 ? {x, y, w, h} : null;
	}

	// what each visible, linked portal shows: the scene from the camera moved
	// through the portal pair, clipped at the exit portal
	private renderPortalViews(r: THREE.WebGLRenderer) {
		const frameTarget = r.getRenderTarget();
		const size = r.getDrawingBufferSize(new THREE.Vector2());
		const dither = ditherUniforms.ditherOn.value;
		ditherUniforms.ditherOn.value = 0;
		const seen = new Set<THREE.Object3D>();
		// (only portals the camera can see get their view drawn: each is
		// another whole scene)
		this.camera.updateMatrixWorld();
		const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
		const camAt = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld);
		for (const p of this.portals.values()) {
			const surface = p.obj.userData.portalSurface as THREE.Mesh;
			const material = surface.material as THREE.ShaderMaterial;
			const linked = this.portals.get(p.link);
			seen.add(p.obj);
			if (!linked) {
				material.uniforms.hasView.value = 0;
				continue;
			}
			if (!p.obj.visible) continue;
			p.obj.updateMatrixWorld(true);
			const facing = new THREE.Vector3(1, 0, 0).transformDirection(p.obj.matrixWorld).dot(camAt.clone().sub(new THREE.Vector3().setFromMatrixPosition(p.obj.matrixWorld)));
			if (facing <= 0 || !frustum.intersectsObject(surface)) continue;
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
			// only the part of the screen the portal covers is drawn: the same
			// pixels (a view offset of the full projection into that viewport),
			// and whatever's outside it culled
			const rect = this.screenRect(surface, size);
			if (rect && rect.w < size.x * 0.95) {
				cam.setViewOffset(size.x, size.y, rect.x, rect.y, rect.w, rect.h);
				rt.viewport.set(rect.x, size.y - rect.y - rect.h, rect.w, rect.h);
				rt.scissor.copy(rt.viewport);
				rt.scissorTest = true;
			} else {
				cam.clearViewOffset();
				rt.viewport.set(0, 0, size.x, size.y);
				rt.scissorTest = false;
			}
			cam.updateProjectionMatrix();
			m.decompose(cam.position, cam.quaternion, cam.scale);
			cam.updateMatrixWorld(true);

			// clip away what's behind the exit portal: at its plane, which sits
			// 0.03 units off its wall (so the wall goes too, even where it's
			// drawn two-sided: brush entities, models, the back faces option)
			const normal = new THREE.Vector3(1, 0, 0).transformDirection(linked.obj.matrixWorld);
			const at = new THREE.Vector3().setFromMatrixPosition(linked.obj.matrixWorld);
			r.clippingPlanes = [new THREE.Plane(normal, -normal.dot(at))];
			const linkedSurface = linked.obj.userData.portalSurface as THREE.Mesh;
			surface.visible = linkedSurface.visible = false;
			this.sky.position.setFromMatrixPosition(cam.matrixWorld);
			r.setRenderTarget(rt);
			r.render(this.scene, cam);
			r.setRenderTarget(frameTarget);
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

	// Particle effects: info_particle_system runs (switched on to switched
	// off, then their particles live out their lives), the edges of open
	// portals, and effects the server dispatched (portal shots and muzzle
	// flashes). Each is simulated from its start, so seeking anywhere shows
	// the same thing.
	private updateParticles(tick: number) {
		const ents = this.entities, lib = this.particleLib;
		this.particlesShown = [];
		this.vmParticlesShown = [];
		if (!ents || !lib) return;
		const LINGER = 5 / this.interval;
		const seen = new Set<string>();
		const run = (key: string, name: string, start: number, end: number, cps: () => ControlPoints | null, opts: {cpAt?: (t: number) => THREE.Matrix4; fp?: boolean} = {}) => {
			const def = lib.get(name);
			if (!def || tick < start || tick > end + LINGER) return;
			const time = (tick - start) * this.interval;
			// a burst from long ago is over (no need to simulate it from the start)
			if (time > 8 && !isEndless(def, lib)) return;
			let r = this.particleRuns.get(key);
			if (!r || r.inst.time > time + 1e-4 || time - r.inst.time > 3) {
				const c = cps();
				if (!c) return;
				const inst = new ParticleInstance(def, lib, c, hashKey(key));
				if (opts.cpAt) inst.setCpAt(opts.cpAt);
				if (time > 6 && !opts.cpAt) inst.skipTo(time - 6);
				r = {start, inst};
				this.particleRuns.set(key, r);
			}
			seen.add(key);
			const stopAt = (end - start) * this.interval;
			if (time >= stopAt && r.inst.emitting) {
				r.inst.advance(stopAt);
				r.inst.stopEmitting();
			}
			r.inst.advance(time);
			if (r.inst.finished) return;
			// glows drawn over everything still go when the world hides their
			// origin from the camera (the game tests their visibility)
			if (this.particleRenderer?.ignoresDepth(def.material) && this.collision) {
				const at = new THREE.Vector3().setFromMatrixPosition(r.inst.cps.get(0) ?? new THREE.Matrix4());
				const to = at.clone().sub(this.camera.position);
				const dist = to.length();
				if (dist > 8) {
					const hit = this.collision.raycastFirst(new THREE.Ray(this.camera.position.clone(), to.divideScalar(dist)), THREE.DoubleSide);
					if (hit && hit.distance < dist - 8) return;
				}
			}
			(opts.fp ? this.vmParticlesShown : this.particlesShown).push(...r.inst.all);
		};

		for (const t of ents.tracks) {
			if (t.className === 'CParticleSystem') {
				const i = keyIndexAt(t, tick);
				if (i < 0) continue;
				const isOn = (j: number) => Number(t.keys[j].extra?.m_bActive) === 1;
				let j = i;
				while (j >= 0 && !isOn(j)) j--;
				if (j < 0) continue;
				let s = j;
				while (s > 0 && isOn(s - 1)) s--;
				let e = j + 1;
				while (e < t.keys.length && isOn(e)) e++;
				const k = t.keys[i];
				const name = ents.particleNames[Number(k.extra?.m_iEffectIndex ?? -1)] ?? '';
				run(`sys:${t.index}:${t.keys[s].tick}`, name, t.keys[s].tick, e < t.keys.length ? t.keys[e].tick : Infinity, () => {
					const cp = this.worldMatrix(t, k, tick, 0) ?? new THREE.Matrix4().setPosition(k.origin[0], k.origin[1], k.origin[2]);
					return new Map([[0, cp]]);
				});
			} else if (t.className === 'CTrigger_TractorBeam') {
				// the core particles the client runs along each funnel (from
				// when it last changed): start and end facing each other, the
				// flow velocity, the colour
				const i = keyIndexAt(t, tick);
				if (i < 0) continue;
				const k = t.keys[i], e = k.extra ?? {};
				const start = vec3(e.m_vStart), end = vec3(e.m_vEnd);
				if (!start || !end || Number(e.m_bDisabled) === 1 || !k.visible) continue;
				const same = (j: number) => {
					const x = t.keys[j].extra ?? {};
					return String(x.m_vStart) === String(e.m_vStart) && String(x.m_vEnd) === String(e.m_vEnd) && x.m_bReversed === e.m_bReversed && Number(x.m_bDisabled) !== 1;
				};
				let s0 = i;
				while (s0 > 0 && same(s0 - 1)) s0--;
				let e0 = i + 1;
				while (e0 < t.keys.length && same(e0)) e0++;
				const reversed = Number(e.m_bReversed) === 1;
				run(`funnel:${t.index}:${t.keys[s0].tick}`, 'tractor_beam_core', t.keys[s0].tick, e0 < t.keys.length ? t.keys[e0].tick : Infinity, () => {
					const dir = end.clone().sub(start).normalize();
					const side = Math.abs(dir.z) < 0.999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
					const right = new THREE.Vector3().crossVectors(dir, side).normalize();
					const up = new THREE.Vector3().crossVectors(right, dir).normalize();
					// (CP axes: forward, left, up)
					const left = right.clone().negate();
					const cp0 = new THREE.Matrix4().makeBasis(dir, left, up).setPosition(start);
					const cp1 = new THREE.Matrix4().makeBasis(dir.clone().negate(), right, up).setPosition(end);
					// the flow: the trigger's forward axis times its force
					const fwd = new THREE.Vector3(1, 0, 0).applyEuler(toEuler(k.angles));
					const force = Number(e.m_linearForce) || 250;
					const vel = fwd.multiplyScalar(reversed ? -force : force);
					const color = reversed ? [255, 56, 8] : [0, 49, 189];
					return new Map([[0, cp0], [1, cp1], [2, new THREE.Matrix4().setPosition(vel)], [3, new THREE.Matrix4().setPosition(color[0], color[1], color[2])]]);
				});
			} else if (t.className === 'CProp_Portal') {
				// the edge of each placement, until the portal closes or moves
				const i = keyIndexAt(t, tick);
				if (i < 0) continue;
				const placed = this.portalPlacedAt(t, tick);
				let pk = keyIndexAt(t, placed);
				if (pk < 0 || !(t.keys[pk].active && t.keys[pk].visible)) continue;
				const pkey = t.keys[pk];
				let e = pk + 1;
				while (e < t.keys.length && t.keys[e].active && t.keys[e].visible && !t.keys[e].origin.some((v, n) => Math.abs(v - pkey.origin[n]) > 0.5)) e++;
				const end = e < t.keys.length ? t.keys[e].tick : Infinity;
				const color = this.portalColor(!!t.orange, Number(pkey.extra?.m_iTeamNum ?? 0));
				run(`edge:${t.index}:${placed}`, 'portal_edge', placed, end, () => {
					const m = new THREE.Matrix4().compose(new THREE.Vector3(...pkey.origin), new THREE.Quaternion().setFromEuler(toEuler(pkey.angles)), new THREE.Vector3(1, 1, 1));
					// the edge's ring lies in X/Y: across the portal, up it; Z out of the wall
					const ex = new THREE.Vector3(), ey = new THREE.Vector3(), ez = new THREE.Vector3();
					m.extractBasis(ex, ey, ez);
					const cp0 = new THREE.Matrix4().makeBasis(ey, ez, ex).setPosition(pkey.origin[0], pkey.origin[1], pkey.origin[2]);
					return new Map([[0, cp0], [1, cp0.clone()], [7, new THREE.Matrix4().setPosition(color[0], color[1], color[2])]]);
				});
			}
		}

		// dispatched effects
		const eyes = this.mode === 'eyes';
		const me = this.followTrack?.index;
		ents.effects.forEach((fx, n) => {
			if (fx.tick > tick) return;
			if (fx.name === 'PortalBlast') {
				// the shot: from the gun to where the portal lands, in 0.1s
				const color = this.portalColor(fx.color === 2, this.teamOf(fx.entity, tick));
				const from = new THREE.Vector3(...fx.origin), to = new THREE.Vector3(...fx.start);
				const dir = to.clone().sub(from).normalize();
				const basis = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 0, 1));
				const flight = 0.1;
				const at = (t: number) => basis.clone().setPosition(from.clone().lerp(to, Math.min(1, t / flight)));
				run(`blast:${n}`, 'portal_projectile_stream', fx.tick, fx.tick + Math.round(flight / this.interval), () =>
					new Map([[0, at(0)], [1, at(0)], [2, new THREE.Matrix4().setPosition(color[0], color[1], color[2])]]), {cpAt: at});
				return;
			}
			if (fx.name !== 'ParticleEffect') return;
			const name = ents.particleNames[fx.hitbox] ?? '';
			const owner = this.ownerOf(fx.entity, tick);
			const fp = /_fp$/i.test(name);
			// first-person versions only through the recording player's eyes;
			// their third-person versions everywhere else
			if (fp && !(eyes && owner === me)) return;
			if (!fp && eyes && owner === me && owner !== undefined) return;
			// runs until the server stops that entity's effects
			const stop = ents.effects.find(s => s.name === 'ParticleEffectStop' && s.entity === fx.entity && s.tick > fx.tick)?.tick ?? Infinity;
			run(`fx:${n}`, name, fx.tick, stop, () => {
				const cp = this.attachmentAt(fx.entity, fx.attachment, tick, fp) ?? new THREE.Matrix4().compose(new THREE.Vector3(...fx.origin), new THREE.Quaternion().setFromEuler(toEuler(fx.angles)), new THREE.Vector3(1, 1, 1));
				return new Map([[0, cp]]);
			}, {fp});
		});
		for (const key of this.particleRuns.keys()) if (!seen.has(key)) this.particleRuns.delete(key);
	}

	// portal colours for particles: single player blue/orange, co-op by team
	// (ATLAS blue/purple, P-body orange/red), 0..255
	private portalColor(second: boolean, team: number): number[] {
		const coop = this.bsp?.name.startsWith('mp_') && (team === 2 || team === 3);
		if (!coop) return second ? [233, 78, 2] : [0, 60, 255];
		const c = team === 3 ? (second ? [0.075, 0, 0.824] : [0.125, 0.5, 0.824]) : (second ? [0.225, 0.01, 0.01] : [1, 0.705, 0.125]);
		return c.map(x => x * 255);
	}

	private teamOf(index: number, tick: number): number {
		const t = (this.tracksByIndex.get(index) ?? []).find(c => keyAt(c, tick));
		if (!t) return 0;
		// players: ATLAS is the blue team, P-body red
		return /eggbot/.test(t.model) ? 2 : /ballbot/.test(t.model) ? 3 : 0;
	}

	// the player an entity belongs to (itself, or the player a weapon or view model hangs off)
	private ownerOf(index: number, tick: number): number | undefined {
		const t = (this.tracksByIndex.get(index) ?? []).find(c => keyAt(c, tick));
		if (!t) return undefined;
		if (t.className === 'CPortal_Player') return t.index;
		if (t.className === 'CPredictedViewModel' || t.className === 'CBaseViewModel') {
			const h = Number(keyAt(t, tick)?.extra?.m_hOwner ?? -1);
			return h >= 0 && (h & 2047) !== 2047 ? h & 2047 : this.entities?.player?.index;
		}
		return keyAt(t, tick)?.parent;
	}

	// an entity's model attachment (1-based) in the world: the held gun's
	// muzzle, or the view model's
	private attachmentAt(index: number, attachment: number, tick: number, viewModel: boolean): THREE.Matrix4 | null {
		const t = (this.tracksByIndex.get(index) ?? []).find(c => keyAt(c, tick));
		if (!t || attachment < 1) return null;
		const o = viewModel ? this.vmShown : this.objects.get(t);
		const sk = o?.userData.skeleton as Skeleton | undefined;
		if (!o || !sk) return null;
		o.updateMatrixWorld(true);
		const anim = o.userData.anim as AnimatedModel | undefined;
		if (anim) {
			const a = attachmentMatrix(sk, boneMatrices(sk, anim.pose), attachment - 1);
			return a && o.matrixWorld.clone().multiply(a);
		}
		// the bone-merged gun: its weapon_bone is the group itself
		const a = sk.attachments[attachment - 1];
		if (!a) return null;
		const m = a.local;
		return o.matrixWorld.clone().multiply(new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1));
	}

	// the recording player's view model, posed by its networked animation
	private updateViewModel(tick: number) {
		if (this.vmShown) this.vmShown.visible = false;
		this.vmShown = null;
		const ents = this.entities;
		// the view model belongs to the recording player
		if (!ents || this.mode !== 'eyes' || this.followed) return;
		// co-op recordings carry both players' view models: the one the
		// recording player owns
		const me = ents.player?.index;
		const isVm = (c: EntityTrack) => (c.className === 'CPredictedViewModel' || c.className === 'CBaseViewModel') && keyAt(c, tick)?.visible && c.model.endsWith('.mdl');
		const owner = (c: EntityTrack) => {
			const h = Number(keyAt(c, tick)?.extra?.m_hOwner ?? -1);
			return h < 0 || (h & 2047) === 2047 ? undefined : h & 2047;
		};
		const vms = ents.tracks.filter(isVm);
		const t = vms.find(c => me !== undefined && owner(c) === me && !Number(keyAt(c, tick)?.extra?.m_nViewModelIndex ?? 0))
			?? (vms.some(c => owner(c) !== undefined) ? undefined : vms[0]);
		const k = t && keyAt(t, tick);
		if (!t || !k) return;
		let g = this.vmObjects.get(t);
		const body = Number(k.extra?.m_nBody ?? 0);
		if (g && (g.userData.body ?? 0) !== body) {
			// body groups changed (PotatOS on the gun): rebuild
			this.vmScene.remove(g);
			this.vmObjects.delete(t);
			g = undefined;
		}
		if (!g) {
			const group = new THREE.Group();
			g = group;
			group.userData.body = body;
			this.vmObjects.set(t, group);
			this.vmScene.add(group);
			this.model(t.model, k.skin ?? 0, body).then(asset => {
				if (!asset?.skeleton) return;
				const anim = new AnimatedModel(asset.skeleton, asset.parts.map(p => ({geometry: skinnedGeometry(p.group, p.raw), material: p.material})));
				group.add(anim.group);
				group.userData.anim = anim;
				group.userData.skeleton = asset.skeleton;
				this.loaded();
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

	// Moving models' lighting: the ambient cube and local lights at each
	// object's centre (recomputed when it moves), for the shader to use
	private lightModels() {
		const amb = this.bsp?.ambient;
		if (!amb) return;
		const hookMeshes = (o: THREE.Object3D) => {
			// (looked at again whenever its meshes change, at any depth: a model
			// replacing its placeholder box inside the object's group)
			let parts = '';
			o.traverse(c => {
				if ((c as THREE.Mesh).isMesh) parts += c.id + ',';
			});
			if (o.userData.ambParts !== parts) {
				o.userData.ambParts = parts;
				delete o.userData.ambAllHooked;
				delete o.userData.lightCentre;
			}
			if (o.userData.ambAllHooked) return;
			let pending = false, hooked = 0, meshes = 0;
			o.traverse(c => {
				const mesh = c as THREE.Mesh;
				if (mesh.isMesh) meshes++;
				if (!mesh.isMesh || mesh.userData.ambHooked) return;
				const shared = mesh.material as THREE.Material;
				if (!shared.userData?.ambientLit) return;
				// once the shared material has its texture: a copy of it for this mesh
				if (!(shared as THREE.MeshLambertMaterial).map && !shared.userData.textureless) {
					pending = true;
					return;
				}
				mesh.material = ownLitMaterial(shared);
				mesh.userData.ambHooked = true;
				useModelLighting(mesh);
				hooked++;
			});
			// done once its model has loaded and every part is hooked
			// (or it has nothing lit this way: brush models, beams)
			if (!pending && (hooked || o.userData.ambSomeHooked || meshes)) o.userData.ambAllHooked = true;
			if (hooked) o.userData.ambSomeHooked = true;
		};
		const p = new THREE.Vector3();
		const light = (o: THREE.Object3D, at: THREE.Vector3) => {
			const key = `${Math.round(at.x / 4)},${Math.round(at.y / 4)},${Math.round(at.z / 4)}`;
			if (o.userData.lightingKey === key) return;
			o.userData.lightingKey = key;
			o.userData.lighting = amb.at([at.x, at.y, at.z]);
		};
		const apply = (o: THREE.Object3D) => {
			hookMeshes(o);
			// (fresh world matrix: held objects are placed by hand each frame)
			o.updateWorldMatrix(true, false);
			// the model's centre in its own space, once it has loaded (models
			// with their origin at their feet are lit at their middle)
			let local = o.userData.lightCentre as THREE.Vector3 | undefined;
			if (!local) {
				o.updateMatrixWorld(true);
				const box = new THREE.Box3().setFromObject(o);
				local = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld.clone().invert());
				if (o.userData.ambAllHooked) o.userData.lightCentre = local;
			}
			light(o, p.copy(local).applyMatrix4(o.matrixWorld));
		};
		for (const o of this.objects.values()) if (o.visible) apply(o);
		for (const o of this.propGroup.children) if (!o.userData.ambAllHooked) apply(o);
		if (this.vmShown) {
			// the view model is lit where the eye is
			light(this.vmShown, this.camera.position);
			hookMeshes(this.vmShown);
		}
	}

	// An entity's origin and angles at a (fractional) tick: between network
	// updates they're interpolated, as the game's client does, over gaps of
	// up to a few updates (longer gaps are teleports or things appearing)
	private entityPose(t: EntityTrack, tick: number): {origin: THREE.Vector3; angles: Vec3} {
		const i = keyIndexAt(t, Math.floor(tick));
		const k = t.keys[Math.max(0, i)], n = t.keys[i + 1];
		const origin = new THREE.Vector3(k.origin[0], k.origin[1], k.origin[2]);
		if (!n || n.tick - k.tick > 8 || n.visible !== k.visible || n.parent !== k.parent) return {origin, angles: k.angles};
		// faster than anything moves (terminal velocity is ~58 units a tick): a teleport, through a portal or otherwise
		if (Math.hypot(n.origin[0] - k.origin[0], n.origin[1] - k.origin[1], n.origin[2] - k.origin[2]) > 70 * (n.tick - k.tick)) return {origin, angles: k.angles};
		const f = Math.min(1, Math.max(0, (tick - k.tick) / (n.tick - k.tick)));
		origin.lerp(new THREE.Vector3(n.origin[0], n.origin[1], n.origin[2]), f);
		const lerpAngle = (a: number, b: number) => {
			const d = ((b - a + 540) % 360) - 180;
			return a + d * f;
		};
		return {origin, angles: [lerpAngle(k.angles[0], n.angles[0]), lerpAngle(k.angles[1], n.angles[1]), lerpAngle(k.angles[2], n.angles[2])]};
	}

	// A player's eye in the world (position, and pitch/yaw as rotation):
	// the camera itself when it's the recording player in Eyes view, so
	// what they hold stays put in front of the view
	private eyeMatrix(t: EntityTrack, tick: number, useCamera: boolean): THREE.Matrix4 {
		if (useCamera) {
			return new THREE.Matrix4().compose(this.camera.position, new THREE.Quaternion().setFromEuler(toEuler([this.eyeAngles[0], this.eyeAngles[1], 0])), new THREE.Vector3(1, 1, 1));
		}
		const pose = this.entityPose(t, tick);
		const k = keyAt(t, Math.floor(tick))!;
		pose.origin.z += k.eyeZ ?? DEFAULT_EYE;
		return new THREE.Matrix4().compose(pose.origin, new THREE.Quaternion().setFromEuler(toEuler([pose.angles[0], pose.angles[1], 0])), new THREE.Vector3(1, 1, 1));
	}

	// Held objects (m_hAttachedObject): kept where they are relative to the
	// holder's view at the object's latest update (the holder as of that same
	// update), moved with the holder's smooth view. Held through a portal the
	// object is really on the other side (far off), and the game draws it in
	// front of the holder anyway: then the last offset that was in front of
	// them, or the usual hold distance.
	private placeHeld(tick: number) {
		const ents = this.entities!;
		for (const p of ents.tracks) {
			if (p.className !== 'CPortal_Player') continue;
			const k = keyAt(p, Math.floor(tick));
			const h = Number(k?.extra?.m_hAttachedObject ?? -1);
			if (!k || h < 0 || (h & 2047) === 2047) continue;
			const ot = (this.tracksByIndex.get(h & 2047) ?? []).find(c => keyAt(c, tick));
			const o = ot && this.objects.get(ot);
			const ok = ot && keyAt(ot, Math.floor(tick));
			if (!o || !ok) continue;
			o.visible = true;
			const hk = keyAt(p, ok.tick) ?? k;
			const holderThen = new THREE.Matrix4().compose(
				new THREE.Vector3(hk.origin[0], hk.origin[1], hk.origin[2] + (hk.eyeZ ?? DEFAULT_EYE)),
				new THREE.Quaternion().setFromEuler(toEuler([hk.angles[0], hk.angles[1], 0])), new THREE.Vector3(1, 1, 1));
			const objThen = new THREE.Matrix4().compose(new THREE.Vector3(...ok.origin), new THREE.Quaternion().setFromEuler(toEuler(ok.angles)), new THREE.Vector3(1, 1, 1));
			const local = holderThen.invert().multiply(objThen);
			const offset = new THREE.Vector3().setFromMatrixPosition(local);
			if (offset.length() <= HOLD_MAX) o.userData.heldOffset = offset.clone();
			else local.setPosition(o.userData.heldOffset ?? HOLD_OFFSET);
			const now = this.eyeMatrix(p, tick, this.mode === 'eyes' && p === this.followTrack).multiply(local);
			o.matrixAutoUpdate = false;
			o.matrix.copy(now);
			o.matrixWorldNeedsUpdate = true;
		}
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
	// relative to where they face), or floating in the air; the upper body
	// aims where they look (the sequences' aim-matrix layer)
	private playerAnim(t: EntityTrack, tick: number, sk: Skeleton): [number, number, Record<string, number>] {
		const m = this.playerMotion(t, sk);
		// (ticks between network updates are fractional)
		const i = Math.min(m.seq.length - 1, Math.max(0, Math.floor(tick) - m.start)) || 0;
		const k = keyAt(t, tick)!;
		const c = m.phase[i];
		return [m.seq[i], c - Math.floor(c), {move_x: m.moveX[i], move_y: m.moveY[i], body_pitch: -normPitch(k.angles[0]), body_yaw: 0}];
	}

	// a player's movement animation for every tick of their track: the
	// sequence, its direction, and its cycle (advanced tick by tick at the
	// speed-matched rate, so speed changes don't jump the legs)
	private motions = new WeakMap<EntityTrack, {start: number; seq: Int16Array; phase: Float64Array; moveX: Float32Array; moveY: Float32Array}>();
	private playerMotion(t: EntityTrack, sk: Skeleton) {
		const have = this.motions.get(t);
		if (have) return have;
		const seqs = new Map(sk.sequences.map((s, i) => [s.label, i]));
		const pick = (...labels: string[]) => {
			for (const l of labels) {
				const i = seqs.get(l);
				if (i !== undefined) return i;
			}
			return 0;
		};
		// Chell's float is portalgun_jump_float, the robots' portalgun_jumpfloat
		const FLOAT = pick('portalgun_jump_float', 'portalgun_jumpfloat'), RUN = pick('portalgun_run'), CROUCHWALK = pick('portalgun_crouchwalk');
		const IDLE = pick('portalgun_standing_idle'), CROUCH = pick('portalgun_crouch_idle');
		const start = t.keys[0].tick, n = Math.max(1, t.keys[t.keys.length - 1].tick - start + 1);
		const seq = new Int16Array(n), phase = new Float64Array(n), moveX = new Float32Array(n), moveY = new Float32Array(n);
		let ki = 0, cycle = 0;
		for (let i = 0; i < n; i++) {
			const tick = start + i;
			while (ki + 1 < t.keys.length && t.keys[ki + 1].tick <= tick) ki++;
			const k = t.keys[ki];
			const before = keyAt(t, tick - 6) ?? k;
			const dt = Math.max(6, k.tick - before.tick) * this.interval;
			const v = [0, 1, 2].map(a => (k.origin[a] - before.origin[a]) / dt);
			const speed = Math.hypot(v[0], v[1]);
			const flags = Number(k.extra?.m_fFlags ?? NaN);
			// FL_ONGROUND and FL_DUCKING when recorded, else guessed from motion
			const air = Number.isNaN(flags) ? Math.abs(v[2]) > 40 : !(flags & 1);
			const crouched = Number.isNaN(flags) ? k.eyeZ !== undefined && k.eyeZ < 50 : !!(flags & 2);
			let s: number, rate = 1;
			if (air) s = FLOAT;
			else if (speed > 15) {
				s = crouched ? CROUCHWALK : RUN;
				rate = Math.min(2, Math.max(0.4, speed / (crouched ? 63 : 175)));
				const yaw = k.angles[1] * Math.PI / 180;
				moveX[i] = (v[0] * Math.cos(yaw) + v[1] * Math.sin(yaw)) / speed;
				moveY[i] = (-v[0] * Math.sin(yaw) + v[1] * Math.cos(yaw)) / speed;
			} else s = crouched ? CROUCH : IDLE;
			seq[i] = s;
			cycle += this.interval * sequenceRate(sk, s) * rate;
			phase[i] = cycle;
		}
		const m = {start, seq, phase, moveX, moveY};
		this.motions.set(t, m);
		return m;
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

	// Auto exposure, as the engine's (mat_tonemap_algorithm 1): every few
	// frames the view is drawn small, and the scale is set from a histogram
	// of it (see histogramTarget); within the tonemap controller's range,
	// approached gradually.
	private meterExposure(r: THREE.WebGLRenderer, measure = true) {
		const now = performance.now();
		const dt = Math.min(0.5, (now - this.lastRender) / 1000);
		this.lastRender = now;
		if (this.meterCount++ % 8 === 0 && !this.meterPending && measure) {
			const w = 64, h = 36;
			// (with a stencil buffer: the sky is masked to the sky faces by it)
			this.meter ??= new THREE.WebGLRenderTarget(w, h, {type: THREE.HalfFloatType, stencilBuffer: true});
			const fog = this.scene.fog;
			this.scene.fog = null;
			// with a 3D skybox the sky box sits at the sky camera, where it
			// would cover the whole view here
			const skyShown = this.sky.visible;
			if (this.skyCamera) this.sky.visible = false;
			// nor do the viewer's own overlays (the path line is bright enough
			// to set the exposure by itself)
			const overlays = ([this.pathLine, this.player] as (THREE.Object3D | null)[]).filter((o): o is THREE.Object3D => !!o && o.visible);
			for (const o of overlays) o.visible = false;
			const frameTarget = r.getRenderTarget();
			r.setRenderTarget(this.meter);
			r.render(this.scene, this.camera);
			// the view model counts too (the game meters the whole frame, and
			// the gun is often its brightest part)
			if (this.mode === 'eyes' && this.vmShown) {
				this.vmCam.position.copy(this.camera.position);
				this.vmCam.quaternion.copy(this.camera.quaternion);
				this.vmCam.aspect = this.camera.aspect;
				this.vmCam.updateProjectionMatrix();
				const auto = r.autoClear;
				r.autoClear = false;
				r.clearDepth();
				r.render(this.vmScene, this.vmCam);
				r.autoClear = auto;
			}
			r.setRenderTarget(frameTarget);
			for (const o of overlays) o.visible = true;
			this.sky.visible = skyShown;
			this.scene.fog = fog;
			// read back without waiting for the GPU (it lands a frame or two later)
			const px = new Uint16Array(w * h * 4);
			this.meterPending = true;
			const exposed = this.exposure;
			r.readRenderTargetPixelsAsync(this.meter, 0, 0, w, h, px).then(() => {
				const target = histogramTarget(px, w, h, exposed);
				if (target) this.meterTarget = Math.min(this.exposureRange[1], Math.max(this.exposureRange[0], target));
			}).catch(() => {}).finally(() => { this.meterPending = false; });
		}
		const t = Math.min(this.exposureRange[1], Math.max(this.exposureRange[0], this.meterTarget ?? this.exposure));
		this.exposure += (t - this.exposure) * Math.min(1, dt * 1.5);
		r.toneMappingExposure = this.exposure;
		exposureUniforms.sceneExposure.value = this.exposure;
	}
	private meterTarget: number | null = null;
	private meterPending = false;

	// the fog colour as drawn: three mixes fog in after exposure and output
	// encoding, so it's given already exposed and encoded
	private updateFog() {
		const fog = this.fog, sceneFog = this.scene.fog as THREE.Fog | null;
		if (!fog || !sceneFog) {
			if (sceneFog) sceneFog.far = sceneFog.near = 1e9;
			fogUniforms.fogMaxDensity.value = 0;
			return;
		}
		// (linear and unexposed, as the frame is drawn)
		const lin = (v: number) => Math.pow(v / 255, 2.2);
		sceneFog.color.setRGB(lin(fog.color[0]), lin(fog.color[1]), lin(fog.color[2]), THREE.LinearSRGBColorSpace);
		sceneFog.near = fog.start;
		sceneFog.far = fog.end;
		fogUniforms.fogMaxDensity.value = fog.maxDensity;
		if (this.scene.background instanceof THREE.Color) {
			const m = fog.maxDensity;
			this.scene.background.setRGB(lin(fog.color[0]) * m, lin(fog.color[1]) * m, lin(fog.color[2]) * m, THREE.LinearSRGBColorSpace);
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
				this.bumpTex.forEach((t, k) => {
					const h = t.image.data as unknown as Uint16Array, src = lm.bump[k];
					for (let i = start; i < start + b.w * 4; i++) h[i] = THREE.DataUtils.toHalfFloat(src[i]);
				});
			}
		}
		tex.needsUpdate = true;
		for (const t of this.bumpTex) t.needsUpdate = true;
	}

	private animAt(t: EntityTrack, tick: number, sk: Skeleton): [number, number] {
		const i = keyIndexAt(t, tick);
		const k = t.keys[i];
		const a = k.anim!;
		const looping = sk.sequences[a.sequence]?.looping ?? false;
		const wrap = (c: number) => (looping ? c - Math.floor(c) : Math.min(1, Math.max(0, c)));
		// a view model the recording player predicts carries no cycle (always
		// 0): it runs on the client, from when each sequence started
		let clientRun = t.userData?.clientRun as boolean | undefined;
		if (clientRun === undefined) {
			clientRun = (t.className === 'CPredictedViewModel' || t.className === 'CBaseViewModel') && t.keys.every(c => !c.anim || c.anim.cycle === 0);
			(t.userData ??= {}).clientRun = clientRun;
		}
		if (a.clientSide || clientRun) {
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
			// what players hold: the server hides it from its holder (the game
			// draws a copy in front of the view instead), so it's shown here
			for (const o of this.windowed) o.visible = tick >= o.userData.window[0] && tick < o.userData.window[1];
			for (const o of this.windowedKids) o.visible = tick >= o.userData.window[0] && tick < o.userData.window[1];
			const held = new Set<number>();
			for (const p of ents.tracks) {
				if (p.className !== 'CPortal_Player') continue;
				const h = Number(keyAt(p, tick)?.extra?.m_hAttachedObject ?? -1);
				if (h >= 0 && (h & 2047) !== 2047) held.add(h & 2047);
			}
			for (const t of ents.tracks) {
				const k = keyAt(t, tick);
				if (this.frozen.has(t)) continue;  // (drawn with the static props)
				const show = !!k && (this.shows(t, k) || (held.has(t.index) && t.model.endsWith('.mdl')));
				const o = show ? this.objectFor(t, k?.skin ?? 0, Number(k?.extra?.m_nBody ?? 0)) : this.objects.get(t);
				if (!o) continue;
				o.visible = show;
				// a doorway's fade brush: drawn by the camera's distance (a closed
				// door's black backing; open doors fade it out)
				if (show && k && t.className === 'CFuncAreaPortalWindow') o.visible = this.portalWindowBlend(o, k) >= 0.5;
				if (show && k && WORLD_SPACE.has(t.className)) {
					this.placeEffect(t, k, o, time);
					continue;
				}
				// the recording player (and their gun) are the camera in Eyes view
				const fp = this.followTrack;
				if (show && this.mode === 'eyes' && (t === fp || (t.className === 'CWeaponPortalgun' && fp && k?.parent === fp.index))) o.visible = false;
				if (show && k) {
					const anim = o.userData.anim as AnimatedModel | undefined;
					if (anim && k.anim) {
						const [seq, cycle] = this.animAt(t, tick, o.userData.skeleton);
						anim.setPose(seq, cycle);
					} else if (anim && t.className === 'CPortal_Player') {
						const [seq, cycle, params] = this.playerAnim(t, tick, o.userData.skeleton);
						anim.setPose(seq, cycle, params);
					}
					// between network updates, moving things are interpolated
					const pose = this.entityPose(t, tick);
					o.position.copy(pose.origin);
					// players turn with their view but don't tilt
					o.rotation.copy(toEuler(t.className === 'CPortal_Player' ? [0, pose.angles[1], 0] : pose.angles));
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

		// player: the decoded entity where there is one, else the recorded view
		// the followed player: the recording one (its recorded view), or the
		// other co-op player (its networked position and aim, interpolated)
		const ft = this.followTrack;
		const pk = ft ? keyAt(ft, tick) : undefined;
		const other = !!this.followed && !!pk;
		const otherPose = other ? this.entityPose(this.followed!, tick) : null;
		const feet = otherPose ? otherPose.origin.clone() : pk ? new THREE.Vector3(...pk.origin) : view ? new THREE.Vector3(...view.origin) : null;
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
				const ang = otherPose ? otherPose.angles : view?.angles ?? pk?.angles ?? [0, 0, 0];
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
		// after the camera: the view model and what the recording player
		// holds follow this frame's view
		this.updateViewModel(tick);
		if (ents) this.placeHeld(tick);
		this.updateParticles(tick);
		this.lightModels();
		this.render();
	}

	private frame: THREE.WebGLRenderTarget | null = null;
	private compileNeeded = true;
	private recheck: ReturnType<typeof setTimeout> | undefined;
	private compiling = new Set<THREE.Material>();

	// the drawn meshes whose shaders are still compiling (none once all are)
	private notReady(r: THREE.WebGLRenderer): THREE.Object3D[] {
		if (!this.compiling.size) return [];
		const props = (r as unknown as {properties: {get(m: THREE.Material): {currentProgram?: {isReady(): boolean}}}}).properties;
		for (const m of [...this.compiling]) {
			const program = props.get(m).currentProgram;
			if (!program || program.isReady()) this.compiling.delete(m);
		}
		if (!this.compiling.size) return [];
		const out: THREE.Object3D[] = [];
		const visit = (o: THREE.Object3D) => {
			if (!o.visible) return;
			const mesh = o as THREE.Mesh;
			if (mesh.material && !Array.isArray(mesh.material) && this.compiling.has(mesh.material)) {
				out.push(o);
				return;
			}
			for (const c of o.children) visit(c);
		};
		visit(this.scene);
		visit(this.vmScene);
		return out;
	}
	// the final pass: the frame times the exposure, clamped (the game's
	// linear tone mapping) and sRGB-encoded
	private composite = new THREE.ShaderMaterial({
		uniforms: {frame: {value: null}, exposure: {value: 1}},
		depthTest: false,
		depthWrite: false,
		vertexShader: `
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = vec4(position.xy, 0.0, 1.0);
			}`,
		fragmentShader: `
			uniform sampler2D frame;
			uniform float exposure;
			varying vec2 vUv;
			void main() {
				vec3 c = clamp(texture2D(frame, vUv).rgb * exposure, 0.0, 1.0);
				c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
				gl_FragColor = vec4(c, 1.0);
			}`,
	});
	private compositeScene = new THREE.Scene().add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite), {frustumCulled: false}));
	private compositeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

	render() {
		const r = this.renderer;
		if (!r) return;
		// orbit: the camera stays on the player's side of walls, as a game's
		// third-person camera does (the user's distance is kept for later);
		// before metering, which must see what's drawn
		const saved = this.mode === 'orbit' ? this.pullInCamera() : null;
		this.camera.updateMatrixWorld();
		// shaders compile in the background (parallel compile) and whatever
		// is still compiling sits this frame out (the meter's too), rather
		// than the page stalling until the driver has built it
		const size = r.getDrawingBufferSize(new THREE.Vector2());
		if (!this.frame) {
			this.frame = new THREE.WebGLRenderTarget(size.x, size.y, {type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true, samples: 4});
		} else if (this.frame.width !== size.x || this.frame.height !== size.y) this.frame.setSize(size.x, size.y);
		r.setRenderTarget(this.frame);
		if (this.compileNeeded) {
			this.compileNeeded = false;
			for (const m of r.compile(this.scene, this.camera)) this.compiling.add(m);
			for (const m of r.compile(this.vmScene, this.vmCam)) this.compiling.add(m);
		}
		const waiting = this.notReady(r);
		for (const o of waiting) o.visible = false;
		if (this.bsp) {
			if (!this.skyCamera) this.sky.position.copy(this.camera.position);
			// (not metered while anything sits out: it'd read too dark)
			this.meterExposure(r, waiting.length === 0);
			this.updateFog();
		}
		this.particleRenderer?.draw(this.particlesShown, this.camera);
		this.vmParticleRenderer?.draw(this.vmParticlesShown, this.camera);
		// Everything is drawn linear and unexposed into one HDR frame (as the
		// portal views and the meter are, so each material compiles once),
		// then exposed, clamped and encoded to the screen by a final pass
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
		for (const o of waiting) o.visible = true;
		// (and drawn again once they're ready, even while paused)
		if (waiting.length && !this.recheck) this.recheck = setTimeout(() => {
			this.recheck = undefined;
			this.onLoaded();
		}, 30);
		r.setRenderTarget(null);
		this.composite.uniforms.frame.value = this.frame.texture;
		this.composite.uniforms.exposure.value = this.exposure;
		r.render(this.compositeScene, this.compositeCam);
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
	snapshot(w: number, h: number, eye?: number[], ang?: number[], type = 'image/png'): string {
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
		const url = r.domElement.toDataURL(type, 0.9);
		r.setSize(size.x, size.y, false);
		this.camera.aspect = aspect;
		this.camera.updateProjectionMatrix();
		this.camera.position.copy(saved[0]);
		this.camera.quaternion.copy(saved[1]);
		this.render();
		return url;
	}

	// how solid a func_areaportalwindow's brush is (C_FuncAreaPortalWindow::
	// GetDistanceBlend): the camera's distance from its bounds remapped from
	// the fade start..end distances to the translucency limit..1
	private portalWindowBlend(o: THREE.Object3D, k: EntityKey): number {
		const e = k.extra ?? {};
		const start = Number(e.m_flFadeStartDist ?? 0), end = Number(e.m_flFadeDist ?? 0), limit = Number(e.m_flTranslucencyLimit ?? 0);
		const box = (o.userData.windowBox ??= new THREE.Box3()) as THREE.Box3;
		box.setFromObject(o);
		const dist = box.isEmpty() ? 0 : box.distanceToPoint(this.camera.position);
		if (start === end) return dist >= end ? 1 : limit;
		const t = Math.min(1, Math.max(0, (dist - start) / (end - start)));
		return limit + (1 - limit) * t;
	}

	// debugging: renderer counters (of the last frame) and GPU memory
	debugStats(): Record<string, number> {
		const i = this.renderer?.info;
		return i ? {calls: i.render.calls, triangles: i.render.triangles, programs: i.programs?.length ?? 0, textures: i.memory.textures, geometries: i.memory.geometries} : {};
	}

	// debugging: the recording player's track
	debugPlayer(): EntityTrack | undefined {
		return this.entities?.player;
	}

	// debugging: the track at a network index (of a class)
	debugTrack(index: number, className: string): EntityTrack | undefined {
		return (this.tracksByIndex.get(index) ?? []).find(t => t.className === className);
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

// frees what an entity object owns: its meshes' own lit materials, skinned
// geometry and frozen-prop geometry (the model's shared ones stay cached)
function disposeOwn(root: THREE.Object3D) {
	root.traverse(o => {
		const mesh = o as THREE.Mesh;
		if (!mesh.isMesh) return;
		if (mesh.userData.ambHooked && !Array.isArray(mesh.material)) mesh.material.dispose();
		if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || mesh.userData.frozenKid) mesh.geometry.dispose();
	});
}

// a stable seed from a run's key
function hashKey(key: string): number {
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
	return h >>> 0;
}
