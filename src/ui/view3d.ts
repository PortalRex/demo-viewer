// 3D replay: the map's geometry from the viewer's own game files, with the
// recorded entities (portals, brush entities, props) and the player's view.
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {MeshBVH, acceleratedRaycast} from 'three-mesh-bvh';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {composeLightmap, styleValue} from '../game/bsp.ts';
import type {BspMap, MeshData, MaterialGroup, ModelMesh} from '../game/bsp.ts';
import type {GameFiles} from '../game/files.ts';
import type {Materials, MaterialInfo, WaterParams} from '../game/materials.ts';
import {readVtfCube, decodeVtf, VtfFormat} from '../game/vtf.ts';
import {loadModel} from '../game/mdl.ts';
import type {StudioModel, ModelGroup} from '../game/mdl.ts';
import {loadSkeleton, referencePose, samplePose, sequenceRate} from '../game/anim.ts';
import type {Gesture, Skeleton} from '../game/anim.ts';
import {AnimatedModel, attachmentMatrix, bakePose, boneMatrices, skinMatrices, skinnedGeometry} from './skinning.ts';
import {Laser, Bridge, Funnel, fizzlerMaterial, portalMaterial, vec3, EffectAssets} from './effects.ts';
import {PaintLayer} from './paint.ts';
import {ParticleLibrary, ParticleInstance, ParticleRenderer, isEndless} from './particles.ts';
import type {ControlPoints, InstanceState} from './particles.ts';
import {AMBIENT_SCALE, modelAmbientUniforms, flashUniforms, exposureUniforms, paintUniforms, ditherUniforms, fogUniforms, waterUniforms, waterMaterialUniforms, hookWorldMaterial, hookModelMaterial, useModelLighting, ownLitMaterial, setModelEnvCube, bumpLightUniforms, setWorldEnv, setWorldDetail} from './shaderhooks.ts';
import {TextureCache, compressedSupport} from './textures.ts';
import {anyVisible} from '../game/vis.ts';
import {Zip} from '../game/zip.ts';
import {readVhv} from '../game/vhv.ts';
import {PaintBlobs, type Sprayer, type BlobShape} from './paintblobs.ts';
import {Ropes, type RopeSpec} from './ropes.ts';
import {MovieScreens, type ScreenSpec} from './movies.ts';
import {Sprites, type SpriteSpec} from './sprites.ts';
import type {EntityTimeline, EntityTrack, EntityKey} from '../net/entities.ts';
import {keyAt, keyIndexAt, type ScreenFade, type HudMessage} from '../net/entities.ts';
import {viewAt, type SegmentTrack, type ViewState} from '../player/playback.ts';
import type {Vec3} from '../core/model.ts';
import {later} from '../core/later.ts';
import {Bloom, ENCODE} from './bloom.ts';

export type CameraMode = 'eyes' | 'orbit' | 'free';

// Portal 2's 90° horizontal FOV at 4:3, as a vertical FOV (widescreen keeps it)
const VERTICAL_FOV = 2 * Math.atan(Math.tan(Math.PI / 4) * 3 / 4) * 180 / Math.PI;
const DEFAULT_EYE = 64;
const PORTAL_HALF_W = 32, PORTAL_HALF_H = 56;
// The view model's field of view: Portal's client mode takes cl_viewmodelfov
// (50 by default, read from client.dll; viewmodel_fov is the unused generic
// one), horizontal at 4:3; as a vertical angle
const VIEWMODEL_HALF_FOV = 25 * Math.PI / 180;
const VIEWMODEL_FOV = 2 * Math.atan(Math.tan(VIEWMODEL_HALF_FOV) * 3 / 4) * 180 / Math.PI;
// First-person particles: the engine draws them in the world's view (fov
// 90), only moving the view model's attachments to where they show in its
// narrower view (FormatViewModelAttachment); drawn here with the view
// model's camera, so their sprites are scaled by the ratio of the two
const VM_PARTICLE_SCALE = Math.tan(VIEWMODEL_HALF_FOV) / Math.tan(45 * Math.PI / 180);

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
// (the same wrap, for yaws: AngleNormalize)
const normYaw = normPitch;

function geometry(m: MeshData) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
	g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
	g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
	if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
	if (m.lightUv) g.setAttribute('uv1', new THREE.BufferAttribute(m.lightUv, 2));
	if (m.blend) g.setAttribute('blend', new THREE.BufferAttribute(m.blend, 1));
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
// gel colours by power (bounce, reflect, speed, portal, erase)
const PAINT_COLORS: Record<number, number[]> = {0: [20, 120, 255], 1: [160, 160, 160], 2: [255, 110, 0], 3: [235, 235, 235], 4: [110, 125, 140]};

