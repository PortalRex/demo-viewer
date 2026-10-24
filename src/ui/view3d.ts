// 3D replay: the map's geometry from the viewer's own game files, with the
// recorded entities (portals, brush entities, props) and the player's view.
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import type {BspMap, MeshData} from '../game/bsp.ts';
import type {GameFiles} from '../game/files.ts';
import {loadModel} from '../game/mdl.ts';
import type {StudioModel} from '../game/mdl.ts';
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
	'CPortal_Player', 'CWeaponPortalgun', 'CPredictedViewModel', 'CBaseViewModel', 'CFuncPortalBumper', 'CFuncNoPortalVolume',
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
	return g;
}

export class View3D {
	readonly container: HTMLElement;
	mode: CameraMode = 'eyes';
	private renderer: THREE.WebGLRenderer | null = null;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(VERTICAL_FOV, 1, 1, 40000);
	private controls: OrbitControls | null = null;
	private solidMat = new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.FrontSide});
	private glassMat = new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.3, depthWrite: false});
	private mapGroup = new THREE.Group();
	private entityGroup = new THREE.Group();
	private pathLine: THREE.LineSegments | null = null;
	private player: THREE.Mesh;
	private bsp: BspMap | null = null;
	private entities: EntityTimeline | null = null;
	private objects = new Map<EntityTrack, THREE.Object3D>();
	private lastTarget: THREE.Vector3 | null = null;
	private propGroup = new THREE.Group();
	private propMat = new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide});
	private files: GameFiles | null = null;
	private models = new Map<string, Promise<THREE.BufferGeometry | null>>();
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

	// a model's geometry, loaded once per map (maps can carry their own models)
	private model(name: string): Promise<THREE.BufferGeometry | null> {
		const key = name.toLowerCase();
		let p = this.models.get(key);
		if (!p) {
			const files = this.files;
			const color: [number, number, number] = /cube|box/.test(key) ? [0.66, 0.73, 0.8] : [0.52, 0.52, 0.5];
			p = files ? loadModel(files, key, color).then((m: StudioModel | null) => (m ? geometry(m.mesh) : null)).catch(() => null) : Promise.resolve(null);
			this.models.set(key, p);
		}
		return p;
	}

	setMap(bsp: BspMap | null, files: GameFiles | null = null) {
		this.bsp = bsp;
		this.files = files;
		this.models.clear();
		this.mapGroup.clear();
		this.propGroup.clear();
		this.clearEntities();
		const token = ++this.mapToken;
		if (!bsp) return;
		// static props, as they load
		for (const prop of bsp.staticProps) {
			this.model(prop.model).then(g => {
				if (!g || token !== this.mapToken) return;
				const mesh = new THREE.Mesh(g, this.propMat);
				mesh.position.set(...prop.origin);
				mesh.rotation.copy(toEuler(prop.angles));
				mesh.matrixAutoUpdate = false;
				mesh.updateMatrix();
				this.propGroup.add(mesh);
				this.onLoaded();
			});
		}
		const world = bsp.models[0];
		this.mapGroup.add(new THREE.Mesh(geometry(world.solid), this.solidMat));
		this.mapGroup.add(this.outline(world.edges));
		if (world.translucent.positions.length) {
			const glass = new THREE.Mesh(geometry(world.translucent), this.glassMat);
			glass.renderOrder = 1;
			this.mapGroup.add(glass);
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

	private edgeMat = new THREE.LineBasicMaterial({color: 0x000000, transparent: true, opacity: 0.2});

	private outline(edges: Float32Array) {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(edges, 3));
		return new THREE.LineSegments(g, this.edgeMat);
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
			if (!m || !m.solid.positions.length) return null;
			const group = new THREE.Group();
			group.add(new THREE.Mesh(geometry(m.solid), this.solidMat));
			group.add(this.outline(m.edges));
			if (m.translucent.positions.length) group.add(new THREE.Mesh(geometry(m.translucent), this.glassMat));
			return group;
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
		this.model(t.model).then(g => {
			if (!g) return;
			group.remove(box);
			group.add(new THREE.Mesh(g, this.propMat));
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
					o.rotation.copy(toEuler(k.angles));
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
}
