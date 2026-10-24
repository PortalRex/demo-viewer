// 3D replay: the map's geometry from the viewer's own game files, with the
// recorded entities (portals, brush entities, props) and the player's view.
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import type {BspMap, MeshData, MaterialGroup, ModelMesh} from '../game/bsp.ts';
import type {GameFiles} from '../game/files.ts';
import type {Materials, MaterialInfo} from '../game/materials.ts';
import {loadModel} from '../game/mdl.ts';
import type {StudioModel} from '../game/mdl.ts';
import {TextureCache} from './textures.ts';
import type {EntityTimeline, EntityTrack} from '../net/entities.ts';
import {keyAt} from '../net/entities.ts';
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
	'CBaseEntity', 'CProp_Portal', 'CLightGlow', 'CSlideshowDisplay', 'CTriggerPortalCleanser',
]);

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
	private materials: Materials;
	private textures: TextureCache;
	private lightmap: THREE.Texture | null;
	private world = new Map<string, THREE.Material>();
	private model = new Map<string, THREE.Material>();
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
		if (!info.baseTexture) return;
		this.textures.get(info.baseTexture).then(tex => {
			if (!tex) return;
			mat.map = tex;
			mat.vertexColors = false;
			mat.color.setRGB(...info.color);
			mat.needsUpdate = true;
			this.onChange();
		});
	}

	forWorld(group: MaterialGroup): THREE.Material {
		const cached = this.world.get(group.material);
		if (cached) return cached;
		const mat = new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.FrontSide});
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

	forModel(candidates: string[]): THREE.Material {
		const key = candidates.join('|');
		const cached = this.model.get(key);
		if (cached) return cached;
		const mat = new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide});
		this.model.set(key, mat);
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
	private files: GameFiles | null = null;
	private models = new Map<string, Promise<THREE.Object3D | null>>();
	private mapToken = 0;
	onLoaded = () => {};

	constructor(container: HTMLElement) {
		this.container = container;
		this.camera.up.set(0, 0, 1);
		this.scene.background = new THREE.Color(0x0c0e12);
		this.scene.fog = new THREE.Fog(0x0c0e12, 6000, 30000);
		const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3f48, 1.6);
		hemi.position.set(0, 0, 1);
		const sun = new THREE.DirectionalLight(0xffffff, 1.2);
		sun.position.set(0.35, 0.25, 1);
		this.scene.add(hemi, sun, this.mapGroup, this.propGroup, this.entityGroup);

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

	// a model (all its material groups), loaded once per map and skin;
	// returns a template to clone (maps can carry their own models)
	private model(name: string, skin = 0): Promise<THREE.Object3D | null> {
		const key = `${name.toLowerCase()}#${skin}`;
		let p = this.models.get(key);
		if (!p) {
			const files = this.files, library = this.library;
			const color: [number, number, number] = /cube|box/.test(key) ? [0.66, 0.73, 0.8] : [0.52, 0.52, 0.5];
			p = files && library
				? loadModel(files, name, color, skin).then((m: StudioModel | null) => {
					if (!m) return null;
					const group = new THREE.Group();
					for (const g of m.groups) {
						const mesh = new THREE.Mesh(geometry(g), library.forModel(g.materialCandidates));
						mesh.name = `${name} ${g.materialCandidates[0]}`;
						group.add(mesh);
					}
					return group;
				}).catch(() => null)
				: Promise.resolve(null);
			this.models.set(key, p);
		}
		return p;
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

		// static props, as they load
		for (const prop of bsp.staticProps) {
			this.model(prop.model, prop.skin).then(template => {
				if (!template || token !== this.mapToken) return;
				const o = template.clone();
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

	setSegment(track: SegmentTrack, entities: EntityTimeline | null) {
		this.entities = entities;
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
			const color = t.orange ? 0xff8a1f : 0x3f9bff;
			const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false}));
			const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 40), new THREE.MeshBasicMaterial({color, side: THREE.DoubleSide}));
			for (const m of [disc, ring]) {
				// circle in the XY plane, facing +Z -> facing the portal's forward (+X)
				m.rotation.y = Math.PI / 2;
				m.scale.set(PORTAL_HALF_H, PORTAL_HALF_W, 1);
				m.position.x = 0.6;
				group.add(m);
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
		// swap the box for the real model when it loads
		this.model(t.model).then(template => {
			if (!template) return;
			group.remove(box);
			group.add(template.clone());
			this.onLoaded();
		});
		return group;
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
			for (const t of ents.tracks) {
				const k = keyAt(t, tick);
				const show = !!k && k.visible && (t.className !== 'CProp_Portal' || k.active === true);
				const o = show ? this.objectFor(t) : this.objects.get(t);
				if (!o) continue;
				o.visible = show;
				if (show && k) {
					o.position.set(k.origin[0], k.origin[1], k.origin[2]);
					// players turn with their view but don't tilt
					o.rotation.copy(toEuler(t.className === 'CPortal_Player' ? [0, k.angles[1], 0] : k.angles));
				}
			}
		}

		// player: the decoded entity where there is one, else the recorded view
		const pk = ents?.player ? keyAt(ents.player, tick) : undefined;
		const feet = pk ? new THREE.Vector3(...pk.origin) : view ? new THREE.Vector3(...view.origin) : null;
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
		this.renderer?.render(this.scene, this.camera);
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