// The engine's tonemap target from a histogram of the frame as drawn at
// `exposure` (RGBA half floats, unexposed): only the middle 90% x 85% of
// the view counts; pixels go in 16 buckets of linear luminance (edges
// (k/16)^2.5, with everything over 1 in the top one; the engine's
// mat_show_histogram says linear); the scale aims to put
// the brightest 2% at 0.6 (holding still when 0.6 is already in their
// bucket), or the median at 0.03 if that's brighter. Null with nothing to
// measure.
function histogramTarget(px: Uint16Array, w: number, h: number, exposure: number, fade?: {rgb: number[]; alpha: number; modulate: boolean}): number | null {
	const fadeLum = fade ? 0.2126 * fade.rgb[0] + 0.7152 * fade.rgb[1] + 0.0722 * fade.rgb[2] : 0;
	const faded = (lum: number) => !fade?.alpha ? lum : fade.modulate ? lum * (1 - fade.alpha + fade.alpha * fadeLum) : lum * (1 - fade.alpha) + fade.alpha * fadeLum;
	const BUCKETS = 16;
	const edges = Array.from({length: BUCKETS + 1}, (_, k) => Math.pow(k / BUCKETS, 2.5));
	const counts = new Array(BUCKETS).fill(0);
	const f = THREE.DataUtils.fromHalfFloat;
	const enc = (v: number) => Math.min(1, Math.max(0, v * exposure));
	let total = 0;
	for (let y = Math.floor(h * 0.075); y < Math.ceil(h * 0.925); y++) {
		for (let x = Math.floor(w * 0.05); x < Math.ceil(w * 0.95); x++) {
			const i = (y * w + x) * 4;
			const lum = faded(0.2126 * enc(f(px[i])) + 0.7152 * enc(f(px[i + 1])) + 0.0722 * enc(f(px[i + 2])));
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
	cameraTexture: THREE.Texture | null = null;  // what point_cameras draw into (see View3D.renderMonitorCamera)
	private world = new Map<string, THREE.Material>();
	private model = new Map<string, THREE.Material>();
	private litModel = new Map<string, THREE.Material>();

	// frees the map's materials (when the map changes; the textures are kept
	// for the next)
	dispose() {
		for (const cache of [this.world, this.model, this.litModel]) {
			for (const m of cache.values()) m.dispose();
			cache.clear();
		}
		for (const p of this.cubes.values()) p.then(c => {
			if (!c) return;
			for (const f of c.texture.image as THREE.Texture[]) f.dispose?.();
			c.texture.dispose();
		});
		this.cubes.clear();
	}
	onChange = () => {};

	constructor(textures: TextureCache, materials: Materials, lightmap: THREE.Texture | null) {
		this.materials = materials;
		this.textures = textures;
		this.lightmap = lightmap;
	}

	private apply(mat: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial, info: MaterialInfo, frame = 0) {
		// a monitor screen ($basetexture _rt_Camera): what the active
		// point_camera sees, unlit, tinted as dev_tvmonitor's proxies hold it
		if (info.baseTexture === '_rt_camera' && this.cameraTexture) {
			mat.userData.textureless = true;
			mat.userData.cameraScreen = true;
			mat.vertexColors = false;
			mat.lightMap = null;
			mat.map = this.cameraTexture;
			mat.color.setRGB(0.9, 0.95, 1);
			mat.needsUpdate = true;
			return;
		}
		if (info.shader === 'refract') {
			this.applyRefract(mat, info);
			return;
		}
		// a cloak pass that's fully opaque (CloakBlendedPassIsFullyOpaque: the
		// factor 0.444 or more) replaces the model's own drawing with the screen
		// behind it, unbent at a factor of 1: nothing to draw (the reflection
		// cube's lens)
		if (info.cloakFactor >= 0.6 / 1.35) {
			mat.visible = false;
			return;
		}
		// the Black shader: solid black (the void behind backdrops)
		if (info.shader === 'black') {
			mat.userData.textureless = true;
			mat.vertexColors = false;
			mat.color.setRGB(0, 0, 0);
			mat.needsUpdate = true;
			return;
		}
		if (info.water) {
			this.applyWater(mat, info);
			return;
		}
		if (info.translucent || info.liquid) {
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
		// a lit model's reflection (the cube is per object, see lightModels;
		// a mask in the bump map's alpha needs the bump map, which models don't draw)
		const envMask = !mat.userData.vertexLit && mat.userData.ambientLit && info.envMap && info.envMask !== 'bump'
			? (info.envMask === 'texture' && info.envMaskTexture ? this.textures.get(info.envMaskTexture, true) : Promise.resolve(null))
			: null;
		const glowMask = mat.userData.ambientLit && info.selfIllum && info.selfIllumMask ? this.textures.get(info.selfIllumMask, true) : Promise.resolve(null);
		// $phong's mask (the bump map's alpha, unless it's the base's) and exponents
		const phong = mat.userData.ambientLit && info.phong;
		const phongMask = phong && !info.phongBaseMask && info.bumpMap ? this.textures.get(info.bumpMap, true) : Promise.resolve(null);
		const phongExp = phong && info.phongExponentTexture ? this.textures.get(info.phongExponentTexture, true) : Promise.resolve(null);
		Promise.all([this.textures.get(info.baseTexture, false, frame), envMask, glowMask, phongMask, phongExp]).then(([tex, maskMap, glow, phMask, phExp]) => {
			if (!tex) return;
			// (with neither a mask nor alpha in the base texture, the engine drops it)
			if (mat.userData.ambientLit && info.selfIllum && (glow || tex.userData.hasAlpha)) mat.userData.selfIllum = {tint: info.selfIllumTint, mask: glow};
			if (mat.userData.ambientLit && info.phong) {
				mat.userData.phong = {
					exponent: info.phongExponent, boost: info.phongBoost, fresnel: info.phongFresnel, tint: info.phongTint,
					baseMask: info.phongBaseMask && !!tex.userData.hasAlpha, maskMap: phMask?.userData.hasAlpha ? phMask : null, expMap: phExp,
				};
			}
			if (envMask) {
				mat.userData.modelEnv = {
					tint: info.envTint, contrast: info.envContrast, saturation: info.envSaturation, lightScale: info.envLightScale,
					mask: info.envMask === 'texture' && !maskMap ? 'none' : info.envMask, maskMap, cube: info.envMap,
				};
			}
			mat.map = tex;
			// lit props keep their vertex colours: those are the baked light
			if (!mat.userData.vertexLit) mat.vertexColors = false;
			const k = mat.userData.scale ?? 1;
			mat.color.setRGB(info.color[0] * k, info.color[1] * k, info.color[2] * k);
			mat.needsUpdate = true;
			this.onChange();
		});
	}

	// a Water surface: opaque (its fog ends within inches), drawn by the water
	// shader over its flow map; a reflection of the scene is drawn for it
	// each frame (View3D.renderWaterReflections), a cubemap's loaded here
	private applyWater(mat: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial, info: MaterialInfo) {
		const w = info.water!;
		mat.transparent = false;
		mat.depthWrite = true;
		mat.opacity = 1;
		mat.vertexColors = false;
		mat.userData.textureless = true;
		const u = waterMaterialUniforms();
		u.waterFlowA.value.set(1 / w.worldUvScale, 1 / w.normalUvScale, w.bumpStrength, w.colorDisplace);
		u.waterFlowB.value.set(w.timeInterval, w.scrollDistance, w.noiseScale, w.reflectAmount);
		u.waterColor.value.set(1 / w.colorUvScale, w.colorInterval, w.colorScroll, w.colorLerpExp);
		// (colours in gamma space, as the shader's set up with them)
		const lin = (c: number[]) => c.map(v => Math.pow(v, 2.2)) as [number, number, number];
		u.waterReflectTint.value.set(...(w.reflect === 'none' ? [0, 0, 0] as [number, number, number] : lin(w.reflectTint)));
		u.waterFogColor.value.set(...lin(w.fogColor));
		u.waterRefractTint.value.set(...lin(w.refractTint));
		u.waterRefractParams.value.set(w.fogStart, w.fogEnd, w.refractAmount, 0);
		mat.userData.waterUniforms = u;
		mat.userData.water = w;
		const defines: Record<string, string> = {WATER: ''};
		if (w.lightmapFog) defines.WATER_LMFOG = '';
		if (w.refract) defines.WATER_REFRACT = '';
		if (w.reflect === 'planar') defines.WATER_PLANAR = '';
		mat.defines = {...mat.defines, ...defines};
		const linear = (name: string) => name ? this.textures.get(name, true) : Promise.resolve(null);
		Promise.all([linear(w.flowMap), linear(w.normalMap), linear(w.noiseTexture), info.baseTexture ? this.textures.get(info.baseTexture) : Promise.resolve(null)]).then(([flow, normal, noise, base]) => {
			if (!normal) return;
			for (const t of [flow, normal, noise, base]) if (t) t.wrapS = t.wrapT = THREE.RepeatWrapping;
			mat.map = flow ?? normal;
			// (the engine maps the faces by the base texture's size, not the
			// compiler's: the flow map's coordinates are scaled to match)
			const mapped = ((base ?? normal).userData.fullSize as number[] | undefined)?.[0];
			const compiled = (mat.userData.texSize as number[] | undefined)?.[0];
			if (mapped && compiled) u.waterFlowA.value.x = compiled / mapped / w.worldUvScale;
			u.waterNormal.value = normal;
			u.waterNoise.value = noise;
			u.waterBase.value = base;
			if (flow && noise) mat.defines!.WATER_FLOW = '';
			if (flow && noise && base) mat.defines!.WATER_BASE = '';
			mat.needsUpdate = true;
			this.onChange();
		});
		if (w.reflect === 'cube' && info.envMap && info.envMap !== 'env_cubemap') {
			this.cube(info.envMap).then(cube => {
				if (!cube) return;
				u.waterCube.value = cube.texture;
				u.waterCubeScale.value = cube.scale;
				mat.defines!.WATER_CUBE = '';
				mat.needsUpdate = true;
				this.onChange();
			});
		}
		mat.needsUpdate = true;
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
			// $localrefract: looked into, the texture seen through its
			// normal map at a depth below the surface (the slats of light covers)
			const local = info.localRefract && info.normalMap ? {normal: {value: null as THREE.Texture | null}, params: {value: new THREE.Vector2(0, info.localRefract)}} : null;
			if (local) {
				mat.userData.refractLocal = local;
				mat.defines.REFRACT_LOCAL = '';
			}
			mat.needsUpdate = true;
			Promise.all([this.textures.get(info.baseTexture), local ? this.textures.get(info.normalMap, true) : null]).then(([tex, normal]) => {
				if (!tex) return;
				mat.map = tex;
				if (local) {
					if (normal) {
						// (the engine's height / width of the texture, in whole numbers)
						const size = (tex.userData.fullSize as [number, number] | undefined) ?? [tex.image.width, tex.image.height];
						local.params.value.x = Math.floor(size[1] / size[0]);
						local.normal.value = normal;
					} else {
						delete mat.defines?.REFRACT_LOCAL;
					}
				}
				mat.needsUpdate = true;
				this.onChange();
			});
			return;
		}
		mat.transparent = true;
		mat.depthWrite = false;
		mat.side = THREE.DoubleSide;
		mat.userData.twoSided = true;
		// (models' own copies are made once there's a texture: wait for the tint's)
		mat.userData.textureless = !info.refractTintTexture;
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
		// a model's $envmap (broken glass): the reflection added on top, the
		// tint then a grey level (src + dst x alpha); the cube is per object
		if (info.envMap && mat.userData.ambientLit) {
			mat.blendSrc = THREE.OneFactor;
			mat.blendDst = THREE.SrcAlphaFactor;
			mat.defines.REFRACT_ENV = '';
			mat.userData.modelEnv = {
				tint: info.envTint, contrast: info.envContrast, saturation: info.envSaturation, lightScale: info.envLightScale,
				mask: 'none', maskMap: null, cube: info.envMap,
			};
		}
		mat.needsUpdate = true;
		// (the reflection masked by the normal map's alpha: loaded before the
		// tint goes on, as objects take their own copies then)
		const env = mat.userData.modelEnv as {mask: string; maskMap: THREE.Texture | null} | undefined;
		const mask = env && info.normalMap ? this.textures.get(info.normalMap, true) : Promise.resolve(null);
		if (info.refractTintTexture) {
			Promise.all([this.textures.get(info.refractTintTexture), mask]).then(([tex, maskMap]) => {
				if (env && maskMap) {
					env.mask = 'alpha';
					env.maskMap = maskMap;
				}
				if (!tex) {
					mat.userData.textureless = true;
					return;
				}
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

	// an overlay's material: the world material, drawn just in front of the
	// face it's laid on (and DecalModulate's stains multiplying what's there)
	// (`frame`: the frame of its texture an info_overlay_accessor picks)
	forOverlay(group: MaterialGroup, frame = 0): THREE.Material {
		const key = `overlay:${group.material}` + (frame ? `#${frame}` : '');
		const cached = this.world.get(key);
		if (cached) return cached;
		const mat = this.forWorld({...group, material: group.material}, key, frame) as THREE.MeshBasicMaterial;
		mat.polygonOffset = true;
		mat.polygonOffsetFactor = -1;
		mat.polygonOffsetUnits = -4;
		this.materials.get(group.material).then(info => {
			if (!info.found || info.shader !== 'decalmodulate') return;
			mat.transparent = true;
			mat.depthWrite = false;
			mat.lightMap = null;
			mat.blending = THREE.CustomBlending;
			mat.blendEquation = THREE.AddEquation;
			mat.blendSrc = THREE.DstColorFactor;
			mat.blendDst = THREE.SrcColorFactor;
			mat.defines = {...mat.defines, REFRACT_TINT: '', REFRACT_UNSCALED: ''};
			mat.needsUpdate = true;
			this.onChange();
		});
		return mat;
	}

	forWorld(group: MaterialGroup, cacheKey = group.material, frame = 0): THREE.Material {
		const cached = this.world.get(cacheKey);
		if (cached) return cached;
		const mat = new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.FrontSide});
		hookWorldMaterial(mat);
		if (group.surface === 'glass' || group.surface === 'liquid') {
			mat.transparent = true;
			mat.opacity = 0.35;
			mat.depthWrite = false;
		}
		this.world.set(cacheKey, mat);
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
			if (info.water) mat.userData.texSize = group.texSize;
			if (info.selfIllum && !info.unlit && info.shader === 'lightmappedgeneric') {
				(mat.userData.envUniforms.worldGlowTint.value as THREE.Vector3).set(...info.selfIllumTint);
				mat.defines = {...mat.defines, WORLD_SELFILLUM: ''};
			}
			// a displacement's second texture, blended in by its painted alpha
			if (info.baseTexture2) {
				const blend2 = {map2: {value: null as THREE.Texture | null}, modulate: {value: null as THREE.Texture | null}};
				mat.userData.blend2 = blend2;
				Promise.all([this.textures.get(info.baseTexture2), info.blendModulate ? this.textures.get(info.blendModulate, true) : null]).then(([tex, modulate]) => {
					if (!tex) return;
					blend2.map2.value = tex;
					blend2.modulate.value = modulate;
					mat.defines = {...mat.defines, BLEND2: ''};
					if (modulate) mat.defines.BLEND2_MODULATE = '';
					mat.needsUpdate = true;
					this.onChange();
				});
			}
			this.apply(mat, info, frame);
			this.applyBackFaces(mat);
			mat.needsUpdate = true;
			this.onChange();
			if (info.envMap && info.envMap !== 'env_cubemap' && !info.translucent && !info.water) this.applyEnv(mat, info);
			// detail modes drawn: mod2x, additive, self-illuminated (and its
			// threshold fade), two-pattern mod2x, multiply, ssbump detail
			if (info.detail && !info.unlit && [0, 1, 5, 6, 7, 8, 10].includes(info.detailBlendMode) && info.shader === 'lightmappedgeneric') {
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
	cube(path: string): Promise<{texture: THREE.CubeTexture; scale: number} | null> {
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

// a player's animation, tick by tick from their track's first (see playerMotion)
interface PlayerMotion {
	start: number;
	land: number;            // the landing gesture's sequence (-1: none)
	seq: Int16Array;
	phase: Float64Array;     // the sequence's cycle (unwrapped)
	moveX: Float32Array;
	moveY: Float32Array;
	landAt: Int32Array;      // the tick index of the latest landing (-1: none yet)
	feetYaw: Float32Array;
	bodyYaw: Float32Array;   // the body_yaw pose parameter
}

// a model's parsed data, kept from map to map (the materials are the map's)
type ModelData = Omit<ModelAsset, 'parts'> & {parts: Omit<ModelAsset['parts'][number], 'material'>[]};
// (maps a model can go unused for and stay loaded)
const KEEP_MODEL_MAPS = 2;
// the size of the patches of the map static props are merged in (each
// culled on its own)
const PROP_CHUNK = 1024;
interface ModelEntry {
	data: Promise<ModelData | null>;
	fromMap: boolean;          // from the map's own files
	lastUsed: number;          // map generation
	loaded?: ModelData | null; // once settled
}

export class View3D {
	readonly container: HTMLElement;
	mode: CameraMode = 'eyes';
	private renderer: THREE.WebGLRenderer | null = null;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(VERTICAL_FOV, 1, 1, 40000);
	private controls: OrbitControls | null = null;
	private library: MaterialLibrary | null = null;
	private textures: TextureCache | null = null;
	private mapGroup = new THREE.Group();
	private entityGroup = new THREE.Group();
	private pathLine: THREE.LineSegments | null = null;
	private pathShown = true;
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
	private modelData = new Map<string, ModelEntry>();
	private modelGeneration = 0;
	private interval = 1 / 60;
	// the recording player's track, and the view model bob clock (seconds of
	// full-speed movement) at each recorded view
	private track: SegmentTrack | null = null;
	private bobClock: {time: Float64Array, speed: Float32Array} | null = null;
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
	// bumped when a style changes, for models to be re-lit
	private styleGen = 0;
	private ambientLight: {tick: number; rgb: [number, number, number]}[] = [];
	// mat_ambient_light set before playback (the Bright toggle: autorender
	// sets 0.05 for maps it brightens); the recording's own commands win
	extraAmbient = 0;
	private styleNow = (style: number) => this.styleValues.get(style) ?? 1;
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
	// the world's glass (what stops turrets' lasers besides the solid faces)
	private glassCollision: MeshBVH | null = null;
	// and its liquids' surfaces (soft particles fade into water too)
	private liquidCollision: MeshBVH | null = null;
	// particle effects: info_particle_system entities, each active run an instance
	private particleLib: ParticleLibrary | null = null;
	private particleRenderer: ParticleRenderer | null = null;
	// effect runs as they stand, each with saved states along the way (every
	// half second, the last six seconds) to pick up from when seeking back,
	// instead of simulating from the start
	private particleRuns = new Map<string, {start: number; inst: ParticleInstance; saved: InstanceState[]}>();
	private particlesShown: ParticleInstance[] = [];
	// portal edge effects, by portal (not drawn in the view through it)
	private edgeParticles = new Map<ParticleInstance, number>();
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
		this.precompileTimer?.();
		this.precompileTimer = later(() => {
			if (this.freezeStatics()) {
				this.mergeProps();
				this.mergeFrozenKids();
			}
			this.precompile();
		}, 400);
	}
	private precompileTimer: (() => void) | undefined;

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
			const library = this.library;
			const data = this.modelDataFor(key, name, skin, body);
			p = data && library
				? data.then(d => d && {...d, parts: d.parts.map(part => ({...part, material: library.forModel(part.group.materialCandidates)}))})
				: Promise.resolve(null);
			this.models.set(key, p);
		}
		return p;
	}

	// the parsed model (loaded once, kept across maps unless the map's own
	// files supplied it)
	private modelDataFor(key: string, name: string, skin: number, body: number): Promise<ModelData | null> | null {
		const files = this.files;
		if (!files) return null;
		let entry = this.modelData.get(key);
		if (!entry) {
			const color: [number, number, number] = /cube|box/.test(key) ? [0.66, 0.73, 0.8] : [0.52, 0.52, 0.5];
			const data = loadModel(files, name, color, skin, body).then(async (m: StudioModel | null): Promise<ModelData | null> => {
				if (!m) return null;
				const skeleton = await loadSkeleton(files, m.bytes).catch(() => null);
				const rest = skeleton ? referencePose(skeleton) : null;
				const mats = skeleton && rest ? (samplePose(skeleton, 0, 0, rest), skinMatrices(skeleton, rest)) : null;
				const parts = m.groups.map(g => {
					const raw = geometry(g);
					const posed = mats ? bakePose(g, mats) : null;
					const baked = posed ? geometry({...g, positions: posed.positions, normals: posed.normals}) : raw;
					raw.userData.shared = baked.userData.shared = true;  // (the model cache's: not freed with objects)
					return {group: g, raw, baked, name: `${name} ${g.materialCandidates[0]}`};
				});
				return {name, model: m, skeleton, parts};
			}).catch(() => null);
			const e: ModelEntry = {data, fromMap: !!files.mapPak?.has(name.toLowerCase()), lastUsed: this.modelGeneration};
			data.then(d => (e.loaded = d));
			entry = e;
			this.modelData.set(key, entry);
		}
		entry.lastUsed = this.modelGeneration;
		return entry.data;
	}

	// a new map: drop the models the last map's files supplied, those that
	// didn't load (its files may have them) and those gone unused
	private evictModels(all = false) {
		this.modelGeneration++;
		for (const [key, e] of this.modelData) {
			if (e.loaded === undefined && !all) continue;  // (still loading)
			if (!all && e.loaded && !e.fromMap && this.modelGeneration - e.lastUsed <= KEEP_MODEL_MAPS) continue;
			const free = (d: ModelData | null) => d?.parts.forEach(part => {
				part.raw.dispose();
				if (part.baked !== part.raw) part.baked.dispose();
			});
			if (e.loaded !== undefined) free(e.loaded);
			else e.data.then(free);
			this.modelData.delete(key);
		}
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

	// a brush entity's textures at a frame (its m_iTextureFrameIndex: the
	// ToggleTexture proxy's, for signs that change)
	private brushFrame(o: THREE.Object3D, frame: number) {
		if ((o.userData.textureFrame ?? 0) === frame || !this.library) return;
		o.userData.textureFrame = frame;
		for (const c of o.children) {
			const g = c.userData.brushGroup as MaterialGroup | undefined;
			if (g) (c as THREE.Mesh).material = frame ? this.library.forWorld(g, `${g.material}#${frame}`, frame) : this.library.forWorld(g);
		}
	}

	private brushModel(m: ModelMesh): THREE.Group {
		const group = new THREE.Group();
		for (const g of m.groups) {
			const mesh = new THREE.Mesh(geometry(g), this.library!.forWorld(g));
			mesh.name = `brush ${g.material}`;
			mesh.userData.brushGroup = g;
			if (g.surface === 'glass' || g.surface === 'liquid') mesh.renderOrder = 1;
			group.add(mesh);
		}
		return group;
	}

	setMap(bsp: BspMap | null, files: GameFiles | null = null, materials: Materials | null = null) {
		this.meterSnap = true;
		this.bsp = bsp;
		this.files = files;
		this.clearEntities();
		// the last map's GPU resources: its geometry (the world's and the
		// props', each their own), materials, textures, light maps, portal views
		for (const g of [this.mapGroup, this.propGroup, this.sky]) {
			g.traverse(o => {
				const mesh = o as THREE.Mesh;
				if (!mesh.isMesh) return;
				mesh.geometry.dispose();
				// (the sky's materials and texture copies are its own)
				if (g === this.sky && !Array.isArray(mesh.material)) {
					(mesh.material as THREE.MeshBasicMaterial).map?.dispose();
					mesh.material.dispose();
				}
			});
			g.clear();
		}
		this.effects?.dispose();
		this.paint?.texture.dispose();
		this.models.clear();
		this.evictModels(!bsp);
		this.readyModels.clear();
		this.windowed = [];
		this.visCulled = [];
		this.visHidden.length = 0;
		this.library?.dispose();
		this.lightTex?.dispose();
		for (const t of this.bumpTex) t.dispose();
		for (const rt of this.portalTargets.values()) rt.dispose();
		this.portalTargets.clear();
		for (const rt of this.waterTargets.values()) rt.dispose();
		for (const rt of this.refractTargets.values()) {
			rt.depthTexture?.dispose();
			rt.dispose();
		}
		this.refractTargets.clear();
		this.waterTargets.clear();
		this.waterMeshes = [];
		this.accessedOverlays.clear();
		this.particleRenderer?.dispose();
		this.vmParticleRenderer?.dispose();
		const token = ++this.mapToken;
		if (!bsp || !files || !materials) {
			// (no map: nothing to carry over)
			this.textures?.dispose();
			this.textures = null;
			return;
		}

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
		this.styleGen++;
		this.tracksByIndex.clear();
		// (textures carry over from the last map, unless the game folder changed)
		if (this.textures?.files !== files) {
			this.textures?.dispose();
			this.textures = new TextureCache(files);
		} else this.textures.newMap();
		this.library = new MaterialLibrary(this.textures, materials, lightTex);
		this.library.cameraTexture = this.cameraTarget.texture;
		this.library.setBackFaces(this.mode !== 'eyes');
		this.library.onChange = () => this.loaded();
		this.effects = new EffectAssets(materials, this.library.textures);
		if (this.particleRenderer) {
			this.particleRenderer.clear();
			this.scene.remove(this.particleRenderer.group);
		}
		this.particleLib = new ParticleLibrary(files, bsp.name);
		this.pointLight.clear();
		this.particleLib.lightAt = point => this.lightForPoint(point);
		this.particleRenderer = new ParticleRenderer(files, materials, this.library.textures);
		this.particleRenderer.visibility = (point, eye, radius) => this.pointSeen(point, eye, radius);
		this.particleRenderer.surface = (from, dir, far) => {
			const ray = new THREE.Ray(from, dir);
			let near = Infinity;
			for (const tree of [this.collision, this.liquidCollision]) {
				const hit = tree?.raycastFirst(ray, THREE.DoubleSide);
				if (hit && hit.distance < near) near = hit.distance;
			}
			return near <= far ? near : Infinity;
		};
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

		const world = this.brushModel(bsp.models[0]);
		this.mapGroup.add(world);
		// the water surfaces: their height (what their reflection's drawn
		// about) and where they are, for the visibility sets
		this.waterMeshes = [];
		bsp.models[0].groups.forEach((g, i) => {
			if (g.surface !== 'liquid') return;
			const mesh = world.children[i] as THREE.Mesh;
			mesh.geometry.computeBoundingBox();
			const box = mesh.geometry.boundingBox!;
			mesh.userData.waterHeight = box.max.z;
			mesh.userData.clusters = bsp.vis?.clustersInBox(box.min.toArray(), box.max.toArray()) ?? [];
			this.waterMeshes.push(mesh);
		});
		// info_overlays (signs, indicator lights, stains) on the world's faces
		const overlays = new THREE.Group();
		overlays.name = 'overlays';
		for (const g of bsp.overlays) {
			const mesh = new THREE.Mesh(geometry(g), this.library!.forOverlay(g));
			mesh.name = `overlay ${g.material}`;
			mesh.renderOrder = 1;
			if (g.overlayId !== undefined) this.accessedOverlays.set(g.overlayId, {mesh, group: g});
			overlays.add(mesh);
		}
		this.mapGroup.add(overlays);
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
		this.glassCollision = worldCollision(bsp.models[0], 'glass');
		this.liquidCollision = worldCollision(bsp.models[0], 'liquid');
		this.paintBlobs?.dispose();
		if (this.paintBlobs) this.scene.remove(this.paintBlobs.group);
		for (const pb of this.particleBlobs.values()) {
			pb.dispose();
			this.scene.remove(pb.group);
		}
		this.particleBlobs.clear();
		const collision = this.collision;
		this.paintBlobs = new PaintBlobs((from, to) => {
			const d = to.clone().sub(from);
			const len = d.length();
			if (len < 1e-3) return Infinity;
			const hit = collision?.raycastFirst(new THREE.Ray(from, d.divideScalar(len)), THREE.DoubleSide);
			return hit && hit.distance <= len ? hit.distance : Infinity;
		});
		this.scene.add(this.paintBlobs.group);
		this.ropes?.dispose();
		if (this.ropes) this.scene.remove(this.ropes.group);
		this.ropes = this.effects ? new Ropes(this.effects) : null;
		if (this.ropes) this.scene.add(this.ropes.group);
		this.sprites?.dispose();
		if (this.sprites) this.scene.remove(this.sprites.group);
		this.sprites = this.effects ? new Sprites(this.effects) : null;
		if (this.sprites) this.scene.add(this.sprites.group);
		this.movies?.dispose();
		if (this.movies) this.scene.remove(this.movies.group);
		this.movies = files ? new MovieScreens(files, async name => {
			const info = materials ? await materials.get(name) : null;
			return info?.found && info.baseTexture && this.library ? this.library.textures.get(info.baseTexture) : null;
		}) : null;
		if (this.movies) {
			this.movies.onChange = () => this.loaded();
			this.scene.add(this.movies.group);
		}
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
				const world = new THREE.Matrix4().compose(new THREE.Vector3(...prop.origin), new THREE.Quaternion().setFromEuler(toEuler(prop.angles)), new THREE.Vector3(1, 1, 1));
				const o = this.litProp(asset, vhv, world) ?? this.staticObject(asset);
				o.position.set(...prop.origin);
				o.rotation.copy(toEuler(prop.angles));
				o.updateMatrixWorld(true);
				o.matrixAutoUpdate = false;
				for (const c of o.children) c.matrixAutoUpdate = false;
				// (the clusters it's in, for culling by what can be seen)
				if (bsp.vis) o.userData.clusters = [...new Set(prop.leaves.map(l => bsp.vis!.leafCluster(l)).filter(c => c >= 0))];
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

	// whether a world light reaches a point (nothing solid in between), for
	// model lighting
	private lightReaches = (from: number[], to: [number, number, number]): boolean => {
		if (!this.collision) return true;
		const d = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
		const len = d.length();
		if (len < 2) return true;
		const ray = new THREE.Ray(new THREE.Vector3(from[0], from[1], from[2]), d.divideScalar(len));
		const hit = this.collision.raycastFirst(ray, THREE.DoubleSide);
		return !hit || hit.distance > len - 2;
	};

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
					&& same(k.origin, k0.origin) && same(k.angles, k0.angles) && (k.skin ?? 0) === (k0.skin ?? 0) && k.model === k0.model
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
			const light = amb.at([centre.x, centre.y, centre.z], this.lightReaches, this.styleNow);
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
				const vis = this.bsp?.vis;
				if (vis) {
					g.computeBoundingBox();
					mesh.userData.clusters = vis.clustersInBox(g.boundingBox!.min.toArray(), g.boundingBox!.max.toArray());
				}
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
		// each prop: the clusters it's in (on its top-level object)
		const propOf = (o: THREE.Object3D) => {
			while (o.parent && o.parent !== this.propGroup) o = o.parent;
			return o;
		};
		this.propGroup.traverse(c => {
			const mesh = c as THREE.Mesh;
			// (not what an earlier pass already merged)
			if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.material.userData?.vertexLit || mesh.userData.merged) return;
			const g = mesh.geometry;
			const key = mesh.material;
			// (merged only with parts of the same layout, shown over the same
			// ticks, and near each other: a patch of the map can be culled
			// when it's out of view or can't be seen from the camera)
			g.boundingSphere ?? g.computeBoundingSphere();
			mesh.updateWorldMatrix(true, false);
			const at = g.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld);
			const cell = [at.x, at.y, at.z].map(v => Math.floor(v / PROP_CHUNK)).join(',');
			const sig = Object.keys(g.attributes).sort().join(',') + (g.index ? '+i' : '') + '@' + String(mesh.userData.window ?? '') + '#' + cell;
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
				mesh.userData.merged = true;
				const clusters = list.map(m => propOf(m).userData.clusters as number[] | undefined);
				if (clusters.every(c => c)) mesh.userData.clusters = [...new Set(clusters.flat())];
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
		this.visCulled = this.propGroup.children.filter(o => o.userData.clusters);
	}

	// Culling by the map's visibility sets, as the engine draws: for one
	// view, what can't be seen from where it looks from is hidden (put back
	// with uncull, before the next view or anything else looks at the scene)
	private visCulled: THREE.Object3D[] = [];
	private visHidden: THREE.Object3D[] = [];
	private cullFrom(at: THREE.Vector3) {
		this.uncull();
		const vis = this.bsp?.vis;
		const set = vis?.visibleFrom(vis.clusterAt([at.x, at.y, at.z]));
		// (no set from outside the map or inside a wall: everything shows)
		if (!set) return;
		for (const o of this.visCulled) {
			if (o.visible && !anyVisible(set, o.userData.clusters as number[])) {
				o.visible = false;
				this.visHidden.push(o);
			}
		}
		// entities' models too (not effects: their geometry is rewritten as
		// they go, so its bounds aren't to be trusted)
		for (const [t, o] of this.objects) {
			if (!o.visible || WORLD_SPACE.has(t.className) || !(t.model.endsWith('.mdl') || t.model.startsWith('*'))) continue;
			const clusters = this.entityClusters(o);
			if (clusters && !anyVisible(set, clusters)) {
				o.visible = false;
				this.visHidden.push(o);
			}
		}
	}

	// the clusters an entity's model is in (again once it moves or its pose
	// reaches elsewhere; worked out once a frame; null while it has nothing)
	private entityClusters(o: THREE.Object3D): number[] | null {
		if (o.userData.clustersFrame === this.frameNumber) return o.userData.clusters as number[] | null;
		o.userData.clustersFrame = this.frameNumber;
		o.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(o);
		if (box.isEmpty()) return o.userData.clusters = null;
		const key = [...box.min.toArray(), ...box.max.toArray()].map(v => Math.round(v / 4)).join(',');
		if (o.userData.clustersKey !== key) {
			o.userData.clusters = this.bsp!.vis!.clustersInBox(box.min.toArray(), box.max.toArray());
			o.userData.clustersKey = key;
		}
		return o.userData.clusters as number[];
	}
	private uncull() {
		for (const o of this.visHidden) o.visible = true;
		this.visHidden.length = 0;
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
	private litProp(asset: ModelAsset, vhv: Uint8Array | null, world: THREE.Matrix4): THREE.Object3D | null {
		const light = vhv ? readVhv(vhv) : null;
		if (!light || light.checksum !== asset.model.checksum || !this.library) return null;
		// the switchable lights that reach it (left out of the .vhv), at its
		// middle, lighting each vertex by its normal
		const box = new THREE.Box3();
		for (const part of asset.parts) {
			part.raw.computeBoundingBox();
			if (part.raw.boundingBox) box.union(part.raw.boundingBox);
		}
		const centre = (box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())).applyMatrix4(world);
		const switchable = this.bsp?.ambient?.switchableAt([centre.x, centre.y, centre.z], this.lightReaches, this.styleNow) ?? [];
		const normalMat = new THREE.Matrix3().getNormalMatrix(world);
		const wp = new THREE.Vector3(), wn = new THREE.Vector3(), l = new THREE.Vector3();
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
			if (switchable.length) {
				const pos = part.baked.getAttribute('position'), nrm = part.baked.getAttribute('normal');
				for (let i = 0; i < mv.length && nrm; i++) {
					wp.fromBufferAttribute(pos, i).applyMatrix4(world);
					wn.fromBufferAttribute(nrm, i).applyMatrix3(normalMat).normalize();
					for (const s of switchable) {
						const ndl = wn.dot(l.set(s.pos[0] - wp.x, s.pos[1] - wp.y, s.pos[2] - wp.z).normalize());
						if (ndl <= 0) continue;
						colors[i * 3] += s.color[0] * ndl;
						colors[i * 3 + 1] += s.color[1] * ndl;
						colors[i * 3 + 2] += s.color[2] * ndl;
					}
				}
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

	// the run's path drawn through the map (on by default)
	setPathShown(on: boolean) {
		this.pathShown = on;
		if (this.pathLine) this.pathLine.visible = on;
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
		this.track = track;
		// mat_ambient_light_r/g/b as console commands in the recording set it
		// (playback runs those; the player's own setting, which SAR's cvar
		// list records, isn't applied when the demo is played back)
		this.ambientLight = [];
		const rgb: [number, number, number] = [0, 0, 0];
		for (const c of track.seg.consoleCmds) {
			const m = /^\s*mat_ambient_light_([rgb])\s+"?([-\d.]+)/.exec(c.text);
			if (!m) continue;
			rgb['rgb'.indexOf(m[1])] = Number(m[2]) || 0;
			this.ambientLight.push({tick: c.tick, rgb: [...rgb]});
		}
		this.bobClock = null;
		this.paint?.texture.dispose();
		this.paint = this.bsp && entities?.paint.length ? new PaintLayer(this.bsp, entities.paint) : null;
		paintUniforms.paintMap.value = this.paint?.texture ?? null;
		paintUniforms.paintOn.value = this.paint ? 1 : 0;
		if (this.paint && this.bsp?.lightmap) {
			paintUniforms.paintTiles.value.set(this.bsp.lightmap.width / 12.8, this.bsp.lightmap.height / 12.8);
			this.library?.textures.get('paint/splatnormal_default', true).then(tex => {
				if (!tex) return;
				tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
				tex.needsUpdate = true;
				paintUniforms.paintSplat.value = tex;
				this.loaded();
			});
		}
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
		this.pathLine.visible = this.pathShown;
		this.scene.add(this.pathLine);
		this.lastTarget = null;
	}

	private clearEntities() {
		this.particleRuns.clear();
		this.particlesShown = [];
		disposeOwn(this.entityGroup);
		this.turretLasers.clear();
		this.paintBlobs?.clear();
		this.ropes?.clear();
		this.windowedKids = [];
		this.entityGroup.clear();
		this.frozen.clear();
		this.frozenCandidates = null;
		this.objects.clear();
		for (const g of this.vmObjects.values()) {
			this.vmScene.remove(g);
			disposeOwn(g);
		}
		this.vmObjects.clear();
		this.vmShown = null;
	}

	private objectFor(t: EntityTrack, skin = 0, body = 0, model = t.model): THREE.Object3D | null {
		let o = this.objects.get(t);
		if (o !== undefined) {
			if (((o.userData.skin ?? 0) === skin && (o.userData.body ?? 0) === body && (o.userData.model ?? t.model) === model) || !t.model.endsWith('.mdl')) return o;
			// a new skin (a cube lighting up on a button) or body groups
			// (PotatOS on the gun): rebuild
			this.entityGroup.remove(o);
			disposeOwn(o);
			this.objects.delete(t);
		}
		o = this.makeObject(t, skin, body, model) ?? new THREE.Group();
		o.userData.skin = skin;
		o.userData.body = body;
		o.userData.model = model;
		o.visible = false;
		this.objects.set(t, o);
		this.entityGroup.add(o);
		return o;
	}

	private makeObject(t: EntityTrack, skin = 0, body = 0, model = t.model): THREE.Object3D | null {
		if (t.className === 'CPortal_Player') {
			// the player's own model (Chell, ATLAS, P-body); a capsule until it loads
			const group = new THREE.Group();
			const shape = new THREE.CapsuleGeometry(16, 40, 4, 12);
			shape.rotateX(Math.PI / 2);
			shape.translate(0, 0, 36);
			const capsule = new THREE.Mesh(shape, new THREE.MeshLambertMaterial({color: /eggbot/.test(t.model) ? 0xff8a1f : 0x5aa9ff}));
			group.add(capsule);
			this.model(t.model || 'models/player/chell/player.mdl', skin, body).then(asset => {
				if (!asset?.skeleton) return;
				group.remove(capsule);
				shape.dispose();
				(capsule.material as THREE.Material).dispose();
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
			const cube = /cube|box/i.test(model);
			box = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), new THREE.MeshLambertMaterial({color: cube ? 0x9fb7cf : 0x8a7f6e, transparent: !cube, opacity: cube ? 1 : 0.55}));
			box.position.set((t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, (t.mins[2] + t.maxs[2]) / 2);
			group.add(box);
		}
		// the real model when it loads, animated when it can be
		this.model(model, skin, body).then(asset => {
			if (box) {
				group.remove(box);
				box.geometry.dispose();
				(box.material as THREE.Material).dispose();
			}
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
		// (deleted: lasers, bridges, funnels and fizzlers too)
		if (k.removed) return false;
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

	// When each funnel's column last started growing (C_Trigger_TractorBeam's
	// m_vStart / m_vEnd proxies), by key: a new start, or an end in a new
	// direction (by over 0.1 a component), starts it again; an end further
	// along the same line keeps the drawn length (the time so far scaled by
	// old / new length). The column then reaches its end over 0.5 s.
	private funnelStarts = new WeakMap<EntityTrack, number[]>();
	private funnelGrowth(t: EntityTrack, tick: number): number {
		let starts = this.funnelStarts.get(t);
		if (!starts) {
			starts = [];
			let s0: THREE.Vector3 | null = null, e0: THREE.Vector3 | null = null, at = -Infinity;
			for (const k of t.keys) {
				const now = k.tick * this.interval;
				const s = vec3(k.extra?.m_vStart), e = vec3(k.extra?.m_vEnd);
				if (s && (!s0 || !s.equals(s0))) {
					at = now;
					s0 = s.clone();
				}
				if (e && s0 && (!e0 || !e.equals(e0))) {
					if (e0) {
						const oldDir = e0.clone().sub(s0), newDir = e.clone().sub(s0);
						const oldLen = oldDir.length(), newLen = newDir.length();
						oldDir.divideScalar(oldLen + 1.192e-7);
						newDir.divideScalar(newLen + 1.192e-7);
						if (Math.abs(oldDir.x - newDir.x) > 0.1 || Math.abs(oldDir.y - newDir.y) > 0.1 || Math.abs(oldDir.z - newDir.z) > 0.1) at = now;
						else if (newLen > 0) at = now - oldLen * (now - at) / newLen;
					} else at = now;
					e0 = e.clone();
				}
				starts.push(at);
			}
			this.funnelStarts.set(t, starts);
		}
		const i = keyIndexAt(t, Math.floor(tick));
		if (i < 0) return 1;
		const f = Math.min(1, Math.max(0, (tick * this.interval - starts[i]) / 0.5));
		return f * f * (3 - 2 * f);
	}

	private placeEffect(t: EntityTrack, k: EntityKey, o: THREE.Object3D, time: number, tick: number) {
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
			const start = vec3(e.m_vStart)!, grown = this.funnelGrowth(t, tick);
			const end = start.clone().lerp(vec3(e.m_vEnd)!, Math.max(grown, 0.001));
			(o.userData.funnel as Funnel).set(start, end, Number(e.m_flRadius) || 55, Number(e.m_bReversed) === 1, time, Number(e.m_bFromPortal) === 1, Number(e.m_bToPortal) === 1 && grown >= 1);
		}
	}

	// Sprites (env_sprite): where each is (on its attachment, if it has one)
	// and how it's drawn, for Sprites; a glow's proxy tested against what's
	// in the way
	private sprites: Sprites | null = null;
	private updateSprites(tick: number) {
		const ents = this.entities;
		if (!this.sprites || !ents) return;
		const eye = this.camera.position;
		// (the world's fog at a point, as its shader mixes it in)
		const fog = this.fog;
		const fogAt = (p: THREE.Vector3) => {
			if (!fog) return 0;
			const f = Math.min(fog.maxDensity, Math.min(1, Math.max(0, (p.distanceTo(eye) - fog.start) / Math.max(fog.end - fog.start, 1))));
			return f * f;
		};
		const list: SpriteSpec[] = [];
		for (const t of ents.tracks) {
			if (t.className !== 'CSprite' || !t.model.endsWith('.vmt')) continue;
			const k = keyAt(t, tick);
			if (!k || k.removed || k.nodraw || !k.visible) continue;
			const e = k.extra ?? {};
			const on = Number(e.m_hAttachedToEntity ?? -1), att = Number(e.m_nAttachment ?? 0);
			let origin = this.entityPose(t, tick).origin.clone();
			if (on >= 0 && (on & 2047) !== 2047 && att > 0) {
				const m = this.attachmentAt(on & 2047, att, tick, false);
				if (m) origin = new THREE.Vector3().setFromMatrixPosition(m);
			}
			const c = Number(e.m_clrRender ?? 0xffffffff) >>> 0;
			const mode = Number(e.m_nRenderMode ?? 0);
			list.push({
				material: t.model.replace(/\.vmt$/i, ''), origin, scale: Number(e.m_flSpriteScale ?? 1), mode,
				color: [(c & 255) / 255, ((c >>> 8) & 255) / 255, ((c >>> 16) & 255) / 255],
				alpha: Number(e.m_nBrightness ?? 255) / 255, hdrScale: Number(e.m_flHDRColorScale ?? 1) || 1,
				seen: mode === 3 || mode === 9 ? this.pointSeen(origin, eye, Number(e.m_flGlowProxySize ?? 2) || 2) : 1,
				fog: fogAt(origin),
			});
		}
		this.sprites.update(list, this.camera);
	}

	// Monitor screens (func_monitor, _rt_Camera): the scene as the active
	// point_camera sees it, drawn into a texture when a screen is in view
	// (unexposed, as the frame is, so the screen takes the view's exposure)
	private cameraTarget = new THREE.WebGLRenderTarget(512, 512, {type: THREE.HalfFloatType});
	private monitorCam = new THREE.PerspectiveCamera(90, 1, 4, 40000);
	private renderMonitorCamera(r: THREE.WebGLRenderer) {
		const ents = this.entities;
		if (!ents) return;
		const tick = this.meterTick;
		const screens: THREE.Mesh[] = [];
		const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
		this.entityGroup.traverseVisible(o => {
			const mesh = o as THREE.Mesh;
			if (mesh.isMesh && (mesh.material as THREE.Material)?.userData?.cameraScreen) screens.push(mesh);
		});
		// (only for a screen in view that can be seen from the camera)
		const vis = this.bsp?.vis;
		const set = vis?.visibleFrom(vis.clusterAt(this.camera.position.toArray()));
		const seen = (m: THREE.Mesh) => {
			if (!frustum.intersectsObject(m)) return false;
			if (!vis || !set) return true;
			// (the clusters it's in, again once it has moved)
			m.updateWorldMatrix(true, false);
			const at = m.matrixWorld.elements.slice(12, 15).map(v => Math.round(v)).join(',');
			if (m.userData.clustersAt !== at) {
				const box = new THREE.Box3().setFromObject(m);
				m.userData.clusters = vis.clustersInBox(box.min.toArray(), box.max.toArray());
				m.userData.clustersAt = at;
			}
			return anyVisible(set, m.userData.clusters as number[]);
		};
		if (!screens.some(seen)) return;
		const cam = ents.tracks.find(t => t.className === 'CPointCamera' && Number(keyAt(t, tick)?.extra?.m_bActive) === 1);
		const k = cam && keyAt(cam, tick);
		if (!cam || !k) return;
		const pose = this.entityPose(cam, tick);
		const mc = this.monitorCam;
		// (m_FOV across, at the screen texture's square aspect: the same up and down)
		mc.fov = Number(k.extra?.m_FOV) || 90;
		mc.position.copy(pose.origin);
		// (Source's x forward, y left, z up as a camera looking down -z)
		const basis = new THREE.Matrix4().makeRotationFromEuler(toEuler(pose.angles));
		const fwd = new THREE.Vector3(), left = new THREE.Vector3(), up = new THREE.Vector3();
		basis.extractBasis(fwd, left, up);
		mc.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(left.negate(), up, fwd.negate()));
		mc.updateProjectionMatrix();
		mc.updateMatrixWorld();
		for (const m of screens) m.visible = false;
		// (its own fog: none unless it turns it on, not the player's)
		const fog = this.scene.fog, density = fogUniforms.fogMaxDensity.value;
		if (Number(k.extra?.m_bFogEnable) !== 1) {
			this.scene.fog = null;
			fogUniforms.fogMaxDensity.value = 0;
		}
		const target = r.getRenderTarget();
		r.setRenderTarget(this.cameraTarget);
		this.cullFrom(mc.position);
		r.render(this.scene, mc);
		this.uncull();
		r.setRenderTarget(target);
		this.scene.fog = fog;
		fogUniforms.fogMaxDensity.value = density;
		for (const m of screens) m.visible = true;
	}

	// The world's light at a point as the engine's GetLightForPoint gives it:
	// the lighting cube there with its local lights added by direction,
	// averaged over the six sides, at most 1 (kept by place, as effects are
	// simulated again and again)
	private pointLight = new Map<string, [number, number, number]>();
	private lightForPoint(point: THREE.Vector3): [number, number, number] {
		const amb = this.bsp?.ambient;
		if (!amb) return [1, 1, 1];
		const key = `${Math.round(point.x / 4)},${Math.round(point.y / 4)},${Math.round(point.z / 4)},${this.styleGen},${modelAmbientUniforms.modelAmbient.value.x}`;
		const known = this.pointLight.get(key);
		if (known) return known;
		if (this.pointLight.size > 4096) this.pointLight.clear();
		const {cube, lights} = amb.at([point.x, point.y, point.z], this.lightReaches, this.styleNow);
		const box = cube.slice();
		for (const l of lights) {
			const d = new THREE.Vector3(l.pos[0], l.pos[1], l.pos[2]).sub(point).normalize();
			for (let axis = 0; axis < 3; axis++) {
				const c = d.getComponent(axis), side = axis * 2 + (c >= 0 ? 0 : 1);
				for (let ch = 0; ch < 3; ch++) box[side * 3 + ch] += l.color[ch] * Math.abs(c);
			}
		}
		const out = modelAmbientUniforms.modelAmbient.value.toArray() as [number, number, number];
		for (let side = 0; side < 6; side++) for (let ch = 0; ch < 3; ch++) out[ch] += box[side * 3 + ch] / 6;
		const light: [number, number, number] = [Math.min(out[0], 1), Math.min(out[1], 1), Math.min(out[2], 1)];
		this.pointLight.set(key, light);
		return light;
	}

	// Whether a point shows from the eye (for particles' visibility proxies):
	// nothing of the world, props or entities' models in between
	private seenRay = new THREE.Raycaster();
	// (asked again within a frame for the same point: particles are drawn
	// again for each portal view)
	private seenCache = new Map<string, number>();
	// How much of a glow's proxy the eye sees, as the engine's pixel
	// visibility queries measure it: a disc `radius` across at the point,
	// facing the eye, the fraction of it nothing's in front of (sampled: its
	// centre and a ring)
	private pointSeen(point: THREE.Vector3, eye: THREE.Vector3, radius: number): number {
		const key = `${point.x.toFixed(1)},${point.y.toFixed(1)},${point.z.toFixed(1)}|${eye.x.toFixed(1)},${eye.y.toFixed(1)},${eye.z.toFixed(1)}|${radius}`;
		let seen = this.seenCache.get(key);
		if (seen === undefined) {
			seen = this.discSeen(point, eye, radius);
			this.seenCache.set(key, seen);
		}
		return seen;
	}
	private discSeen(point: THREE.Vector3, eye: THREE.Vector3, radius: number): number {
		const d = point.distanceTo(eye);
		if (d < 2) return 1;
		const dir = point.clone().sub(eye).divideScalar(d);
		const side = new THREE.Vector3(0, 0, 1).cross(dir);
		if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
		side.normalize();
		const up = dir.clone().cross(side);
		const RING = 8;
		let seen = 0;
		for (let i = 0; i <= RING; i++) {
			const a = i / RING * Math.PI * 2;
			const r = i === 0 ? 0 : radius * 0.7;
			const p = point.clone().addScaledVector(side, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r);
			if (this.pointSeenNow(p, eye)) seen++;
		}
		return seen / (RING + 1);
	}
	private pointSeenNow(point: THREE.Vector3, eye: THREE.Vector3): boolean {
		const d = point.distanceTo(eye);
		if (d < 1) return true;
		const dir = point.clone().sub(eye).divideScalar(d);
		const ray = this.seenRay;
		ray.set(eye, dir);
		ray.near = 0;
		ray.far = d - 0.1;
		const world = this.collision?.raycastFirst(ray.ray, THREE.DoubleSide);
		if (world && world.distance < ray.far) return false;
		// (only what's drawn: shown entities, and their shown parts)
		const shown = (o: THREE.Object3D) => {
			for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
			return true;
		};
		const candidates = [this.propGroup, ...this.entityGroup.children.filter(o => o.visible)];
		return !ray.intersectObjects(candidates, true).some(h => shown(h.object));
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
	// gel sprayers' blobs (see PaintBlobs): each sprayer's settings and where
	// it sprays from, its spraying periods from when m_bActive was on
	private paintBlobs: PaintBlobs | null = null;
	private sprayPeriods = new WeakMap<EntityTrack, [number, number][]>();
	private updatePaintBlobs(tick: number) {
		if (!this.paintBlobs) return;
		const sprayers: Sprayer[] = [];
		const amb = this.bsp?.ambient;
		for (const t of this.entities!.tracks) {
			if (t.className !== 'CPaintSprayer') continue;
			let periods = this.sprayPeriods.get(t);
			if (!periods) {
				periods = [];
				let on: number | null = null;
				for (const k of t.keys) {
					const active = Number(k.extra?.m_bActive) === 1 && !k.removed;
					if (active && on === null) on = k.tick;
					if (!active && on !== null) {
						periods.push([on * this.interval, k.tick * this.interval]);
						on = null;
					}
				}
				if (on !== null) periods.push([on * this.interval, Infinity]);
				this.sprayPeriods.set(t, periods);
			}
			if (!periods.length) continue;
			const k = keyAt(t, tick);
			if (!k) continue;
			const m = this.worldMatrix(t, k, tick, 0);
			if (!m) continue;
			const e = k.extra ?? {};
			const origin = new THREE.Vector3().setFromMatrixPosition(m);
			const power = Number(e.m_PaintPowerType ?? 3);
			const c = PAINT_COLORS[power] ?? PAINT_COLORS[3];
			// (lit by the light where it sprays: the ambient cube's average, as
			// models are)
			const cube = amb?.at([origin.x, origin.y, origin.z]).cube;
			const light = cube ? cube.reduce((a, b) => a + b, 0) / 18 * AMBIENT_SCALE : 0.3;
			sprayers.push({
				key: `${t.index}:${t.keys[0].tick}`, origin, dir: new THREE.Vector3().setFromMatrixColumn(m, 0).normalize(), periods,
				rate: Number(e.m_flBlobsPerSecond ?? 0), minSpeed: Number(e.m_flMinSpeed ?? 100), maxSpeed: Number(e.m_flMaxSpeed ?? 100),
				spreadRadius: Number(e.m_flBlobSpreadRadius ?? 0), spreadAngle: Number(e.m_flBlobSpreadAngle ?? 0), seed: Number(e.m_nBlobRandomSeed ?? t.index),
				color: c.map(v => Math.pow(v / 255, 2.2)) as [number, number, number], light,
			});
		}
		this.paintBlobs.update(sprayers, tick * this.interval);
	}

	// Bink movie screens: each vgui screen on a movie display that's on, its
	// movie (or its group master's) from when that started playing
	private movies: MovieScreens | null = null;
	private movieStarts = new WeakMap<EntityTrack, {tick: number; at: number}>();
	private updateMovies(tick: number) {
		if (!this.movies) return;
		const ents = this.entities!;
		const displays = new Map<number, {t: EntityTrack; k: EntityKey}>();
		for (const t of ents.tracks) {
			if (t.className !== 'CMovieDisplay') continue;
			const k = keyAt(t, tick);
			if (k && !k.removed && k.extra) displays.set(t.index, {t, k});
		}
		const file = (k: EntityKey) => String(k.extra?.m_szMovieFilename ?? '').replace(/\\/g, '/').toLowerCase();
		const masters = new Map<string, {t: EntityTrack; k: EntityKey}>();
		for (const d of displays.values()) if (!Number(d.k.extra!.m_bForcedSlave) && /\.bik$/.test(file(d.k))) masters.set(String(d.k.extra!.m_szGroupName ?? ''), d);
		// (a movie starts over when its display is turned on or given another movie)
		const startOf = (t: EntityTrack) => {
			let c = this.movieStarts.get(t);
			if (c?.tick === tick) return c.at;
			let at = 0, on = false, name = '';
			for (const k of t.keys) {
				if (k.tick > tick) break;
				const now = Number(k.extra?.m_bEnabled) === 1, f = file(k);
				if ((now && !on) || (now && f !== name)) at = k.tick;
				on = now;
				name = f;
			}
			this.movieStarts.set(t, c = {tick, at});
			return c.at;
		};
		const specs: ScreenSpec[] = [];
		// a screen's corners: its origin the lower left, up its left axis by
		// its height, along its forward one by its width
		const corners = (m: THREE.Matrix4, k: EntityKey): [THREE.Vector3, THREE.Vector3, THREE.Vector3] => {
			const width = Number(k.extra?.m_flWidth ?? 0), height = Number(k.extra?.m_flHeight ?? 0);
			const ll = new THREE.Vector3().setFromMatrixPosition(m);
			const forward = new THREE.Vector3().setFromMatrixColumn(m, 0).normalize(), left = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
			const ul = ll.clone().addScaledVector(left, height);
			return [ll, ul, ul.clone().addScaledVector(forward, width)];
		};
		for (const t of ents.tracks) {
			if (t.className !== 'CVGuiScreen') continue;
			const k = keyAt(t, tick);
			// an indicator panel's: its check (or cross), or while it counts
			// down its dial's lit background (the dial's slices aren't drawn)
			const panel = k?.parent !== undefined ? this.entityAt(k.parent, tick, 'CLabIndicatorPanel') : undefined;
			if (k && panel) {
				const m = (Number(k.extra?.m_fScreenFlags ?? 0) & 1) ? this.worldMatrix(t, k, tick, 0) : null;
				if (!m) continue;
				const e = panel.extra ?? {};
				let image = Number(e.m_bIsChecked) ? 'vgui/signage/vgui_indicator_checked' : 'vgui/signage/vgui_indicator_unchecked';
				let dial: number | undefined;
				if (Number(e.m_bCountingDown)) {
					// (counting down from when it started, over its duration)
					const pt = ents.tracks.find(c => c.index === k.parent && c.className === 'CLabIndicatorPanel')!;
					let i = keyIndexAt(pt, tick);
					while (i > 0 && Number(pt.keys[i - 1].extra?.m_bCountingDown)) i--;
					const left = 1 - (tick - pt.keys[Math.max(0, i)].tick) * this.interval / Math.max(1e-3, Number(e.m_flTimerDuration) || 1);
					dial = Math.max(0, left) * 8;
					image = dial > 1e-6 ? 'vgui/signage/vgui_countdown_background_on' : 'vgui/signage/vgui_countdown_background';
				}
				specs.push({key: `${t.index}:${t.keys[0].tick}`, file: '', image, dial, start: 0, looping: false, corners: corners(m, k), uv: [0, 1, 0, 1]});
				continue;
			}
			const d = k?.parent !== undefined ? displays.get(k.parent) : undefined;
			if (!k || !d || Number(d.k.extra!.m_bEnabled) !== 1) continue;
			const src = Number(d.k.extra!.m_bForcedSlave) ? masters.get(String(d.k.extra!.m_szGroupName ?? '')) : d;
			if (!src || !/\.bik$/.test(file(src.k))) continue;
			const m = this.worldMatrix(t, k, tick, 0);
			if (!m) continue;
			const e = d.k.extra!;
			const custom = Number(e.m_bUseCustomUVs) === 1;
			specs.push({
				key: `${t.index}:${t.keys[0].tick}`, file: file(src.k), start: startOf(src.t) * this.interval, looping: Number(src.k.extra!.m_bLooping) === 1,
				corners: corners(m, k), uv: custom ? [Number(e.m_flUMin), Number(e.m_flUMax), Number(e.m_flVMin), Number(e.m_flVMax)] : [0, 1, 0, 1],
			});
		}
		this.movies.update(specs, tick * this.interval);
	}

	// particle systems drawn as blobs (render_blobs: gel flowing through the
	// finale's tubes), merged into surfaces as the paint is, one renderer per
	// blob shape; in their gel's colour, lit as the sprayers' streams are
	private particleBlobs = new Map<string, PaintBlobs>();
	private updateParticleBlobs() {
		const shapes = new Map<string, {shape: BlobShape; points: {pos: THREE.Vector3; color: THREE.Color}[]}>();
		const amb = this.bsp?.ambient;
		for (const s of this.particleRenderer?.blobs ?? []) {
			if (!s.points.length) continue;
			const key = `${s.radius}|${s.cutoffRatio}|${s.grid}`;
			let entry = shapes.get(key);
			if (!entry) shapes.set(key, entry = {shape: {radius: s.radius, cutoffRatio: s.cutoffRatio, grid: s.grid}, points: []});
			const power = /bounce/.test(s.material) ? 0 : /reflect/.test(s.material) ? 1 : /speed/.test(s.material) ? 2 : /erase|clean/.test(s.material) ? 4 : 3;
			const at = s.points[0];
			const cube = amb?.at([at.x, at.y, at.z]).cube;
			const light = cube ? cube.reduce((a, b) => a + b, 0) / 18 * AMBIENT_SCALE : 0.3;
			const c = PAINT_COLORS[power].map(v => Math.pow(v / 255, 2.2) * light);
			const color = new THREE.Color(c[0], c[1], c[2]);
			for (const pos of s.points) entry.points.push({pos, color});
		}
		for (const [key, {shape, points}] of shapes) {
			let pb = this.particleBlobs.get(key);
			if (!pb) {
				pb = new PaintBlobs(() => Infinity, shape);
				this.particleBlobs.set(key, pb);
				this.scene.add(pb.group);
			}
			pb.show(points);
		}
		for (const [key, pb] of this.particleBlobs) if (!shapes.has(key)) pb.show([]);
	}

	// ropes and cables: each from its start entity (or attachment) to its
	// end's, hung by Ropes; lit by the light at their nodes (the ambient
	// cube's average, as rope_averagelight 1)
	private ropes: Ropes | null = null;
	private updateRopes(tick: number) {
		if (!this.ropes) return;
		const amb = this.bsp?.ambient;
		const point = (handle: number, attachment: number): THREE.Vector3 | null => {
			const index = handle & 2047;
			if (handle < 0 || index === 2047) return null;
			if (attachment > 0) {
				const m = this.attachmentAt(index, attachment, tick, false);
				if (m) return new THREE.Vector3().setFromMatrixPosition(m);
			}
			for (const t of this.tracksByIndex.get(index) ?? []) if (keyAt(t, tick)) return this.entityPose(t, tick).origin.clone();
			return null;
		};
		const light = (p: THREE.Vector3): [number, number, number] => {
			const cube = amb?.at([p.x, p.y, p.z]).cube;
			if (!cube) return [0.3, 0.3, 0.3];
			const c: [number, number, number] = [0, 0, 0];
			for (let f = 0; f < 6; f++) for (let i = 0; i < 3; i++) c[i] += cube[f * 3 + i] / 6 * AMBIENT_SCALE;
			return c;
		};
		const specs: RopeSpec[] = [];
		for (const t of this.entities!.tracks) {
			if (t.className !== 'CRopeKeyframe') continue;
			const k = keyAt(t, tick);
			if (!k || k.removed || k.nodraw) continue;
			const e = k.extra ?? {};
			const start = point(Number(e.m_hStartPoint ?? -1), Number(e.m_iStartAttachment ?? 0)) ?? this.entityPose(t, tick).origin.clone();
			const end = point(Number(e.m_hEndPoint ?? -1), Number(e.m_iEndAttachment ?? 0));
			const locked = Number(e.m_fLockedPoints ?? 3);
			specs.push({
				key: `${t.index}:${t.serial}`, start, end, startLocked: (locked & 1) !== 0, endLocked: (locked & 2) !== 0,
				length: Number(e.m_RopeLength ?? 0), slack: Number(e.m_Slack ?? 0), segments: Number(e.m_nSegments ?? 5),
				subdiv: Number(e.m_Subdiv ?? 2), width: Number(e.m_Width ?? 2), textureScale: Number(e.m_TextureScale ?? 4),
				material: (k.model ?? t.model).replace(/\.vmt$/i, '') || 'cable/cable', light,
			});
		}
		this.ropes.update(specs);
	}

	// Turrets' laser sights (C_NPC_Portal_FloorTurret): a thin red beam from
	// the "light" attachment along the eyes' aim, to what it hits (8192 out)
	// and on through portals, while m_bLaserOn (flickering when out of ammo)
	private turretLasers = new Map<EntityTrack, Laser>();
	private laserRay = new THREE.Raycaster();
	private updateTurretLasers(tick: number) {
		const seen = new Set<EntityTrack>();
		for (const t of this.entities!.tracks) {
			if (t.className !== 'CNPC_Portal_FloorTurret') continue;
			const k = keyAt(t, tick);
			const o = this.objects.get(t);
			if (!k || !o?.visible || Number(k.extra?.m_bLaserOn) !== 1) continue;
			if (Number(k.extra?.m_bOutOfAmmo) === 1 && Math.sin(tick * 0.9 + t.index) > 0.3) continue;
			const muzzle = this.attachmentAt(t.index, 2, tick, false), eyes = this.attachmentAt(t.index, 1, tick, false);
			if (!muzzle || !eyes) continue;
			const start = new THREE.Vector3().setFromMatrixPosition(muzzle);
			const dir = new THREE.Vector3().setFromMatrixColumn(eyes, 0).normalize();
			const ray = new THREE.Ray(start.clone().addScaledVector(dir, 1), dir);
			// (traced as a shot is, MASK_SHOT: the world and its glass, props,
			// light bridges and other entities' models)
			let dist = 8192;
			for (const tree of [this.collision, this.glassCollision]) {
				const hit = tree?.raycastFirst(ray, THREE.DoubleSide);
				if (hit) dist = Math.min(dist, hit.distance + 1);
			}
			this.laserRay.set(ray.origin, ray.direction);
			this.laserRay.far = dist;
			// (animated models by their hitboxes, as shots hit them; the rest by their meshes)
			const blockers: THREE.Object3D[] = [this.propGroup];
			for (const [other, obj] of this.objects) {
				if (other === t || !obj.visible || other.className === 'CPortal_Player' || other.className === 'CProp_Portal') continue;
				const anim = obj.userData.anim as AnimatedModel | undefined;
				if (!anim?.hasHitboxes) {
					blockers.push(obj);
					continue;
				}
				anim.group.updateWorldMatrix(true, false);
				const d = anim.hitboxDistance(ray, anim.group.matrixWorld);
				if (d !== null && d < dist) dist = d + 1;
			}
			this.laserRay.far = dist;
			const solid = this.laserRay.intersectObjects(blockers, true).find(h => {
				const m = (h.object as THREE.Mesh).material as THREE.Material | undefined;
				// (effects let it through, light bridges don't)
				return h.object.visible && m && (h.object.userData.bridge || !m.userData.effect && !(m as THREE.ShaderMaterial).isShaderMaterial);
			});
			if (solid) dist = Math.min(dist, solid.distance + 1);
			// (players stop it too: their boxes, 32 wide, 72 tall or 36 ducked)
			for (const p of this.entities!.tracks) {
				const pk = p.className === 'CPortal_Player' ? keyAt(p, tick) : undefined;
				if (!pk) continue;
				const at = this.entityPose(p, tick).origin;
				const box = new THREE.Box3(at.clone().add(new THREE.Vector3(-16, -16, 0)), at.clone().add(new THREE.Vector3(16, 16, (pk.eyeZ ?? DEFAULT_EYE) < 50 ? 36 : 72)));
				const hit = ray.intersectBox(box, new THREE.Vector3());
				if (hit) dist = Math.min(dist, hit.distanceTo(start));
			}
			const end = start.clone().addScaledVector(dir, dist);
			let laser = this.turretLasers.get(t);
			if (!laser) {
				laser = new Laser(this.effects, 0.75, [1, 32 / 255, 32 / 255]);
				this.entityGroup.add(laser.group);
				this.turretLasers.set(t, laser);
			}
			laser.group.visible = true;
			laser.set(this.laserPath(start, end), this.camera.position);
			seen.add(t);
		}
		for (const [t, laser] of this.turretLasers) if (!seen.has(t)) laser.group.visible = false;
	}

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
		let redrawn = false;
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
			// (the exit portal's own edge isn't in its view: it would wrap the
			// camera, which sits in its plane)
			const shown = this.particlesShown.filter(i => this.edgeParticles.get(i) !== p.link);
			if (shown.length !== this.particlesShown.length) {
				this.particleRenderer?.draw(shown, cam);
				redrawn = true;
			}
			r.setRenderTarget(rt);
			// (what shows through is what can be seen from the exit portal)
			this.cullFrom(at.clone().addScaledVector(normal, 8));
			r.render(this.scene, cam);
			this.uncull();
			r.setRenderTarget(frameTarget);
			r.clippingPlanes = [];
			surface.visible = linkedSurface.visible = true;

			material.uniforms.view.value = rt.texture;
			material.uniforms.hasView.value = 1;
			material.uniforms.resolution.value.copy(size);
		}
		ditherUniforms.ditherOn.value = dither;
		if (redrawn) this.particleRenderer?.draw(this.particlesShown, this.camera);
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

	// the tick a portal was last placed (moved or activated) at or before
	// `tick`; with `activated`, the last time it was switched on only
	private portalPlacedAt(t: EntityTrack, tick: number, activated = false): number {
		let i = keyIndexAt(t, tick);
		while (i > 0) {
			const k = t.keys[i], prev = t.keys[i - 1];
			const switchedOn = k.active && !prev.active;
			const moved = prev.active !== k.active || prev.origin.some((v, j) => Math.abs(v - k.origin[j]) > 0.5);
			if (activated ? switchedOn : moved) return k.tick;
			i--;
		}
		// first seen already open: placed then, unless that's the recording's start
		return i >= 0 && t.keys[i].tick > 1 ? t.keys[i].tick : tick - 1000;
	}

	// How much static covers a portal's view (C_Prop_Portal's m_fStaticAmount):
	// all of it while unlinked; 1 when it's switched on or its partner is
	// placed or moved, wearing off over a second
	private portalStatic(t: EntityTrack, tick: number, link: number): number {
		const partner = (this.tracksByIndex.get(link) ?? []).find(c => keyAt(c, tick)?.active);
		if (!partner) return 1;
		const since = tick - Math.max(this.portalPlacedAt(t, tick, true), this.portalPlacedAt(partner, tick));
		return Math.min(1, Math.max(0, 1 - since * this.interval));
	}

	// Particle effects: info_particle_system runs (switched on to switched
	// off, then their particles live out their lives), the edges of open
	// portals, and effects the server dispatched (portal shots and muzzle
	// flashes). Each is simulated from its start, so seeking anywhere shows
	// the same thing.
	private updateParticles(tick: number) {
		const ents = this.entities, lib = this.particleLib;
		this.particlesShown = [];
		this.edgeParticles.clear();
		this.vmParticlesShown = [];
		if (!ents || !lib) return;
		const LINGER = 5 / this.interval;
		const seen = new Set<string>();
		const run = (key: string, name: string, start: number, end: number, cps: () => ControlPoints | null, opts: {cpAt?: (t: number) => THREE.Matrix4; fp?: boolean; live?: boolean; size?: number} = {}) => {
			const def = lib.get(name);
			if (!def || tick < start || tick > end + LINGER) return;
			const time = (tick - start) * this.interval;
			// a burst from long ago is over (no need to simulate it from the start)
			if (time > 8 && !isEndless(def, lib)) return;
			let r = this.particleRuns.get(key);
			if (r && r.inst.time > time + 1e-4) {
				// (back: from the latest saved state before then)
				const back = r.saved.filter(st => st.time <= time + 1e-4).pop();
				if (back) {
					r.inst.restore(back);
					r.saved = r.saved.filter(st => st.time <= back.time);
				} else r = undefined;
			}
			if (!r || r.inst.time > time + 1e-4 || time - r.inst.time > 3) {
				const c = cps();
				if (!c) return;
				const inst = new ParticleInstance(def, lib, c, hashKey(key));
				if (opts.cpAt) inst.setCpAt(opts.cpAt);
				if (opts.size) inst.setSizeScale(opts.size);
				if (time > 6 && !opts.cpAt) inst.skipTo(time - 6);
				r = {start, inst, saved: []};
				this.particleRuns.set(key, r);
			}
			seen.add(key);
			// (ends that move: control points taken afresh every frame)
			if (opts.live) {
				const c = cps();
				if (c) r.inst.setControlPoints(c);
			}
			const stopAt = (end - start) * this.interval;
			if (time >= stopAt && r.inst.emitting) {
				r.inst.advance(stopAt);
				r.inst.stopEmitting();
			}
			r.inst.advance(time);
			const last = r.saved[r.saved.length - 1];
			if (!r.inst.finished && (!last || r.inst.time - last.time >= 0.5)) {
				r.saved.push(r.inst.snapshot());
				if (r.saved.length > 12) r.saved.splice(0, 1);
			}
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
			if (key.startsWith('edge:')) for (const i of r.inst.all) this.edgeParticles.set(i, Number(key.split(':')[1]));
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
			} else if (t.className === 'CPropTractorBeamProjector') {
				// its three arms' particles (C_PropTractorBeamProjector::
				// CreateEffect): tractor_beam_arm on each emitter attachment,
				// coloured by the funnel's direction, flowing along it; from
				// when it was last switched on
				const i = keyIndexAt(t, tick);
				if (i < 0) continue;
				const k = t.keys[i], e = k.extra ?? {};
				if (k.removed || Number(e.m_bEnabled) !== 1 || Number(e.m_bNoEmitterParticles) === 1) continue;
				const sk = this.objects.get(t)?.userData.skeleton as Skeleton | undefined;
				if (!sk) continue;
				const on = (j: number) => Number(t.keys[j].extra?.m_bEnabled) === 1 && !t.keys[j].removed;
				let s0 = i;
				while (s0 > 0 && on(s0 - 1)) s0--;
				let e0 = i + 1;
				while (e0 < t.keys.length && on(e0)) e0++;
				const force = Number(e.m_flLinearForce) || 0;
				const color = force >= 0 ? [32, 70, 255] : [255, 60, 10];
				for (let n = 1; n <= 3; n++) {
					const att = sk.attachments.findIndex(a => a.name.toLowerCase() === `emitter${n}`) + 1;
					if (!att) continue;
					run(`arm:${t.index}:${t.keys[s0].tick}:${n}`, 'tractor_beam_arm', t.keys[s0].tick, e0 < t.keys.length ? t.keys[e0].tick : Infinity, () => {
						const m = this.attachmentAt(t.index, att, tick, false);
						if (!m) return null;
						const fwd = new THREE.Vector3(1, 0, 0).applyEuler(toEuler(this.entityPose(t, tick).angles)).multiplyScalar(force);
						return new Map([[0, m], [1, new THREE.Matrix4().setPosition(color[0], color[1], color[2])], [2, new THREE.Matrix4().setPosition(fwd)]]);
					}, {live: true});
				}
			} else if (t.className === 'CEntityFlame') {
				// fire on something: burning_character (burning_gib_01 when
				// cheap), both its control points on what's burning, followed
				const i = keyIndexAt(t, tick);
				if (i < 0) continue;
				const k = t.keys[i], e = k.extra ?? {};
				if (k.removed) continue;
				const gone = t.keys.findIndex(q => q.removed);
				const end = gone >= 0 ? t.keys[gone].tick : Infinity;
				const name = Number(e.m_bCheapEffect) === 1 ? 'burning_gib_01' : 'burning_character';
				const on = Number(e.m_hEntAttached ?? -1);
				run(`flame:${t.index}:${t.keys[0].tick}`, name, t.keys[0].tick, end, () => {
					const target = on >= 0 && (on & 2047) !== 2047 ? this.trackForHandle(on, tick) : undefined;
					const at = target ? this.entityPose(target, tick).origin : this.entityPose(t, tick).origin;
					const m = new THREE.Matrix4().setPosition(at);
					return new Map([[0, m], [1, m.clone()]]);
				}, {live: true});
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
					// (not 1: the effect keeps it 25 out from the portal, turning,
					// and points its ribbons by it)
					return new Map([[0, cp0], [7, new THREE.Matrix4().setPosition(color[0], color[1], color[2])]]);
				});
			}
		}

		// the gun's top light (portalgun_top_light_*person at Body_light, its
		// core glow at Inside_effects, in the barrel), in the colour of the
		// last portal it fired
		for (const p of ents.tracks) {
			if (p.className !== 'CPortal_Player' || !keyAt(p, tick)) continue;
			const gun = ents.tracks.find(g => g.className === 'CWeaponPortalgun' && keyAt(g, tick)?.parent === p.index);
			const gk = gun && keyAt(gun, tick);
			if (!gun || !gk) continue;
			const fp = this.mode === 'eyes' && p === this.followTrack && !!this.vmShown;
			if (!fp && !gk.visible) continue;
			const [bodyLight, beamPoint] = fp ? [11, 17] : [12, 18];
			const team = Number(keyAt(p, tick)?.extra?.m_iTeamNum ?? 0);
			const color = this.portalColor(Number(gk.extra?.m_iLastFiredPortal ?? 0) === 2, team);
			run(`toplight:${fp ? 'fp' : 'tp'}:${p.index}:${gun.keys[0].tick}`, fp ? 'portalgun_top_light_firstperson' : 'portalgun_top_light_thirdperson', gun.keys[0].tick, Infinity, () => {
				const light = this.attachmentAt(fp ? p.index : gun.index, bodyLight, tick, fp);
				const core = this.attachmentAt(fp ? p.index : gun.index, beamPoint, tick, fp);
				if (!light || !core) return null;
				return new Map([[0, light], [1, new THREE.Matrix4().setPosition(color[0], color[1], color[2])], [3, core]]);
			}, {fp, live: true, size: fp ? VM_PARTICLE_SCALE : 1});
		}

		// the arcs the gun draws while holding something (DoEffectHolding):
		// between its three claw tips and its muzzle (control points 0
		// muzzle, 1-3 Arm1-3_attach3, 4 the player, 5 what's held), on the
		// view model in first person, else on the held gun
		for (const p of ents.tracks) {
			if (p.className !== 'CPortal_Player') continue;
			const k = keyAt(p, tick);
			const h = Number(k?.extra?.m_hAttachedObject ?? -1);
			if (!k || h < 0 || (h & 2047) === 2047) continue;
			const ot = this.trackForHandle(h, tick);
			const held = ot && this.objects.get(ot);
			let i = keyIndexAt(p, tick);
			while (i > 0 && Number(p.keys[i - 1].extra?.m_hAttachedObject ?? -1) === h) i--;
			const since = p.keys[i].tick;
			const fp = this.mode === 'eyes' && p === this.followTrack && !!this.vmShown;
			const gun = fp ? p : ents.tracks.find(g => g.className === 'CWeaponPortalgun' && keyAt(g, tick)?.parent === p.index);
			if (!gun) continue;
			// attachments (1-based): v_portalgun muzzle 1, arms 4/7/10; w_portalgun muzzle 1, arms 5/8/11
			const atts = fp ? [1, 4, 7, 10] : [1, 5, 8, 11];
			// (turned as the attachments are: the strands bulge out along their ends' axes)
			const at = (m: THREE.Matrix4 | null) => {
				if (!m) return null;
				const pos = new THREE.Vector3(), rot = new THREE.Quaternion();
				m.decompose(pos, rot, new THREE.Vector3());
				return new THREE.Matrix4().compose(pos, rot, new THREE.Vector3(1, 1, 1));
			};
			run(`hold:${fp ? 'fp' : 'tp'}:${p.index}:${since}`, fp ? 'portalgun_beam_holding_FP' : 'portalgun_beam_holding_TP', since, Infinity, () => {
				const pts = atts.map(a => at(this.attachmentAt(gun.index, a, tick, fp)));
				if (pts.some(m => !m)) return null;
				const cps: ControlPoints = new Map(pts.map((m, n) => [n, m!]));
				const pk = this.entityPose(p, tick);
				cps.set(4, new THREE.Matrix4().setPosition(pk.origin));
				// (on this side of a portal it's held through)
				if (held) cps.set(5, new THREE.Matrix4().setPosition(held.userData.heldApparent ?? new THREE.Vector3().setFromMatrixPosition(held.matrixWorld)));
				return cps;
			// (first person: the client shrinks these arcs (cl_portalgun_beam_size);
			// the scale here is matched to its frames, not taken from its code)
			}, {fp, live: true, size: fp ? 0.4 : 1});
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
			// where it's attached (m_nDamageType holds the attach type): at an
			// attachment, or following the entity's origin (a lasered cube's
			// glow), these taken afresh each frame; else where it was sent from
			const attach = fx.damageType;
			const follow = attach === 1 || attach === 4;
			run(`fx:${n}`, name, fx.tick, stop, () => {
				let cp = this.attachmentAt(fx.entity, fx.attachment, tick, fp);
				if (!cp && attach === 1) {
					const t = (this.tracksByIndex.get(fx.entity) ?? []).find(c => keyAt(c, tick));
					const k = t && keyAt(t, tick);
					cp = t && k ? this.worldMatrix(t, k, tick, 0) : null;
				}
				return new Map([[0, cp ?? new THREE.Matrix4().compose(new THREE.Vector3(...fx.origin), new THREE.Quaternion().setFromEuler(toEuler(fx.angles)), new THREE.Vector3(1, 1, 1))]]);
			}, {fp, size: fp ? VM_PARTICLE_SCALE : 1, live: follow});
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
	// the camera entity the recording player's view is handed to
	// (m_hViewEntity: point_viewcontrol), as a world matrix, while it is
	private viewEntity: THREE.Matrix4 | null = null;
	private viewEntityMatrix(pk: EntityKey | undefined, tick: number): THREE.Matrix4 | null {
		const h = Number(pk?.extra?.m_hViewEntity ?? -1);
		const index = h & 2047;
		if (h < 0 || index === 2047 || index === this.followTrack?.index) return null;
		const t = (this.tracksByIndex.get(index) ?? []).find(c => keyAt(c, tick));
		const k = t && keyAt(t, tick);
		return t && k ? this.worldMatrix(t, k, tick, 0) : null;
	}

	private updateViewModel(tick: number) {
		if (this.vmShown) this.vmShown.visible = false;
		this.vmShown = null;
		const ents = this.entities;
		// the view model belongs to the recording player (and isn't drawn
		// through a view entity's camera)
		if (!ents || this.mode !== 'eyes' || this.followed || this.viewEntity) return;
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
			disposeOwn(g);
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
		// at the eye, turned with the view, swaying
		this.swayViewModel(g, tick);
		g.visible = true;
		this.vmShown = g;
	}

	// The view model's sway, as the client does it: Portal's AddViewmodelBob
	// moves and tips it with movement speed, and CalcViewModelLag lets it
	// trail the view when turning (a facing that catches up at 5/s, faster
	// once more than 1.5 off, turned with the player through portals). The
	// trailing facing is replayed over the last second, so seeking or pausing
	// gives the same pose
	private swayViewModel(g: THREE.Group, tick: number) {
		const eyeQuat = (a: number[]) => new THREE.Quaternion().setFromEuler(toEuler(a as Vec3));
		const q = eyeQuat(this.eyeAngles);
		const pos = this.camera.position.clone();
		const track = this.track;
		if (!track?.seg.views.length) {
			g.position.copy(pos);
			g.quaternion.copy(q);
			return;
		}
		const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
		const right = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
		const up = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
		const {vertical, lateral} = this.viewModelBob(tick);
		pos.addScaledVector(forward, vertical * 0.1).addScaledVector(up, vertical * 0.1).addScaledVector(right, lateral * 0.8);
		// roll, then pitch about the rolled right, then yaw about the result's up
		const deg = Math.PI / 180;
		const roll = new THREE.Quaternion().setFromAxisAngle(right.clone().cross(up).normalize(), vertical * 0.5 * deg);
		right.applyQuaternion(roll);
		up.applyQuaternion(roll);
		const pitch = new THREE.Quaternion().setFromAxisAngle(right, -vertical * 0.4 * deg);
		up.applyQuaternion(pitch);
		const yaw = new THREE.Quaternion().setFromAxisAngle(up, -lateral * 0.3 * deg);
		g.quaternion.copy(yaw.multiply(pitch).multiply(roll).multiply(q));

		const STEPS = 60;
		let ang = viewAt(track, tick - STEPS);
		if (!ang) return;
		const facing = new THREE.Vector3(1, 0, 0).applyQuaternion(eyeQuat(ang.angles));
		const diff = new THREE.Vector3(), f = new THREE.Vector3();
		for (let s = STEPS - 1; s >= 0; s--) {
			const v = viewAt(track, tick - s);
			if (!v) break;
			if (v.viewIndex !== ang.viewIndex && track.teleports.subarray(ang.viewIndex + 1, v.viewIndex + 1).some(Boolean)) {
				// through a portal (or teleported): the facing turns with the view
				facing.applyQuaternion(eyeQuat(v.angles).multiply(eyeQuat(ang.angles).invert()));
			}
			f.set(1, 0, 0).applyQuaternion(eyeQuat(v.angles));
			diff.subVectors(f, facing);
			const len = diff.length();
			const speed = len > 1.5 ? 5 * len / 1.5 : 5;
			facing.addScaledVector(diff, speed * this.interval).normalize();
			ang = v;
		}
		pos.addScaledVector(diff, -5);
		g.position.copy(pos);
	}

	// Portal's view model bob (CBasePortalCombatWeapon::CalcViewmodelBob):
	// a clock that runs with speed over the walking speed, a vertical cycle
	// every 0.45 s of it (up in the first half) and a sideways one every 0.9 s
	private viewModelBob(tick: number): {vertical: number, lateral: number} {
		const track = this.track!, views = track.seg.views;
		const MAX_SPEED = 175, CYCLE = 0.45, UP = 0.5;
		if (!this.bobClock) {
			const time = new Float64Array(views.length), speed = new Float32Array(views.length);
			for (let i = 1; i < views.length; i++) {
				const dt = (views[i].tick - views[i - 1].tick) * this.interval;
				const a = views[i - 1].origin, b = views[i].origin;
				speed[i] = dt > 0 && !track.teleports[i] ? Math.min(MAX_SPEED, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt) : speed[i - 1];
				time[i] = time[i - 1] + dt * speed[i] / MAX_SPEED;
			}
			if (views.length > 1) speed[0] = speed[1];
			this.bobClock = {time, speed};
		}
		const {time, speed} = this.bobClock;
		const v = viewAt(track, tick);
		const i = v?.viewIndex ?? 0, j = Math.min(i + 1, views.length - 1);
		const span = views[j].tick - views[i].tick;
		const frac = span > 0 ? Math.min(1, Math.max(0, (tick - views[i].tick) / span)) : 0;
		const bobtime = time[i] + (time[j] - time[i]) * frac;
		const sp = speed[i] + (speed[j] - speed[i]) * frac;
		// (the sideways cycle as written, (int)(bobtime/CYCLE*2)*CYCLE*2, which
		// takes off whole quarter-periods: a plain sine every 0.9 s)
		const wave = (period: number, wraps: number) => {
			let c = (bobtime - Math.trunc(bobtime / period * wraps) * period * wraps) / (period * wraps);
			c = c < UP ? Math.PI * c / UP : Math.PI + Math.PI * (c - UP) / (1 - UP);
			const b = sp * 0.005;
			return Math.min(4, Math.max(-7, b * 0.3 + b * 0.7 * Math.sin(c)));
		};
		return {vertical: wave(CYCLE, 1), lateral: wave(CYCLE, 2)};
	}

	// Lit models with an $envmap reflect the map's cubemap nearest to them
	// (env_cubemap: the engine picks it by the model's lighting point), set
	// again when they move to another's
	private reflectAt(o: THREE.Object3D, at: THREE.Vector3) {
		const cubes = this.bsp?.cubemaps;
		const mats: THREE.Material[] = [];
		o.traverse(c => {
			const m = (c as THREE.Mesh).material as THREE.Material | undefined;
			if ((c as THREE.Mesh).isMesh && m?.userData.modelEnv && m.userData.envUniforms) mats.push(m);
		});
		if (!mats.length) return;
		let near = '';
		if (cubes?.length) {
			let best = Infinity;
			for (const c of cubes) {
				const d = (c[0] - at.x) ** 2 + (c[1] - at.y) ** 2 + (c[2] - at.z) ** 2;
				if (d < best) {
					best = d;
					near = `maps/${this.bsp!.name}/c${c[0]}_${c[1]}_${c[2]}`;
				}
			}
		}
		const named = (mats[0].userData.modelEnv as {cube: string}).cube;
		const path = named.toLowerCase() === 'env_cubemap' ? near : named;
		if (!path || o.userData.envPath === path) return;
		o.userData.envPath = path;
		this.library!.cube(path).then(c => {
			if (o.userData.envPath !== path) return;
			for (const m of mats) setModelEnvCube(m, c?.texture ?? null, c?.scale ?? 1);
			this.loaded();
		});
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
			if (hooked) {
				o.userData.ambSomeHooked = true;
				// (lit again: the new copies take its reflection)
				delete o.userData.lightingKey;
				delete o.userData.envPath;
			}
		};
		const p = new THREE.Vector3();
		const light = (o: THREE.Object3D, at: THREE.Vector3) => {
			// (again when a switchable light changes)
			const key = `${Math.round(at.x / 4)},${Math.round(at.y / 4)},${Math.round(at.z / 4)},${this.styleGen}`;
			if (o.userData.lightingKey === key) return;
			o.userData.lightingKey = key;
			o.userData.lighting = amb.at([at.x, at.y, at.z], this.lightReaches, this.styleNow);
			this.reflectAt(o, at);
		};
		const apply = (o: THREE.Object3D) => {
			hookMeshes(o);
			// (fresh world matrix: held objects are placed by hand each frame)
			o.updateWorldMatrix(true, false);
			// where it's lit from, in its own space: its model's illumination
			// position, as the engine lights it; else (players, brushes) its
			// centre once it has loaded
			let local = o.userData.lightCentre as THREE.Vector3 | undefined;
			const illum = (o.userData.asset as ModelAsset | undefined)?.model.illumPosition;
			if (!local && illum) local = o.userData.lightCentre = new THREE.Vector3(...illum);
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
	// The client draws other entities in the past, by its interpolation
	// amount: (cl_interp 0.1 s, as cl_interp_ratio 2 / cl_updaterate 20) in
	// ticks, plus one (C_BaseEntity::GetInterpolationAmount); the recording
	// player is where its view is
	interpDelay = 7;
	private entityPose(t: EntityTrack, tick: number): {origin: THREE.Vector3; angles: Vec3} {
		if (t !== this.followTrack) tick = Math.max(0, tick - this.interpDelay);
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
			return new THREE.Matrix4().compose(this.camera.position, new THREE.Quaternion().setFromEuler(toEuler(this.eyeAngles as Vec3)), new THREE.Vector3(1, 1, 1));
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
			const ot = this.trackForHandle(h, tick);
			const o = ot && this.objects.get(ot);
			const ok = ot && keyAt(ot, Math.floor(tick));
			if (!o || !ok) continue;
			o.visible = true;
			const hk = keyAt(p, ok.tick) ?? k;
			const holderThen = new THREE.Matrix4().compose(
				new THREE.Vector3(hk.origin[0], hk.origin[1], hk.origin[2] + (hk.eyeZ ?? DEFAULT_EYE)),
				new THREE.Quaternion().setFromEuler(toEuler([hk.angles[0], hk.angles[1], 0])), new THREE.Vector3(1, 1, 1));
			const objThen = new THREE.Matrix4().compose(new THREE.Vector3(...ok.origin), new THREE.Quaternion().setFromEuler(toEuler(ok.angles)), new THREE.Vector3(1, 1, 1));
			let local = holderThen.clone().invert().multiply(objThen);
			let offset = new THREE.Vector3().setFromMatrixPosition(local);
			// held through a portal: the object stays on the far side (seen
			// through the portal), where the holder seen through that portal
			// pair has it within reach
			let through: THREE.Matrix4 | null = null;
			if (offset.length() > HOLD_MAX) {
				for (const pp of this.portals.values()) {
					const linked = this.portals.get(pp.link);
					if (!linked) continue;
					const m = this.portalTransform(pp.obj, linked.obj);
					const l = m.clone().multiply(holderThen).invert().multiply(objThen);
					const off = new THREE.Vector3().setFromMatrixPosition(l);
					if (off.length() <= HOLD_MAX) {
						local = l;
						offset = off;
						through = m;
						break;
					}
				}
			}
			if (offset.length() <= HOLD_MAX) o.userData.heldOffset = offset.clone();
			else local.setPosition(o.userData.heldOffset ?? HOLD_OFFSET);
			const eye = this.eyeMatrix(p, tick, this.mode === 'eyes' && p === this.followTrack);
			let apparent = eye.clone().multiply(local);
			// co-op's view model grab: the client draws it facing the way the
			// holder faces (their yaw, turned by the object's preferred carry
			// angles), not as the server has it
			// (with no preferred angles, FLT_MAX, it keeps the turn it had
			// against the holder's yaw: the server's at that update)
			const carry = ok.extra?.m_qPreferredPlayerCarryAngles as number[] | undefined;
			if (Number(k.extra?.m_bUseVMGrab) === 1 && carry) {
				const yaw = new THREE.Vector3(1, 0, 0).transformDirection(eye);
				const yawAngle = Math.atan2(yaw.y, yaw.x) * 180 / Math.PI;
				const turn = carry.every(a => Math.abs(a) < 1e30)
					? new THREE.Quaternion().setFromEuler(toEuler(carry as Vec3))
					: new THREE.Quaternion().setFromEuler(toEuler([0, hk.angles[1], 0])).invert().multiply(new THREE.Quaternion().setFromEuler(toEuler(ok.angles)));
				const q = new THREE.Quaternion().setFromEuler(toEuler([0, yawAngle, 0])).multiply(turn);
				apparent = new THREE.Matrix4().compose(new THREE.Vector3().setFromMatrixPosition(apparent), q, new THREE.Vector3(1, 1, 1));
			}
			// (where the holder sees it, for the gun's arcs)
			o.userData.heldApparent = new THREE.Vector3().setFromMatrixPosition(apparent);
			o.matrixAutoUpdate = false;
			o.matrix.copy(through ? through.multiply(apparent) : apparent);
			o.matrixWorldNeedsUpdate = true;
		}
	}

	// the on-screen text sent to the recording player (game_text: chapter
	// titles), in Eyes view, with the seconds per tick
	hudMessages(): {messages: HudMessage[]; interval: number} | null {
		if (this.mode !== 'eyes' || this.followed || !this.entities?.hudMessages.length) return null;
		return {messages: this.entities.hudMessages, interval: this.interval};
	}

	// The challenge mode HUD's numbers at a tick: the recording player's
	// portals placed and seconds taken (networked stats; the clock runs on
	// between updates), or null outside challenge mode
	cmStats(tick: number): {portals: number; seconds: number} | null {
		const p = this.entities?.player ? this.followTrack : null;
		if (!p || this.followed) return null;
		const i = keyIndexAt(p, tick);
		if (i < 0) return null;
		const k = p.keys[i], e = k.extra ?? {};
		const challenge = Number(e.m_iBonusChallenge ?? e['localdata.m_iBonusChallenge'] ?? 0);
		const seconds = Number(e['m_StatsThisLevel.fNumSecondsTaken'] ?? NaN);
		if (!challenge || Number.isNaN(seconds)) return null;
		const next = p.keys[i + 1];
		const nextSeconds = Number(next?.extra?.['m_StatsThisLevel.fNumSecondsTaken'] ?? NaN);
		const running = next && nextSeconds > seconds;
		const f = running ? Math.min(1, (tick - k.tick) / (next.tick - k.tick)) : 0;
		return {portals: Number(e['m_StatsThisLevel.iNumPortalsPlaced'] ?? 0), seconds: seconds + (running ? (nextSeconds - seconds) * f : 0)};
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
	private playerAnim(t: EntityTrack, tick: number, sk: Skeleton): {seq: number; cycle: number; params: Record<string, number>; gestures: Gesture[]; feetYaw: number} {
		const m = this.playerMotion(t, sk);
		// (ticks between network updates are fractional)
		const i = Math.min(m.seq.length - 1, Math.max(0, Math.floor(tick) - m.start)) || 0;
		const k = keyAt(t, tick)!;
		const c = m.phase[i];
		// the landing gesture, once through (blending in and out)
		const gestures: Gesture[] = [];
		if (m.landAt[i] >= 0 && m.land >= 0) {
			const s = sk.sequences[m.land];
			const elapsed = (i - m.landAt[i]) * this.interval;
			const length = 1 / sequenceRate(sk, m.land);
			if (elapsed < length) {
				const weight = Math.min(1, s.fadeIn > 0 ? elapsed / s.fadeIn : 1, s.fadeOut > 0 ? (length - elapsed) / s.fadeOut : 1);
				gestures.push({seq: m.land, cycle: elapsed / length, weight});
			}
		}
		const params = {move_x: m.moveX[i], move_y: m.moveY[i], body_pitch: -normPitch(k.angles[0]), body_yaw: m.bodyYaw[i]};
		return {seq: m.seq[i], cycle: c - Math.floor(c), params, gestures, feetYaw: m.feetYaw[i]};
	}

	// A player's animation for every tick of their track, as the game's
	// player animation state (CPortalPlayerAnimState) picks it: idle, run or
	// crouch-walk by speed (the cycle advanced at the speed-matched rate, so
	// speed changes don't jump the legs); in the air the jump's start for
	// 0.2 s, then the air walk; floating in a funnel, a long fall after one;
	// the landing gesture on touching down. The feet stay put while standing
	// until the view turns 45 degrees past them, then catch up (moving, they
	// follow the view); the upper body turns the rest (body_yaw).
	private motions = new WeakMap<EntityTrack, PlayerMotion>();
	private playerMotion(t: EntityTrack, sk: Skeleton): PlayerMotion {
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
		// by activity: the holding-the-gun version where there's one
		const act = (name: string, fallback: number) => {
			const i = sk.sequences.findIndex(s => s.activity === `${name}_PRIMARY`);
			const j = i >= 0 ? i : sk.sequences.findIndex(s => s.activity === name);
			return j >= 0 ? j : fallback;
		};
		const RUN = pick('portalgun_run'), CROUCHWALK = pick('portalgun_crouchwalk');
		const IDLE = pick('portalgun_standing_idle'), CROUCH = pick('portalgun_crouch_idle');
		// (Chell's float is portalgun_jump_float, the robots' portalgun_jumpfloat)
		const FLOAT = act('ACT_MP_JUMP_FLOAT', pick('portalgun_jump_float', 'portalgun_jumpfloat'));
		const JUMP = act('ACT_MP_JUMP_START', FLOAT), AIRWALK = act('ACT_MP_AIRWALK', FLOAT);
		const TRACTOR = act('ACT_MP_TRACTORBEAM_FLOAT', FLOAT), LONG_FALL = act('ACT_MP_LONG_FALL', FLOAT);
		const LAND = act('ACT_MP_JUMP_LAND', -1);
		const funnels = this.entities!.tracks.filter(f => f.className === 'CTrigger_TractorBeam');
		const inFunnel = (tick: number, p: number[]) => funnels.some(f => {
			const fk = keyAt(f, tick);
			const e = fk?.extra;
			if (!fk || fk.removed || !e || Number(e.m_bDisabled) === 1) return false;
			const a = vec3(e.m_vStart), b = vec3(e.m_vEnd);
			if (!a || !b) return false;
			// (the player's middle within the column)
			const mid = new THREE.Vector3(p[0], p[1], p[2] + 36);
			return new THREE.Line3(a, b).closestPointToPoint(mid, true, new THREE.Vector3()).distanceTo(mid) < (Number(e.m_flRadius) || 55);
		});

		const start = t.keys[0].tick, n = Math.max(1, t.keys[t.keys.length - 1].tick - start + 1);
		const m: PlayerMotion = {
			start, land: LAND, seq: new Int16Array(n), phase: new Float64Array(n), moveX: new Float32Array(n), moveY: new Float32Array(n),
			landAt: new Int32Array(n).fill(-1), feetYaw: new Float32Array(n), bodyYaw: new Float32Array(n),
		};
		let ki = 0, cycle = 0, last = -1, landAt = -1;
		let jumping = false, jumpStart = 0, inAirWalk = false, landing = false, wasInFunnel = false, wasOnGround = true;
		let feet = NaN, goalFeet = NaN;
		for (let i = 0; i < n; i++) {
			const tick = start + i, now = i * this.interval;
			while (ki + 1 < t.keys.length && t.keys[ki + 1].tick <= tick) ki++;
			const k = t.keys[ki];
			const before = keyAt(t, tick - 6) ?? k;
			const dt = Math.max(6, k.tick - before.tick) * this.interval;
			const v = [0, 1, 2].map(a => (k.origin[a] - before.origin[a]) / dt);
			const speed = Math.hypot(v[0], v[1]);
			const flags = Number(k.extra?.m_fFlags ?? NaN);
			// FL_ONGROUND and FL_DUCKING when recorded, else guessed from motion
			const onGround = Number.isNaN(flags) ? Math.abs(v[2]) <= 40 : (flags & 1) !== 0;
			const crouched = Number.isNaN(flags) ? k.eyeZ !== undefined && k.eyeZ < 50 : !!(flags & 2);
			const tractorHandle = Number(k.extra?.['m_PortalLocal.m_hTractorBeam'] ?? NaN);
			const inTractor = Number.isNaN(tractorHandle) ? !onGround && inFunnel(tick, k.origin) : tractorHandle >= 0 && (tractorHandle & 2047) !== 2047;

			// a jump (the animation event the client gets): leaving the ground
			// going up; it starts the jump's sequence over
			let restart = false;
			if (wasOnGround && !onGround && v[2] > 100) {
				inAirWalk = false;
				landing = false;
				jumping = true;
				jumpStart = now;
				restart = true;
			}
			wasOnGround = onGround;

			let s: number, rate = 1;
			// the base: jumping, ducking, or by speed
			if (jumping && now - jumpStart > 0.2) {
				jumping = false;
				inAirWalk = true;
			}
			if (jumping) s = JUMP;
			else if (!onGround && inAirWalk) s = AIRWALK;
			else if (speed > 15) {
				s = crouched ? CROUCHWALK : RUN;
				rate = Math.min(2, Math.max(0.4, speed / (crouched ? 63 : 175)));
				const yaw = k.angles[1] * Math.PI / 180;
				m.moveX[i] = (v[0] * Math.cos(yaw) + v[1] * Math.sin(yaw)) / speed;
				m.moveY[i] = (-v[0] * Math.sin(yaw) + v[1] * Math.cos(yaw)) / speed;
			} else s = crouched ? CROUCH : IDLE;
			// then Portal's: landing, the funnel, the air
			if (landing && onGround) {
				jumping = inAirWalk = landing = wasInFunnel = false;
				restart = true;
				landAt = i;
			} else if (inTractor) {
				wasInFunnel = true;
				s = TRACTOR;
			} else if (!onGround && wasInFunnel) {
				landing = true;
				s = LONG_FALL;
			} else if (!onGround && (v[2] > 300 || inAirWalk)) {
				jumping = false;
				inAirWalk = landing = true;
				s = AIRWALK;
			}
			if (s !== last || restart) cycle = 0;
			last = s;
			m.seq[i] = s;
			cycle += this.interval * sequenceRate(sk, s) * rate;
			m.phase[i] = cycle;
			m.landAt[i] = landAt;

			// the feet (ComputePoseParam_AimYaw, ConvergeYawAngles at 720/s)
			const eye = k.angles[1];
			if (Number.isNaN(feet)) feet = goalFeet = eye;
			if (Math.hypot(v[0], v[1], v[2]) > 1) goalFeet = eye;
			else {
				const delta = normYaw(goalFeet - eye);
				if (Math.abs(delta) > 45) goalFeet += delta > 0 ? -45 : 45;
			}
			goalFeet = normYaw(goalFeet);
			if (goalFeet !== feet) {
				// (the engine takes the size of the turn before wrapping it)
				const deltaAbs = Math.abs(goalFeet - feet), delta = normYaw(goalFeet - feet);
				const step = 720 * this.interval * Math.min(1, Math.max(0.01, deltaAbs / 60));
				feet = deltaAbs < step ? goalFeet : normYaw(feet + (delta < 0 ? -step : step));
			}
			m.feetYaw[i] = feet;
			m.bodyYaw[i] = -normYaw(eye - feet);
		}
		this.motions.set(t, m);
		return m;
	}

	// the entity an entity handle (index | serial << 11) names at a tick:
	// the track at that index with that serial (indices get reused) that has
	// started by then, the latest such
	private trackForHandle(h: number, tick: number): EntityTrack | undefined {
		const serial = h >> 11;
		let best: EntityTrack | undefined;
		for (const t of this.tracksByIndex.get(h & 2047) ?? []) {
			if (!t.keys.length || t.keys[0].tick > tick) continue;
			if (t.serial !== undefined && t.serial !== serial) continue;
			if (!best || t.keys[0].tick > best.keys[0].tick) best = t;
		}
		return best;
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
		this.bloomScale = tk && Number(tk.m_bUseCustomBloomScale) ? Number(tk.m_flCustomBloomScale) || 0 : 1;
	}

	// Auto exposure, as the engine's (mat_tonemap_algorithm 1): every few
	// frames the view is drawn small, and the scale is set from a histogram
	// of it (see histogramTarget); within the tonemap controller's range,
	// approached gradually.
	private meterExposure(r: THREE.WebGLRenderer, measure = true) {
		// the eye adapts in the recording's time (while playing; by the clock
		// when paused), and starts over after a jump: it takes the next
		// reading as it is
		const now = performance.now();
		const wall = Math.min(0.5, (now - this.lastRender) / 1000);
		this.lastRender = now;
		const step = Math.abs(this.meterTick - this.meterTickLast) * this.interval;
		this.meterTickLast = this.meterTick;
		if (step > 1) this.meterSnap = true;
		const dt = step > 0 && step <= 1 ? step : wall;
		if ((this.meterCount++ % 8 === 0 || this.meterSnap) && !this.meterPending && measure) {
			const w = 64, h = 36;
			// (with a stencil buffer: the sky is masked to the sky faces by it)
			this.meter ??= new THREE.WebGLRenderTarget(w, h, {type: THREE.HalfFloatType, stencilBuffer: true});
			// (fogged: the game meters the frame as it's drawn)
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
			this.cullFrom(this.camera.position);
			r.render(this.scene, this.camera);
			this.uncull();
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
			// read back without waiting for the GPU (it lands a frame or two
			// later); started while the meter is the target, as the read puts
			// back the target's single-sampled buffer, not the multisampled one
			// the frame is drawn into
			const px = new Uint16Array(w * h * 4);
			this.meterPending = true;
			const exposed = this.exposure;
			// (the game meters the frame as shown: under the screen fade)
			const fade = this.fadeAt(this.meterTick);
			const take = () => {
				const target = histogramTarget(px, w, h, exposed, fade);
				if (target) this.meterTarget = Math.min(this.exposureRange[1], Math.max(this.exposureRange[0], target));
				if (target && this.meterSnap) {
					this.exposure = this.meterTarget!;
					this.meterSnap = false;
				}
			};
			// (captures read it at once: a background page's async reads crawl)
			const reading = this.syncMeter ? null : r.readRenderTargetPixelsAsync(this.meter, 0, 0, w, h, px);
			if (this.syncMeter) r.readRenderTargetPixels(this.meter, 0, 0, w, h, px);
			r.setRenderTarget(frameTarget);
			for (const o of overlays) o.visible = true;
			this.sky.visible = skyShown;
			if (!reading) {
				take();
				this.meterPending = false;
			} else reading.then(take).catch(() => {}).finally(() => { this.meterPending = false; });
		}
		// (the engine eases in by its rate x 2 x the frame time, at most 1/60 of
		// the way a frame (1/15 of the histogram's 16 buckets, quartered): at
		// the 60 frames a second the game's recorded at, always that 1/60)
		let t = Math.min(this.exposureRange[1], Math.max(this.exposureRange[0], this.meterTarget ?? this.exposure));
		// (the engine eases towards a weighted average of the last ten frames'
		// targets: the oldest and newest count most, the middle ones least)
		if (this.meterSnap) this.targetHistory.length = 0;
		this.targetHistory.push(t);
		if (this.targetHistory.length > 10) this.targetHistory.shift();
		if (this.targetHistory.length === 10) {
			let sum = 0, weights = 0;
			this.targetHistory.forEach((v, i) => {
				const w = Math.abs(i - 5) / 5;
				sum += w * v;
				weights += w;
			});
			t = sum / weights;
		}
		this.exposure += (t - this.exposure) * (1 - Math.pow(1 - 1 / 60, dt * 60));
		r.toneMappingExposure = this.exposure;
		exposureUniforms.sceneExposure.value = this.exposure;
	}
	private capturing = false;
	private meterTarget: number | null = null;
	private meterPending = false;
	private meterTick = 0;
	private meterTickLast = 0;
	private meterSnap = true;
	// read the exposure meter synchronously (scripted captures)
	syncMeter = false;
	private targetHistory: number[] = [];

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
		this.styleGen++;
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

	private frameNumber = 0;
	update(view: ViewState | null, tick: number) {
		this.meterTick = tick;
		this.frameNumber++;
		this.seenCache.clear();
		this.resize();
		const ents = this.entities;
		if (ents) {
			this.portals.clear();
			const time = performance.now() / 1000;
			for (const m of this.fizzlers.values()) m.uniforms.time.value = time;
			waterUniforms.waterTime.value = time;
			this.paint?.seek(tick);
			this.updateLightStyles(tick);
			// what players hold: the server hides it from its holder (the game
			// draws a copy in front of the view instead), so it's shown here
			for (const o of this.windowed) o.visible = tick >= o.userData.window[0] && tick < o.userData.window[1];
			for (const o of this.windowedKids) o.visible = tick >= o.userData.window[0] && tick < o.userData.window[1];
			const held = new Set<EntityTrack>();
			for (const p of ents.tracks) {
				if (p.className !== 'CPortal_Player') continue;
				const h = Number(keyAt(p, tick)?.extra?.m_hAttachedObject ?? -1);
				const ht = h >= 0 && (h & 2047) !== 2047 ? this.trackForHandle(h, tick) : undefined;
				if (ht) held.add(ht);
			}
			for (const t of ents.tracks) {
				const k = keyAt(t, tick);
				if (t.className === 'CInfoOverlayAccessor') {
					this.overlayFrame(k);
					continue;
				}
				if (this.frozen.has(t)) continue;  // (drawn with the static props)
				const show = !!k && (this.shows(t, k) || (held.has(t) && t.model.endsWith('.mdl')));
				const o = show ? this.objectFor(t, k?.skin ?? 0, Number(k?.extra?.m_nBody ?? 0), k?.model ?? t.model) : this.objects.get(t);
				if (!o) continue;
				o.visible = show;
				if (show && k && t.className === 'CFuncBrush') this.brushFrame(o, Number(k.extra?.m_iTextureFrameIndex ?? 0) || 0);
				// a doorway's fade brush: drawn by the camera's distance (a closed
				// door's black backing; open doors fade it out)
				if (show && k && t.className === 'CFuncAreaPortalWindow') o.visible = this.portalWindowBlend(o, k) >= 0.5;
				if (show && k && WORLD_SPACE.has(t.className)) {
					this.placeEffect(t, k, o, time, tick);
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
					}
					let feetYaw: number | null = null;
					if (anim && !k.anim && t.className === 'CPortal_Player') {
						const a = this.playerAnim(t, tick, o.userData.skeleton);
						anim.setPose(a.seq, a.cycle, a.params, a.gestures);
						feetYaw = a.feetYaw;
					}
					// between network updates, moving things are interpolated
					const pose = this.entityPose(t, tick);
					o.position.copy(pose.origin);
					// players face where their feet point (see playerMotion) and don't tilt
					o.rotation.copy(toEuler(t.className === 'CPortal_Player' ? [0, feetYaw ?? pose.angles[1], 0] : pose.angles));
					if (o.userData.portalSurface) {
						const e = k.extra ?? {};
						const surface = o.userData.portalSurface as THREE.Mesh;
						const halfW = Number(e.m_fNetworkHalfWidth) || PORTAL_HALF_W, halfH = Number(e.m_fNetworkHalfHeight) || PORTAL_HALF_H;
						// the quad reaches 7.5% past the opening, for the flames
						surface.scale.set(halfW * 1.075, halfH * 1.075, 1);
						const u = (surface.material as THREE.ShaderMaterial).uniforms;
						u.time.value = time;
						u.exposure.value = this.exposure;
						// opens over a tenth of a second from where it was placed (as
						// the game's renders show: full within about six ticks)
						u.open.value = (tick - this.portalPlacedAt(t, tick)) * this.interval * 10;
						const link = Number(e.m_hLinkedPortal ?? -1) & 2047;
						u.staticAmount.value = this.portalStatic(t, tick, link);
						this.portals.set(t.index, {obj: o, link, halfW, halfH});
					}
				}
			}
		}

		let ambient: [number, number, number] = [this.extraAmbient, this.extraAmbient, this.extraAmbient];
		for (const a of this.ambientLight) if (a.tick <= tick) ambient = a.rgb;
		modelAmbientUniforms.modelAmbient.value.set(...ambient);
		if (ents) this.placeAttached(tick);
		if (ents) this.updateTurretLasers(tick);
		if (ents) this.updatePaintBlobs(tick);
		if (ents) this.updateRopes(tick);
		if (ents) this.updateMovies(tick);

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
			this.viewEntity = this.mode === 'eyes' && !other ? this.viewEntityMatrix(pk, tick) : null;
			if (this.viewEntity) {
				// a camera the view's been handed to (point_viewcontrol):
				// Source's forward is its x axis, up its z
				const m = this.viewEntity;
				const fwd = new THREE.Vector3().setFromMatrixColumn(m, 0).normalize(), up = new THREE.Vector3().setFromMatrixColumn(m, 2).normalize();
				this.camera.position.setFromMatrixPosition(m);
				this.camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fwd.clone().cross(up), up, fwd.negate()));
			} else if (this.mode === 'eyes') {
				const ang = otherPose ? otherPose.angles : view?.angles ?? pk?.angles ?? [0, 0, 0];
				this.eyeAngles = ang;
				this.camera.position.copy(eye);
				// with roll: the view comes out of a portal tilted and rights itself
				const q = new THREE.Quaternion().setFromEuler(toEuler(ang as Vec3));
				const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q), up = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
				const right = fwd.clone().cross(up);
				this.camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd.negate()));
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
		this.updateFlashlight(tick);
		this.lightModels();
		this.render();
	}

	// The projected spotlight lighting the view: the active
	// env_projectedtexture nearest the camera, with a shadow map from it
	// (redrawn when the tick or the light changes; glass and effects don't cast)
	private flashCam = new THREE.PerspectiveCamera(90, 1, 4, 2000);
	private flashTarget: THREE.WebGLRenderTarget | null = null;
	// (with the engine's shadow map depth bias: mat_slopescaledepthbias_shadowmap
	// 3, mat_depthbias_shadowmap 0.000025 = ~420 steps of a 24-bit depth)
	private flashDepthMaterial = new THREE.MeshBasicMaterial({colorWrite: false, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 420});
	private flashDepthAlphas = new WeakMap<THREE.Material, THREE.MeshBasicMaterial>();
	private flashDepthAlpha(m: THREE.Material): THREE.MeshBasicMaterial {
		const map = (m as THREE.MeshBasicMaterial).map;
		let d = this.flashDepthAlphas.get(m);
		if (!d || d.map !== map) {
			d?.dispose();
			d = this.flashDepthMaterial.clone();
			d.map = map;
			d.alphaTest = m.alphaTest;
			d.side = m.side;
			this.flashDepthAlphas.set(m, d);
		}
		return d;
	}
	private flashKey = '';
	// the shadow map, made up front: the shaders' shadow sampler needs a
	// comparing depth texture bound even while no light casts (the draw
	// fails otherwise)
	private ensureFlashTarget() {
		const r = this.renderer;
		if (this.flashTarget || !r) return;
		const size = 1024;
		this.flashTarget = new THREE.WebGLRenderTarget(size, size, {depthBuffer: true});
		this.flashTarget.depthTexture = new THREE.DepthTexture(size, size);
		// (compared in the sampler, filtered: hardware PCF)
		this.flashTarget.depthTexture.compareFunction = THREE.LessEqualCompare;
		this.flashTarget.depthTexture.minFilter = this.flashTarget.depthTexture.magFilter = THREE.LinearFilter;
		flashUniforms.flashDepth.value = this.flashTarget.depthTexture;
		flashUniforms.flashTexel.value = 1 / size;
		// (three only makes a depth texture when it's drawn into: cleared once,
		// to the far plane, so it's there and lets all light through)
		const target = r.getRenderTarget();
		r.setRenderTarget(this.flashTarget);
		r.clear();
		r.setRenderTarget(target);
	}
	private flashCookieName = '';
	private updateFlashlight(tick: number) {
		const ents = this.entities, r = this.renderer;
		const u = flashUniforms;
		this.ensureFlashTarget();
		// (where it is in the world: lights are often parented, like
		// Wheatley's flashlight)
		let best: {k: EntityKey; d: number; m: THREE.Matrix4} | null = null;
		const cam = this.camera.position;
		for (const t of ents?.tracks ?? []) {
			if (t.className !== 'CEnvProjectedTexture') continue;
			const k = keyAt(t, Math.floor(tick));
			if (!k || k.removed || Number(k.extra?.m_bState ?? 0) !== 1) continue;
			const m = this.worldMatrix(t, k, tick, 0);
			if (!m) continue;
			const d = cam.distanceTo(new THREE.Vector3().setFromMatrixPosition(m));
			if (!best || d < best.d) best = {k, d, m};
		}
		if (!best || !r || !this.library) {
			u.flashOn.value = 0;
			return;
		}
		const k = best.k, e = k.extra ?? {};
		// the cookie (loaded once; dark until it is)
		const cookie = String(e.m_SpotlightTextureName ?? 'effects/flashlight001').toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');
		if (cookie !== this.flashCookieName) {
			this.flashCookieName = cookie;
			u.flashCookie.value = null;
			this.library.textures.get(cookie).then(t => {
				if (this.flashCookieName !== cookie) return;
				u.flashCookie.value = t;
				this.loaded();
			});
		}
		if (!u.flashCookie.value) {
			u.flashOn.value = 0;
			return;
		}
		// colour: rgb / 255 x alpha / 255, times r_flashlightbrightness
		// (0.25), the x2.5 the engine adds where the flashlight is added in
		// linear space (sRGB-correct blending: any current card), and the
		// brightness scale; in the lightmaps' units (LIGHTMAP_EXPOSURE)
		const c = Number(e.m_LightColor ?? 0xffffffff) >>> 0;
		const scale = ((c >>> 24) & 255) / 255 * 0.25 * 2.5 * LIGHTMAP_EXPOSURE * Number(e.m_flBrightnessScale ?? 1);
		u.flashColor.value.set((c & 255) / 255 * scale, ((c >>> 8) & 255) / 255 * scale, ((c >>> 16) & 255) / 255 * scale);
		const near = Number(e.m_flNearZ ?? 4) || 4, far = Number(e.m_flFarZ ?? 2000) || 2000;
		const fc = this.flashCam;
		fc.fov = Number(e.m_flLightFOV ?? 90) || 90;
		fc.near = near;
		fc.far = far;
		fc.updateProjectionMatrix();
		// Source's basis: x forward, y left, z up
		const fwd = new THREE.Vector3(), left = new THREE.Vector3(), up = new THREE.Vector3();
		best.m.extractBasis(fwd, left, up);
		fwd.normalize();
		up.normalize();
		fc.position.setFromMatrixPosition(best.m);
		fc.up.copy(up);
		fc.lookAt(fc.position.clone().add(fwd));
		fc.updateMatrixWorld();
		u.flashPos.value.copy(fc.position);
		u.flashMatrix.value.multiplyMatrices(fc.projectionMatrix, fc.matrixWorldInverse);
		u.flashFar.value = far;
		u.flashShadows.value = Number(e.m_bEnableShadows ?? 1) === 1 ? 1 : 0;
		u.flashOn.value = 1;
		const key = `${Math.floor(tick)}|${fc.position.toArray().join(',')}|${fwd.toArray().join(',')}|${fc.fov}`;
		if (!u.flashShadows.value || key === this.flashKey) return;
		this.flashKey = key;
		this.ensureFlashTarget();
		// what casts: the solid scene (not the sky, effects, overlays, glass)
		const hidden: THREE.Object3D[] = [];
		const hide = (o: THREE.Object3D | null | undefined) => {
			if (o && o.visible) {
				o.visible = false;
				hidden.push(o);
			}
		};
		hide(this.sky);
		hide(this.pathLine);
		hide(this.player);
		hide(this.particleRenderer?.group);
		this.scene.traverseVisible(o => {
			const m = (o as THREE.Mesh).material as THREE.Material | undefined;
			if (m && !Array.isArray(m) && (m.transparent || (m as THREE.ShaderMaterial).isShaderMaterial)) hide(o);
		});
		// (alpha-tested ones, like grates, cast through their holes)
		const swapped: [THREE.Mesh, THREE.Material][] = [];
		this.scene.traverseVisible(o => {
			const mesh = o as THREE.Mesh, m = mesh.material as THREE.Material | undefined;
			if (!mesh.isMesh || !m || Array.isArray(m)) return;
			swapped.push([mesh, m]);
			mesh.material = m.alphaTest > 0 && (m as THREE.MeshBasicMaterial).map ? this.flashDepthAlpha(m) : this.flashDepthMaterial;
		});
		const target = r.getRenderTarget(), fog = this.scene.fog, bg = this.scene.background;
		this.scene.fog = null;
		this.scene.background = null;
		r.setRenderTarget(this.flashTarget);
		r.clear();
		this.cullFrom(fc.position);
		r.render(this.scene, fc);
		this.uncull();
		for (const [mesh, m] of swapped) mesh.material = m;
		this.scene.fog = fog;
		this.scene.background = bg;
		for (const o of hidden) o.visible = true;
		// ropes cast too, with their own shader (their strips are turned to
		// face the light in it)
		if (this.ropes) {
			const auto = r.autoClear;
			r.autoClear = false;
			r.render(this.ropes.group, fc);
			r.autoClear = auto;
		}
		r.setRenderTarget(target);
	}

	private frame: THREE.WebGLRenderTarget | null = null;
	private compileNeeded = true;
	private recheck: (() => void) | undefined;
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
		uniforms: {frame: {value: null}, exposure: {value: 1}, bloom: {value: null}, bloomAmount: {value: 0}, fade: {value: new THREE.Vector4()}, fadeModulate: {value: 0}},
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
			uniform sampler2D bloom;
			uniform float bloomAmount;
			uniform vec4 fade;
			uniform float fadeModulate;
			varying vec2 vUv;
			${ENCODE}
			void main() {
				vec3 c = encode(texture2D(frame, vUv).rgb, exposure);
				// (engine_post: half the bloom buffer, added in gamma space)
				c += bloomAmount * 0.5 * texture2D(bloom, vUv).rgb;
				// the screen fade over it (or multiplying it)
				c = fadeModulate > 0.5 ? c * mix(vec3(1.0), fade.rgb, fade.a) : mix(c, fade.rgb, fade.a);
				gl_FragColor = vec4(c, 1.0);
			}`,
	});
	private bloom = new Bloom();
	// mat_bloomscale, or the tonemap controller's custom bloom scale
	private bloomScale = 1;
	// debugging: a bloom scale used instead of the map's
	bloomOverride: number | null = null;
	// The screen fades the server sent the recording player, as the client's
	// view effects run them: a fade in holds the colour, then lifts it over
	// its duration; a fade out brings it on over its duration, then holds;
	// spent ones go unless they stay out; a purge clears the earlier ones.
	// Together: the highest alpha, the colours averaged.
	private screenFade(tick: number) {
		const f = this.fadeAt(tick);
		const u = this.composite.uniforms;
		u.fade.value.set(f.rgb[0], f.rgb[1], f.rgb[2], f.alpha);
		u.fadeModulate.value = f.modulate ? 1 : 0;
	}
	private fadeAt(tick: number): {rgb: number[]; alpha: number; modulate: boolean} {
		const none = {rgb: [0, 0, 0], alpha: 0, modulate: false};
		const fades = this.entities?.fades;
		if (!fades?.length || this.mode !== 'eyes' || this.followed) return none;
		const now = tick * this.interval;
		let active: {f: ScreenFade; speed: number; end: number; reset: number}[] = [];
		// a bare purge first (instant, opaque, fading in: co-op starts) lifts a
		// fade that stayed out from before the recording began; the game's
		// frames stay black a little longer, then come in (measured on
		// autorender's: 0.55 s, then 0.35 s)
		const first = fades[0];
		if (first.tick > 0 && first.flags === 17 && !first.duration && !first.hold && first.color[3] === 255) {
			const since = (tick - first.tick) * this.interval;
			if (since < 0.9) return {rgb: first.color.slice(0, 3).map(v => v / 255), alpha: Math.min(1, Math.max(0, (0.9 - since) / 0.35)), modulate: false};
		}
		for (const f of fades) {
			if (f.tick > tick) break;
			if (f.flags & 16) active = [];
			const t0 = f.tick * this.interval, alpha = f.color[3];
			let speed = 0, end: number, reset: number;
			if (f.flags & 2) {
				if (f.duration) speed = -alpha / f.duration;
				end = t0 + f.duration;
				reset = end + f.hold;
			} else {
				if (f.duration) speed = alpha / f.duration;
				reset = t0 + f.hold;
				end = reset + f.duration;
			}
			active.push({f, speed, end, reset});
		}
		active = active.filter(a => !(now > a.reset && now > a.end) || (a.f.flags & 8));
		if (!active.length) return none;
		let alpha = 0, modulate = false;
		const rgb = [0, 0, 0];
		for (const {f, speed, end} of active) {
			let a = speed * (end - now);
			if (f.flags & 2) a += f.color[3];
			alpha = Math.max(alpha, Math.min(f.color[3], Math.max(0, a)));
			for (let i = 0; i < 3; i++) rgb[i] += f.color[i];
			if (f.flags & 4) modulate = true;
		}
		return {rgb: rgb.map(v => v / active.length / 255), alpha: alpha / 255, modulate};
	}
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
		// (a snapshot waits for every shader instead of leaving things out)
		const waiting = this.capturing ? [] : this.notReady(r);
		for (const o of waiting) o.visible = false;
		if (this.bsp) {
			if (!this.skyCamera) this.sky.position.copy(this.camera.position);
			// (not metered while anything sits out: it'd read too dark)
			this.meterExposure(r, waiting.length === 0);
			this.updateFog();
		}
		this.renderMonitorCamera(r);
		this.updateSprites(this.meterTick);
		this.particleRenderer?.draw(this.particlesShown, this.camera);
		this.vmParticleRenderer?.draw(this.vmParticlesShown, this.camera);
		this.updateParticleBlobs();
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
		if (waiting.length && !this.recheck) this.recheck = later(() => {
			this.recheck = undefined;
			this.onLoaded();
		}, 30);
		r.setRenderTarget(null);
		this.composite.uniforms.bloom.value = this.bloom.render(r, this.frame, this.exposure);
		this.composite.uniforms.bloomAmount.value = this.bloomOverride ?? this.bloomScale;
		r.setRenderTarget(null);
		this.composite.uniforms.frame.value = this.frame.texture;
		this.composite.uniforms.exposure.value = this.exposure;
		this.screenFade(this.meterTick);
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

	// overlays an info_overlay_accessor names, by overlay id: the frame of
	// their texture follows its m_iTextureFrameIndex
	private accessedOverlays = new Map<number, {mesh: THREE.Mesh; group: MaterialGroup}>();
	private overlayFrame(k: EntityKey | undefined) {
		const o = k?.extra ? this.accessedOverlays.get(Number(k.extra.m_iOverlayID)) : undefined;
		if (o) o.mesh.material = this.library!.forOverlay(o.group, Number(k!.extra!.m_iTextureFrameIndex ?? 0) || 0);
	}

	private waterMeshes: THREE.Mesh[] = [];
	private waterTargets = new Map<number, THREE.WebGLRenderTarget>();
	private waterCam = new THREE.PerspectiveCamera();

	// what the water surfaces in view reflect ($reflecttexture): the view
	// mirrored in each one's plane, clipped to above it, at half size;
	// entities too, as autorender forces (r_waterforcereflectentities 1, over
	// the materials' $reflectonlymarkedentities; and $reflectskyboxonly: the
	// sky alone isn't drawn apart)
	private renderWaterReflections(r: THREE.WebGLRenderer) {
		if (!this.waterMeshes.length) return;
		const cam = this.camera;
		cam.updateMatrixWorld();
		const at = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
		const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
		const vis = this.bsp?.vis;
		const set = vis?.visibleFrom(vis.clusterAt([at.x, at.y, at.z]));
		const planes = new Map<number, THREE.Mesh[]>();
		for (const m of this.waterMeshes) {
			const w = (m.material as THREE.Material).userData.water as WaterParams | undefined;
			const h = m.userData.waterHeight as number;
			if (w?.reflect !== 'planar' || !w.aboveWater || at.z <= h || !frustum.intersectsObject(m)) continue;
			if (set && !anyVisible(set, m.userData.clusters as number[])) continue;
			let list = planes.get(h);
			if (!list) planes.set(h, list = []);
			list.push(m);
		}
		// (the camera's right and forward along the surface bend the reflection)
		const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).setZ(0).normalize();
		waterUniforms.waterRight.value.copy(right);
		waterUniforms.waterForward.value.crossVectors(new THREE.Vector3(0, 0, 1), right);
		for (const [h, rt] of this.waterTargets) {
			if (planes.has(h)) continue;
			rt.dispose();
			this.waterTargets.delete(h);
		}
		if (!planes.size) return;

		const frameTarget = r.getRenderTarget();
		const size = r.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(0.5).floor();
		const hidden = ([this.player, this.pathLine, ...this.waterMeshes] as (THREE.Object3D | null | undefined)[])
			.filter((o): o is THREE.Object3D => !!o && o.visible);
		for (const o of hidden) o.visible = false;
		const dither = ditherUniforms.ditherOn.value;
		ditherUniforms.ditherOn.value = 0;
		const forward = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
		const up = new THREE.Vector3(0, 1, 0).transformDirection(cam.matrixWorld);
		const mirror = this.waterCam;
		for (const [h, meshes] of planes) {
			let rt = this.waterTargets.get(h);
			if (!rt) {
				rt = new THREE.WebGLRenderTarget(size.x, size.y, {type: THREE.HalfFloatType, stencilBuffer: true});
				this.waterTargets.set(h, rt);
			}
			if (rt.width !== size.x || rt.height !== size.y) rt.setSize(size.x, size.y);
			// the camera mirrored in the plane
			mirror.fov = cam.fov;
			mirror.aspect = cam.aspect;
			mirror.near = cam.near;
			mirror.far = cam.far;
			mirror.updateProjectionMatrix();
			mirror.position.set(at.x, at.y, 2 * h - at.z);
			mirror.up.set(up.x, up.y, -up.z);
			mirror.lookAt(mirror.position.x + forward.x, mirror.position.y + forward.y, mirror.position.z - forward.z);
			mirror.updateMatrixWorld();
			this.sky.position.copy(mirror.position);
			r.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), -h)];
			r.setRenderTarget(rt);
			this.cullFrom(at);
			r.render(this.scene, mirror);
			this.uncull();
			r.clippingPlanes = [];
			// (where a point lands in the reflection: its texture coordinates)
			const project = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
				.multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
			for (const m of meshes) {
				const u = (m.material as THREE.Material).userData.waterUniforms as ReturnType<typeof waterMaterialUniforms>;
				u.waterReflect.value = rt.texture;
				u.waterReflectMatrix.value.copy(project);
			}
		}
		r.setRenderTarget(frameTarget);
		ditherUniforms.ditherOn.value = dither;
		for (const o of hidden) o.visible = true;
	}

	// what's below the water surfaces in view that show it ($refracttexture):
	// the view clipped to under each one's plane, at half size, with its
	// depth (the shader fogs it by how much water the view goes through)
	private refractTargets = new Map<number, THREE.WebGLRenderTarget>();
	private renderWaterRefractions(r: THREE.WebGLRenderer) {
		const cam = this.camera;
		const at = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
		const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
		const vis = this.bsp?.vis;
		const set = vis?.visibleFrom(vis.clusterAt([at.x, at.y, at.z]));
		const planes = new Map<number, THREE.Mesh[]>();
		for (const m of this.waterMeshes) {
			const w = (m.material as THREE.Material).userData.water as WaterParams | undefined;
			const u = (m.material as THREE.Material).userData.waterUniforms as ReturnType<typeof waterMaterialUniforms> | undefined;
			if (u) u.waterRefractParams.value.w = 0;
			const h = m.userData.waterHeight as number;
			if (!w?.refract || !w.aboveWater || at.z <= h || !frustum.intersectsObject(m)) continue;
			if (set && !anyVisible(set, m.userData.clusters as number[])) continue;
			let list = planes.get(h);
			if (!list) planes.set(h, list = []);
			list.push(m);
		}
		for (const [h, rt] of this.refractTargets) {
			if (planes.has(h)) continue;
			rt.depthTexture?.dispose();
			rt.dispose();
			this.refractTargets.delete(h);
		}
		if (!planes.size) return;

		const frameTarget = r.getRenderTarget();
		const size = r.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(0.5).floor();
		const hidden = ([this.player, this.pathLine, ...this.waterMeshes] as (THREE.Object3D | null | undefined)[])
			.filter((o): o is THREE.Object3D => !!o && o.visible);
		for (const o of hidden) o.visible = false;
		const dither = ditherUniforms.ditherOn.value;
		ditherUniforms.ditherOn.value = 0;
		this.sky.position.copy(at);
		// (where a point lands in the texture, and back: the view's own)
		const viewProj = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
		const project = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(viewProj);
		const inverse = viewProj.clone().invert();
		for (const [h, meshes] of planes) {
			let rt = this.refractTargets.get(h);
			if (!rt) {
				const depth = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedInt248Type);
				depth.format = THREE.DepthStencilFormat;
				rt = new THREE.WebGLRenderTarget(size.x, size.y, {type: THREE.HalfFloatType, stencilBuffer: true, depthTexture: depth});
				this.refractTargets.set(h, rt);
			}
			if (rt.width !== size.x || rt.height !== size.y) rt.setSize(size.x, size.y);
			// (a little above the surface too, as the engine's, so its edge has no gap)
			r.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), h + 2)];
			r.setRenderTarget(rt);
			this.cullFrom(at);
			r.render(this.scene, cam);
			this.uncull();
			r.clippingPlanes = [];
			for (const m of meshes) {
				const u = (m.material as THREE.Material).userData.waterUniforms as ReturnType<typeof waterMaterialUniforms>;
				u.waterRefract.value = rt.texture;
				u.waterRefractDepth.value = rt.depthTexture;
				u.waterRefractMatrix.value.copy(project);
				u.waterRefractInverse.value.copy(inverse);
				u.waterRefractParams.value.w = 1;
			}
		}
		r.setRenderTarget(frameTarget);
		ditherUniforms.ditherOn.value = dither;
		for (const o of hidden) o.visible = true;
	}

	private renderScene(r: THREE.WebGLRenderer) {
		if (this.portals.size) this.renderPortalViews(r);
		this.renderWaterReflections(r);
		if (this.waterMeshes.length) this.renderWaterRefractions(r);
		// the sky stays centred on the camera, inside the far plane
		this.sky.scale.setScalar(this.camera.far * 0.5);
		const sc = this.skyCamera;
		if (!sc) {
			this.sky.position.copy(this.camera.position);
			this.cullFrom(this.camera.position);
			r.render(this.scene, this.camera);
			this.uncull();
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
		this.cullFrom(this.skyView.position);
		r.render(this.scene, this.skyView);
		ditherUniforms.ditherOn.value = dither;
		for (const o of hidden) o.visible = true;

		r.clearDepth();
		this.sky.visible = false;
		this.scene.fog = this.worldFog;
		this.cullFrom(this.camera.position);
		r.render(this.scene, this.camera);
		this.uncull();
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
		this.capturing = true;
		this.render();
		this.capturing = false;
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
		// (the nearest shown: rays find hidden objects too)
		const shown = (o: THREE.Object3D | null): boolean => !o || (o.visible && shown(o.parent));
		const hit = ray.intersectObjects([this.mapGroup, this.propGroup, this.entityGroup], true).find(h => shown(h.object));
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

// one triangle soup of the world's solid faces (not glass or liquids), or
// its glass or its liquids alone, with a BVH, for ray tests
function worldCollision(m: ModelMesh, only?: 'glass' | 'liquid'): MeshBVH | null {
	const solid = m.groups.filter(g => only ? g.surface === only : g.surface !== 'glass' && g.surface !== 'liquid');
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
		if (!mesh.isMesh && !(o as THREE.Line).isLine) return;
		if (!mesh.geometry.userData.shared) mesh.geometry.dispose();
		for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
			// its own lit copies and effect materials (with the texture copies
			// they made); the library's shared ones stay
			const effect = (m as THREE.ShaderMaterial).isShaderMaterial || m.userData.effect;
			if (!mesh.userData.ambHooked && !effect) continue;
			const textures = [(m as THREE.MeshBasicMaterial).map, ...Object.values((m as THREE.ShaderMaterial).uniforms ?? {}).map(u => u.value)];
			for (const t of textures) if ((t as THREE.Texture | null)?.isTexture && (t as THREE.Texture).userData.owned) (t as THREE.Texture).dispose();
			m.dispose();
		}
	});
}

// a stable seed from a run's key
function hashKey(key: string): number {
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
	return h >>> 0;
}
