// Recording the 3D view's scene for Blender: run frame by frame (as the
// video export does), then what was drawn is taken from three's scene graph
// — every mesh's geometry and material state once, and per frame where it
// is, whether it shows, its bones and its lighting — with the cameras and
// the frame-wide state (exposure, fog, fades). Materials are described by
// what the viewer's shaders do with them (see shaderhooks), not by their
// material files, so Blender's node trees can do the same.
import * as THREE from 'three';
import type {View3D} from '../ui/view3d.ts';
import type {GameFiles} from '../game/files.ts';
import {vtfLevel, vtfMips, decodeVtf, readVtfCube, VtfFormat} from '../game/vtf.ts';
import {encodePng, encodeExr, encodeDds, cubeToEquirect} from './encode.ts';
// (the shader-wide values the hooks share, set by the view each frame)
import {modelAmbientUniforms, fogUniforms, flashUniforms, paintUniforms} from '../ui/shaderhooks.ts';

// where the bundle's files go (a folder on disk, through the dev server or
// the browser's folder access)
export interface Sink {
	write(name: string, data: Uint8Array): Promise<void>;
	append(name: string, data: Uint8Array): Promise<void>;
}

type BinType = 'f64' | 'f32' | 'f16' | 'u32' | 'u16' | 'u8' | 'i32';
export interface BinView {offset: number; length: number; type: BinType}

// the bundle's binary blob (data.bin): pieces are added as they're made and
// written out now and then (flush), so a long recording isn't held in memory
class Bin {
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private written = 0;
	size = 0;
	add(a: Float64Array | Float32Array | Uint32Array | Uint16Array | Uint8Array | Int32Array, type?: BinType): BinView {
		type ??= a instanceof Float64Array ? 'f64' : a instanceof Float32Array ? 'f32' : a instanceof Uint32Array ? 'u32' : a instanceof Uint16Array ? 'u16' : a instanceof Int32Array ? 'i32' : 'u8';
		// (8-byte aligned for doubles)
		this.align();
		if (type === 'f64' && this.size % 8) this.push(new Uint8Array(4));
		const view = {offset: this.size, length: a.length, type};
		this.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength).slice());
		return view;
	}
	// (each piece 4-byte aligned, so numpy can view it in place)
	align() {
		const pad = (4 - (this.size % 4)) % 4;
		if (pad) this.push(new Uint8Array(pad));
	}
	push(bytes: Uint8Array) {
		this.pending.push(bytes);
		this.pendingBytes += bytes.length;
		this.size += bytes.length;
	}
	// what's waiting, onto the end of the file (the first write starts it)
	async flush(sink: Sink, atLeast = 0) {
		if (this.pendingBytes < atLeast || !this.pendingBytes) return;
		const out = new Uint8Array(this.pendingBytes);
		let o = 0;
		for (const p of this.pending) {
			out.set(p, o);
			o += p.length;
		}
		this.pending = [];
		this.pendingBytes = 0;
		await (this.written ? sink.append('data.bin', out) : sink.write('data.bin', out));
		this.written += out.length;
	}
}

// numbers as half floats (attributes that need no more: uvs, colours, normals)
function toHalf(a: Float32Array): Uint16Array {
	const out = new Uint16Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = THREE.DataUtils.toHalfFloat(a[i]);
	return out;
}

// A value recorded each frame, kept only where it changes: keys at each
// change and at the frame before it (so interpolating between keys holds
// still while it does)
class Track {
	readonly width: number;
	frames: number[] = [];
	values: number[] = [];
	private last: number[] | null = null;
	private lastFrame = -1;
	private lastKeyed = -1;
	constructor(width: number) {
		this.width = width;
	}
	push(frame: number, v: ArrayLike<number>, eps = 1e-5) {
		const last = this.last;
		let same = !!last;
		if (last) for (let i = 0; i < this.width; i++) if (Math.abs(last[i] - v[i]) > eps) {
			same = false;
			break;
		}
		if (!same) {
			if (last && this.lastKeyed < this.lastFrame) this.key(this.lastFrame, last);
			this.key(frame, v);
			this.last = Array.from(v);
		}
		this.lastFrame = frame;
	}
	private key(frame: number, v: ArrayLike<number>) {
		this.frames.push(frame);
		for (let i = 0; i < this.width; i++) this.values.push(v[i]);
		this.lastKeyed = frame;
	}
	get constant(): number[] | null {
		return this.frames.length === 1 ? this.values.slice(0, this.width) : null;
	}
	write(bin: Bin) {
		return {width: this.width, frames: bin.add(new Uint32Array(this.frames)), values: bin.add(new Float32Array(this.values))};
	}
}

// a matrix as location, rotation (w x y z, kept on the same side as the
// last one for smooth interpolation) and scale
const tmpPos = new THREE.Vector3(), tmpQuat = new THREE.Quaternion(), tmpScale = new THREE.Vector3();
function decompose(m: THREE.Matrix4, prev: number[] | null): number[] {
	m.decompose(tmpPos, tmpQuat, tmpScale);
	let q = [tmpQuat.w, tmpQuat.x, tmpQuat.y, tmpQuat.z];
	if (prev && prev[3] * q[0] + prev[4] * q[1] + prev[5] * q[2] + prev[6] * q[3] < 0) q = q.map(v => -v);
	return [tmpPos.x, tmpPos.y, tmpPos.z, ...q, tmpScale.x, tmpScale.y, tmpScale.z];
}

interface TextureRec {
	id: number;
	file: string;
	colorspace: 'srgb' | 'linear';
	alpha: boolean;
	// how it's made at the end
	make: () => Promise<{data: Uint8Array; ext: string; width: number; height: number; alpha: boolean} | null>;
	// a texture drawn in the page that changes (movie screens, gel): a picture
	// each time it does, textures/<name>/0001.png on, and the frames each
	// starts showing at (frame, picture index)
	live?: {texture: THREE.Texture; version: number; count: number; keys: number[]; lastFrame: number; every: number};
}

interface ObjectRec {
	id: number;
	name: string;
	scene: Layer;
	group: Group;
	geometry: number;
	material: number;
	skeleton?: number;
	lit: boolean;  // lit per object (ambient cube and lights)
	visible: Track;
	transform: Track;
	lighting?: Track;
	cube?: Track;  // which cubemap its reflection uses (-1: none)
	uniforms?: UniformTrack;
	portal?: Track;  // a portal's way through: world to its partner's side (3 x 4, rows), and 1 when linked
	lastXf: number[] | null;
}

// a shader material's numeric uniforms, each frame (those that change are
// keyframed in Blender)
interface UniformTrack {
	layout: [string, number][];
	track: Track;
}

// Geometry remade every frame (particles, sprites, beams, ropes): each
// different state kept once, in world space, with the frames it's shown
// [from, to). Each state is one block in data.bin: its attributes one after
// another, in `layout` order (positions as floats, the rest half floats).
// Particles are quads: four corners each rather than two triangles' six.
interface DynamicRec {
	id: number;
	name: string;
	scene: Layer;
	group: Group;
	material: number;
	layout: [string, number, BinType][];  // name, size, type
	quads: boolean;
	spans: number[];  // from, to, first vertex, vertex count, block offset
	vertices: number;
	lastSig: string;
	uniforms?: UniformTrack;
}

// which picture an object's drawn in: the world, over the world without
// depth ($ignorez glows), or the view model's (drawn over all of it)
type Layer = 'main' | 'overlay' | 'vm';

// what an object belongs to in the view: the map (world brushes, overlays),
// the static props, the entities, or effects (particles, sprites, ropes);
// the 3D skybox is drawn with the map and props only
type Group = 'map' | 'props' | 'entities' | 'effects';

// uniforms the whole frame shares (Blender's P2 Globals has them)
const SHARED_UNIFORMS = new Set(['sceneExposure', 'exposure', 'fogMaxDensity', 'resolution']);

interface SkeletonRec {
	id: number;
	skeleton: THREE.Skeleton;
	pose: Track;  // every bone's location, rotation, scale
	lastPose: number[] | null;
	frame: number;  // last frame captured (shared by its meshes)
}

const HALF = THREE.HalfFloatType;

export interface CaptureInfo {
	demo: string;
	map: string;
	fps: number;
	startTick: number;
	tickInterval: number;
	ticksPerFrame: number;
	width: number;
	height: number;
}

export class BlenderCapture {
	// (the view's own objects: reached past TypeScript's private, as the
	// dev hooks do)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private view: Record<string, any>;
	private sink: Sink;
	private bin = new Bin();
	private textures = new Map<string, TextureRec>();
	private texList: TextureRec[] = [];
	private geometries = new Map<THREE.BufferGeometry, number>();
	private geoList: unknown[] = [];
	private materials = new Map<string, number>();
	private matOf = new Map<THREE.Material, number>();
	private matList: unknown[] = [];
	private objects = new Map<THREE.Object3D, ObjectRec>();
	private objList: ObjectRec[] = [];
	private skeletons = new Map<THREE.Skeleton, SkeletonRec>();
	private skelList: SkeletonRec[] = [];
	private cubePaths = new Map<THREE.CubeTexture, string>();
	private geoSigs = new WeakMap<THREE.BufferGeometry, string>();
	private dynamicGeos = new WeakSet<THREE.BufferGeometry>();
	private meshGeo = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();
	private dynamicMeshes = new WeakSet<THREE.Mesh>();
	private dyns = new Map<THREE.Mesh, DynamicRec>();
	private dynList: DynamicRec[] = [];
	private camera = new Track(10 + 3);
	private vmCamera = new Track(10 + 3);
	private skyCamera = new Track(10 + 3);
	private globals = new Track(10);  // (see finish: globals.layout)
	private fog = new Track(6);
	// the projected light (env_projectedtexture): on, position, rotation,
	// fov, near, far, colour, shadows; and its cookie
	private flash = new Track(15);
	private flashCookie: number | null = null;
	// the gel (its map, in light map coordinates, changes as it's painted)
	private paint: {map: number | null; splat: number | null; tiles: number[]} | null = null;
	private frames = 0;
	private unsupported = new Map<string, number>();
	private files: GameFiles;
	readonly info: CaptureInfo;

	constructor(view: View3D, sink: Sink, info: CaptureInfo) {
		this.view = view as unknown as Record<string, any>;
		this.sink = sink;
		this.info = info;
		this.files = this.view.files as GameFiles;
	}

	// what the material library's cubemaps are, by their texture
	async prepare() {
		const lib = this.view.library;
		if (!lib) return;
		for (const [path, p] of (lib.cubes as Map<string, Promise<{texture: THREE.CubeTexture} | null>>)) {
			const c = await p;
			if (c) this.cubePaths.set(c.texture, path);
		}
	}

	// what's been recorded so far, onto the end of data.bin (when there's
	// enough of it to be worth a write)
	async flush(atLeast = 32 << 20) {
		const writes = this.writes;
		this.writes = [];
		await Promise.all(writes);
		return this.bin.flush(this.sink, atLeast);
	}

	// one frame: the scene as it was just drawn
	capture() {
		const f = this.frames++;
		const v = this.view;
		const main = v.scene as THREE.Scene;
		const leaveOut = new Set<THREE.Object3D>([v.player, v.ghost, v.pathLine, v.sky].filter(o => !!o));
		const seen = new Set<ObjectRec>();
		// (`pre`: applied after an object's own placement)
		const visit = (o: THREE.Object3D, scene: Layer, pre: THREE.Matrix4 | null = null) => {
			if (!o.visible || leaveOut.has(o)) return;
			const mesh = o as THREE.Mesh;
			if (mesh.isMesh) {
				if (this.isDynamic(mesh)) this.dynamic(mesh, scene, f, pre);
				else {
					const rec = this.object(mesh, scene);
					if (rec) {
						seen.add(rec);
						this.place(rec, mesh, f, pre);
					}
				}
			}
			for (const c of o.children) visit(c, scene, pre);
		};
		visit(main, 'main');
		if (v.mode === 'eyes' && v.vmShown) {
			visit(v.vmScene, 'vm');
			// first-person effects (the gun's lights, its hold beam): drawn with
			// the main camera's field of view but against the view model's
			// depth, so with the view model's camera they're drawn in
			// (across the view, by the ratio of the two fields of view)
			const cam = v.camera as THREE.PerspectiveCamera, vmCam = v.vmCam as THREE.PerspectiveCamera;
			cam.updateMatrixWorld();
			const k = Math.tan(vmCam.fov * Math.PI / 360) / Math.tan(cam.fov * Math.PI / 360);
			const pre = cam.matrixWorld.clone().multiply(new THREE.Matrix4().makeScale(k, k, 1)).multiply(cam.matrixWorldInverse);
			visit(v.fpScene, 'vm', pre);
		}
		for (const rec of this.objList) rec.visible.push(f, [seen.has(rec) ? 1 : 0]);

		const cam = v.camera as THREE.PerspectiveCamera;
		cam.updateMatrixWorld();
		this.camera.push(f, [...decompose(cam.matrixWorld, null), cam.fov, cam.near, cam.far]);
		const vm = v.vmCam as THREE.PerspectiveCamera;
		this.vmCamera.push(f, [...decompose(cam.matrixWorld, null), vm.fov, vm.near, vm.far]);
		const sky = v.skyView as THREE.PerspectiveCamera;
		if (v.skyCamera) {
			sky.updateMatrixWorld();
			this.skyCamera.push(f, [...decompose(sky.matrixWorld, null), sky.fov, sky.near, sky.far]);
		}
		const fade = v.fadeAt(v.meterTick) as {rgb: number[]; alpha: number; modulate: boolean};
		const ambient = modelAmbientUniforms.modelAmbient.value.toArray();
		const bloom = v.quality?.bloom ? v.bloomOverride ?? v.bloomScale : 0;
		this.globals.push(f, [v.exposure, fade.rgb[0], fade.rgb[1], fade.rgb[2], fade.alpha, fade.modulate ? 1 : 0, ...ambient, bloom]);
		for (const rec of this.lives) this.snapLive(rec, f);
		if (paintUniforms.paintOn.value > 0.5 && paintUniforms.paintMap.value) {
			this.paint ??= {map: this.tex(paintUniforms.paintMap.value), splat: this.tex(paintUniforms.paintSplat.value), tiles: paintUniforms.paintTiles.value.toArray()};
		}
		const fu = flashUniforms;
		const fc = v.flashCam as THREE.PerspectiveCamera;
		if (fu.flashOn.value > 0.5 && fu.flashCookie.value) {
			this.flashCookie ??= this.tex(fu.flashCookie.value);
			fc.updateMatrixWorld();
			this.flash.push(f, [1, ...decompose(fc.matrixWorld, null).slice(0, 7), fc.fov, fc.near, fc.far, ...fu.flashColor.value.toArray(), fu.flashShadows.value]);
		} else this.flash.push(f, new Array(15).fill(0));
		const fog = v.worldFog as THREE.Fog | null;
		this.fog.push(f, fog ? [fog.color.r, fog.color.g, fog.color.b, fog.near, fog.far, fogUniforms.fogMaxDensity.value] : [0, 0, 0, 0, 0, 0]);
	}

	// the record for a mesh, made the first time it's drawn (null: nothing
	// Blender can draw)
	private object(mesh: THREE.Mesh, scene: Layer): ObjectRec | null {
		let rec = this.objects.get(mesh);
		if (rec !== undefined) {
			// (a mesh can take another material, e.g. when its model's own lit
			// copy is made, or a sign's texture frame changes: a new object)
			if (this.matOf.get(mesh.material as THREE.Material) === rec.material) return rec;
		}
		const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
		if (!material || !material.visible) return null;
		const mat = this.material(material, mesh);
		if (mat < 0) return null;
		if (scene === 'main' && material.depthTest === false) scene = 'overlay';
		const geo = this.geometry(mesh.geometry, mesh);
		if (geo < 0) return null;
		const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? this.skeleton((mesh as THREE.SkinnedMesh).skeleton) : undefined;
		const lit = !!material.userData.ambientLit;
		rec = {
			id: this.objList.length, name: mesh.name || mesh.parent?.name || 'mesh', scene, group: this.groupOf(mesh), geometry: geo, material: mat,
			skeleton: skinned?.id, lit, visible: new Track(1), transform: new Track(10),
			lighting: lit ? new Track(48) : undefined, cube: material.userData.modelEnv ? new Track(1) : undefined,
			uniforms: uniformTrack(material), lastXf: null,
			portal: (material as THREE.ShaderMaterial).uniforms?.staticAmount ? new Track(13) : undefined,
		};
		// (seen invisible every frame before this one)
		if (this.frames > 1) rec.visible.push(0, [0]);
		this.objects.set(mesh, rec);
		this.objList.push(rec);
		return rec;
	}

	private place(rec: ObjectRec, mesh: THREE.Mesh, f: number, pre: THREE.Matrix4 | null = null) {
		if (rec.skeleton !== undefined) {
			// (skinned: its bones carry it, in world space)
			rec.transform.push(f, [0, 0, 0, 1, 0, 0, 0, 1, 1, 1]);
			const s = this.skelList[rec.skeleton];
			if (s.frame !== f) {
				s.frame = f;
				const pose: number[] = [];
				for (const bone of s.skeleton.bones) {
					bone.updateWorldMatrix(true, false);
					pose.push(...decompose(bone.matrixWorld, s.lastPose ? s.lastPose.slice(pose.length, pose.length + 10) : null));
				}
				s.lastPose = pose;
				s.pose.push(f, pose);
			}
		} else {
			mesh.updateWorldMatrix(true, false);
			const xf = decompose(pre ? pre.clone().multiply(mesh.matrixWorld) : mesh.matrixWorld, rec.lastXf);
			rec.lastXf = xf;
			rec.transform.push(f, xf);
		}
		if (rec.lighting) rec.lighting.push(f, this.lightingOf(mesh), 1e-4);
		if (rec.uniforms) rec.uniforms.track.push(f, uniformValues(mesh.material as THREE.ShaderMaterial, rec.uniforms.layout));
		if (rec.portal) rec.portal.push(f, this.portalWay(mesh));
		if (rec.cube) {
			const cube = ((mesh.material as THREE.Material).userData.envUniforms?.envCube?.value ?? null) as THREE.CubeTexture | null;
			rec.cube.push(f, [cube ? this.cubeTexture(cube) : -1]);
		}
	}

	// whether a particle system is one of a portal's own: its edge flames, or
	// an effect on its opening (as View3D.renderPortalViews tells them apart)
	private onPortalOpening(inst: unknown): boolean {
		const v = this.view;
		if ((v.edgeParticles as Map<unknown, number>).has(inst)) return true;
		const cp = (inst as {cps?: Map<number, THREE.Matrix4>}).cps?.get(0);
		if (!cp) return false;
		const pos = new THREE.Vector3().setFromMatrixPosition(cp);
		for (const p of (v.portals as Map<number, {obj: THREE.Object3D; halfW: number; halfH: number}>).values()) {
			const normal = new THREE.Vector3(1, 0, 0).transformDirection(p.obj.matrixWorld);
			const at = new THREE.Vector3().setFromMatrixPosition(p.obj.matrixWorld);
			if (Math.abs(normal.dot(pos) - normal.dot(at)) < 12 && pos.distanceTo(at) < Math.hypot(p.halfW, p.halfH) + 8) return true;
		}
		return false;
	}

	// where a portal's surface leads: the matrix taking the world in front of
	// it to its partner's side (View3D.portalTransform), or identity unlinked
	private portalWay(surface: THREE.Mesh): number[] {
		const portals = this.view.portals as Map<number, {obj: THREE.Object3D; link: number}>;
		for (const p of portals.values()) {
			if (p.obj.userData.portalSurface !== surface) continue;
			const linked = portals.get(p.link);
			if (!linked) break;
			const m = this.view.portalTransform(p.obj, linked.obj) as THREE.Matrix4;
			const e = m.elements;
			return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], 1];
		}
		return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0];
	}

	// a lit model's lighting: its ambient cube (6 x rgb), then three local
	// lights (position, colour, falloff), then the point it's lit at
	private lightingOf(mesh: THREE.Object3D): number[] {
		let o: THREE.Object3D | null = mesh;
		let l: {cube: number[]; lights: {pos: number[]; color: number[]; base?: number[]; atten?: number[]}[]} | undefined;
		while (o && !(l = o.userData.lighting)) o = o.parent;
		const out = l ? l.cube.slice(0, 18) : new Array(18).fill(0.1);
		for (let i = 0; i < 3; i++) {
			const light = l?.lights[i];
			const color = light?.base ?? light?.color;
			out.push(light?.pos[0] ?? 0, light?.pos[1] ?? 0, light?.pos[2] ?? 0);
			out.push(color?.[0] ?? 0, color?.[1] ?? 0, color?.[2] ?? 0);
			out.push(...(light?.atten ?? [1, 0, 0]));
		}
		// (and where it was worked out: the object's lighting centre)
		const centre = o?.userData.lightCentre as THREE.Vector3 | undefined;
		const at = centre && o ? centre.clone().applyMatrix4(o.matrixWorld) : new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
		out.push(at.x, at.y, at.z);
		return out;
	}

	private groupOf(o: THREE.Object3D): Group {
		const v = this.view;
		for (let p: THREE.Object3D | null = o; p; p = p.parent) {
			if (p === v.mapGroup) return 'map';
			if (p === v.propGroup) return 'props';
			if (p === v.entityGroup) return 'entities';
		}
		return 'effects';
	}

	// whether a mesh's geometry changes from frame to frame (its buffers
	// written again, its draw range moved, or the geometry swapped)
	private isDynamic(mesh: THREE.Mesh): boolean {
		if (this.dynamicMeshes.has(mesh)) return true;
		const g = mesh.geometry;
		const had = this.meshGeo.get(mesh);
		this.meshGeo.set(mesh, g);
		if (had && had !== g) {
			this.dynamicMeshes.add(mesh);
			return true;
		}
		const sig = geometrySig(g);
		const known = this.geoSigs.get(g);
		this.geoSigs.set(g, sig);
		if (known !== undefined && known !== sig) this.dynamicGeos.add(g);
		if (this.dynamicGeos.has(g)) {
			this.dynamicMeshes.add(mesh);
			return true;
		}
		return false;
	}

	private dynamic(mesh: THREE.Mesh, scene: Layer, f: number, pre: THREE.Matrix4 | null = null) {
		const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
		if (!material || !material.visible) return;
		const mat = this.material(material, mesh);
		if (mat < 0) return;
		if (scene === 'main' && material.depthTest === false) scene = 'overlay';
		const g = mesh.geometry;
		const owners = mesh.userData.quadOwners as unknown[] | undefined;
		let d = this.dyns.get(mesh);
		if (!d || d.material !== mat) {
			// (its attributes as it first has them; the export's own last)
			const layout: [string, number, BinType][] = [];
			for (const [name, attr] of Object.entries(g.attributes)) {
				if (name === 'skinIndex' || name === 'skinWeight' || (attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
				layout.push([name, attr.itemSize, name === 'position' ? 'f32' : 'f16']);
			}
			if (owners) layout.push(['p2_portalfx', 1, 'f16']);
			d = {
				id: this.dynList.length, name: mesh.name || mesh.parent?.name || 'dynamic', scene, group: this.groupOf(mesh), material: mat,
				layout, quads: !!owners, spans: [], vertices: 0, lastSig: '', uniforms: uniformTrack(material),
			};
			this.dyns.set(mesh, d);
			this.dynList.push(d);
		}
		if (d.uniforms) d.uniforms.track.push(f, uniformValues(material as THREE.ShaderMaterial, d.uniforms.layout));
		mesh.updateWorldMatrix(true, false);
		const world = pre ? pre.clone().multiply(mesh.matrixWorld) : mesh.matrixWorld;
		const sig = geometrySig(g) + world.elements.join(',');
		const n = d.spans.length;
		if (n && d.lastSig === sig && d.spans[n - 4] === f) {
			d.spans[n - 4] = f + 1;
			return;
		}
		d.lastSig = sig;
		const pos = g.getAttribute('position');
		if (!pos) return;
		// the drawn vertices in order: triangles, or for particles, each quad's
		// four corners (its two triangles are corners 0 1 2 and 0 2 3)
		const range = g.drawRange;
		const total = g.index ? g.index.count : pos.count;
		const start = range.start, end = Math.min(total, range.start + (Number.isFinite(range.count) ? range.count : total));
		const order: number[] = [];
		if (d.quads) {
			for (let i = start; i + 5 < end; i += 6) order.push(i, i + 1, i + 2, i + 5);
		} else {
			for (let i = start; i < end; i++) order.push(g.index ? g.index.getX(i) : i);
			order.length -= order.length % 3;
		}
		const count = order.length;
		if (!count) return;
		const m = world;
		const nm = new THREE.Matrix3().getNormalMatrix(m);
		const v = new THREE.Vector3();
		// one block: each attribute in turn, 4-byte aligned
		const offset = (this.bin.align(), this.bin.size);
		for (const [name, size, type] of d.layout) {
			const out = new Float32Array(count * size);
			const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
			if (name === 'p2_portalfx' && owners) {
				// particles on a portal's opening (its edge flames, placement
				// sparks, fizzle), which the viewer leaves out of the views
				// through portals
				const flags = new Map<unknown, number>();
				for (let i = 0; i < count; i++) {
					const owner = owners[Math.floor((order[i] - start) / 6)];
					let flag = flags.get(owner);
					if (flag === undefined) flags.set(owner, flag = this.onPortalOpening(owner) ? 1 : 0);
					out[i] = flag;
				}
			} else if (a && a.itemSize === size) {
				const kind = name === 'position' ? 'point' : name === 'normal' || name === 'ropeTangent' ? 'dir' : 'value';
				for (let i = 0; i < count; i++) {
					const k = order[i];
					if (kind !== 'value' && size === 3) {
						v.fromBufferAttribute(a, k);
						if (kind === 'point') v.applyMatrix4(m);
						else v.applyMatrix3(nm);
						out[i * 3] = v.x;
						out[i * 3 + 1] = v.y;
						out[i * 3 + 2] = v.z;
					} else for (let c = 0; c < size; c++) out[i * size + c] = a.getComponent(k, c);
				}
			}
			const bytes = type === 'f16' ? toHalf(out) : out;
			this.bin.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
			this.bin.align();
		}
		d.spans.push(f, f + 1, d.vertices, count, offset);
		d.vertices += count;
	}

	private skeleton(sk: THREE.Skeleton): SkeletonRec {
		let s = this.skeletons.get(sk);
		if (!s) {
			s = {id: this.skelList.length, skeleton: sk, pose: new Track(sk.bones.length * 10), lastPose: null, frame: -1};
			this.skeletons.set(sk, s);
			this.skelList.push(s);
		}
		return s;
	}

	// A mesh's geometry, once: its attributes (positions, uvs and skin data
	// as they are; normals, colours and the rest as half floats), with the
	// drawn range. Triangle soups (the world's, by face) are joined up where
	// corners are the same vertex in every attribute, and indexed.
	private geometry(g: THREE.BufferGeometry, mesh: THREE.Mesh): number {
		let id = this.geometries.get(g);
		if (id !== undefined) return id;
		const pos = g.getAttribute('position');
		if (!pos || pos.count === 0) return -1;
		const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh;
		const sources: [string, THREE.BufferAttribute][] = [];
		for (const [name, a] of Object.entries(g.attributes)) {
			if ((a as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
			if (!skinned && (name === 'skinIndex' || name === 'skinWeight')) continue;
			sources.push([name, a as THREE.BufferAttribute]);
		}
		const values = (a: THREE.BufferAttribute) => a.array instanceof Float32Array
			? a.array
			: Float32Array.from({length: a.count * a.itemSize}, (_, i) => a.getComponent(Math.floor(i / a.itemSize), i % a.itemSize));
		const arrays = sources.map(([name, a]) => [name, values(a), a.itemSize] as const);
		// (vertices alike in every attribute made one, the index through them)
		const corners = g.index ? new Uint32Array(g.index.array) : Uint32Array.from({length: pos.count}, (_, i) => i);
		const seen = new Map<string, number>();
		const unique = new Int32Array(pos.count).fill(-1);
		const firsts: number[] = [];
		const index = new Uint32Array(corners.length);
		for (let i = 0; i < corners.length; i++) {
			const v = corners[i];
			if (unique[v] < 0) {
				let key = '';
				for (const [, arr, size] of arrays) for (let c = 0; c < size; c++) key += arr[v * size + c] + ',';
				let at = seen.get(key);
				if (at === undefined) {
					seen.set(key, at = firsts.length);
					firsts.push(v);
				}
				unique[v] = at;
			}
			index[i] = unique[v];
		}
		const count = firsts.length;
		const remap = Uint32Array.from(firsts);
		const attrs: Record<string, {view: BinView; size: number}> = {};
		for (const [name, arr, size] of arrays) {
			const data = new Float32Array(count * size);
			for (let i = 0; i < count; i++) for (let c = 0; c < size; c++) data[i * size + c] = arr[remap[i] * size + c];
			const exact = name === 'position' || name.startsWith('uv') || name === 'skinIndex' || name === 'skinWeight';
			attrs[name] = {view: exact ? this.bin.add(data) : this.bin.add(toHalf(data), 'f16'), size};
		}
		const range = g.drawRange;
		id = this.geoList.length;
		this.geoList.push({
			id, count, index: this.bin.add(index), attributes: attrs, groups: g.groups.length ? g.groups : undefined,
			drawRange: range.count !== Infinity || range.start ? [range.start, range.count] : undefined,
		});
		this.geometries.set(g, id);
		return id;
	}

	// ---- materials ----

	private material(m: THREE.Material, mesh: THREE.Mesh): number {
		const known = this.matOf.get(m);
		if (known !== undefined) return known;
		const d = this.describe(m, mesh);
		if (!d) {
			const key = m.type + (m.name ? `:${m.name}` : '');
			this.unsupported.set(key, (this.unsupported.get(key) ?? 0) + 1);
			this.matOf.set(m, -1);
			return -1;
		}
		const sig = JSON.stringify(d);
		let id = this.materials.get(sig);
		if (id === undefined) {
			id = this.matList.length;
			this.matList.push({id, ...d});
			this.materials.set(sig, id);
		}
		this.matOf.set(m, id);
		return id;
	}

	private blendOf(m: THREE.Material): Record<string, unknown> {
		const out: Record<string, unknown> = {side: m.side === THREE.DoubleSide ? 'double' : m.side === THREE.BackSide ? 'back' : 'front'};
		if (!m.transparent) {
			out.blend = m.alphaTest > 0 ? 'clip' : 'opaque';
			if (m.alphaTest > 0) out.alphaTest = m.alphaTest;
			return out;
		}
		out.opacity = m.opacity;
		if (m.blending === THREE.NormalBlending) out.blend = 'blend';
		else if (m.blending === THREE.AdditiveBlending) out.blend = 'add';
		else if (m.blending === THREE.CustomBlending) {
			const s = m.blendSrc, d = m.blendDst;
			out.blend = s === THREE.ZeroFactor && d === THREE.SrcColorFactor ? 'multiply'
				: s === THREE.DstColorFactor && d === THREE.SrcColorFactor ? 'modulate2x'
				: s === THREE.OneFactor && d === THREE.SrcAlphaFactor ? 'addAlphaBehind'
				: s === THREE.OneFactor && d === THREE.OneMinusSrcAlphaFactor ? 'premultiplied'
				: s === THREE.OneFactor && d === THREE.OneFactor ? 'add'
				: s === THREE.SrcAlphaFactor && d === THREE.OneFactor ? 'add'
				: `custom:${s}/${d}`;
		} else out.blend = `blending:${m.blending}`;
		return out;
	}

	private tex(t: THREE.Texture | null | undefined): number | null {
		if (!t) return null;
		if ((t as THREE.CubeTexture).isCubeTexture) return this.cubeTexture(t as THREE.CubeTexture);
		const src = t.userData.source as {path: string; linear: boolean; frame: number} | undefined;
		if (src) return this.vtfTexture(src.path, src.linear, src.frame);
		const v = this.view;
		if (t === v.lightTex) return this.dataTexture('lightmap', t as THREE.DataTexture, true);
		const bump = (v.bumpTex as THREE.Texture[]).indexOf(t);
		if (bump >= 0) return this.dataTexture(`lightmap_bump${bump}`, t as THREE.DataTexture, true);
		const bytes = (t as THREE.DataTexture).isDataTexture && t.type === THREE.UnsignedByteType;
		if (bytes || (t as THREE.CanvasTexture).isCanvasTexture) return this.liveTexture(t);
		if ((t as THREE.DataTexture).isDataTexture) return this.dataTexture(`data_${t.id}`, t as THREE.DataTexture, t.colorSpace !== THREE.SRGBColorSpace);
		this.unsupported.set(`texture:${t.constructor.name}`, (this.unsupported.get(`texture:${t.constructor.name}`) ?? 0) + 1);
		return null;
	}

	private addTexture(key: string, file: string, colorspace: 'srgb' | 'linear', make: TextureRec['make']): number {
		let r = this.textures.get(key);
		if (!r) {
			r = {id: this.texList.length, file, colorspace, alpha: false, make};
			this.textures.set(key, r);
			this.texList.push(r);
		}
		return r.id;
	}

	private static fileName(s: string) {
		return s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+/, '').slice(-120);
	}

	// a material's texture at the game's full size, from its file
	private vtfTexture(path: string, linear: boolean, frame: number): number {
		const key = `${path}|${linear}|${frame}`;
		const name = BlenderCapture.fileName(path + (frame ? `_f${frame}` : ''));
		return this.addTexture(key, `textures/${name}`, linear ? 'linear' : 'srgb', async () => {
			const file = `materials/${path}.vtf`;
			const bytes = await this.files.read(file);
			if (!bytes) return null;
			const level = vtfLevel(bytes, 1 << 16, frame);
			if (!level) return null;
			const F = VtfFormat;
			const fourCC = level.format === F.DXT1 || level.format === F.DXT1_ONEBITALPHA ? 'DXT1' as const : level.format === F.DXT3 ? 'DXT3' as const : level.format === F.DXT5 ? 'DXT5' as const : null;
			if (fourCC && level.width % 4 === 0 && level.height % 4 === 0) {
				const mips = vtfMips(bytes, 1 << 16, frame) ?? [];
				const levels = mips.filter(m => m.width >= 4 && m.height >= 4 && m.offset + m.size <= bytes.length).map(m => bytes.subarray(m.offset, m.offset + m.size));
				if (levels.length) return {data: encodeDds(level.width, level.height, fourCC, levels), ext: 'dds', width: level.width, height: level.height, alpha: level.hasAlpha};
			}
			const data = bytes.subarray(level.offset, level.offset + level.size);
			if (level.format === F.RGBA16161616F) {
				const half = new Uint16Array(data.slice().buffer);
				return {data: await encodeExr(level.width, level.height, half, true), ext: 'exr', width: level.width, height: level.height, alpha: true};
			}
			const rgba = decodeVtf({...level, data});
			return {data: await encodePng(level.width, level.height, rgba, level.hasAlpha), ext: 'png', width: level.width, height: level.height, alpha: level.hasAlpha};
		});
	}

	// a texture the page draws into (a movie screen's frames, a sign, the gel):
	// a picture of it now and whenever it changes (see snapLive)
	private lives: TextureRec[] = [];
	private writes: Promise<void>[] = [];
	private liveTexture(t: THREE.Texture): number {
		const key = `live_${t.id}`;
		const known = this.textures.get(key);
		if (known) return known.id;
		const id = this.addTexture(key, `textures/${key}`, t.colorSpace === THREE.SRGBColorSpace ? 'srgb' : 'linear', async () => null);
		const rec = this.texList[id];
		// (the gel's map is big and changes nearly every frame: ten a second)
		rec.live = {texture: t, version: -1, count: 0, keys: [], lastFrame: -Infinity, every: t === this.view.paint?.texture ? 6 : 1};
		this.lives.push(rec);
		this.snapLive(rec, Math.max(0, this.frames - 1));
		return id;
	}

	private snapLive(rec: TextureRec, f: number) {
		const live = rec.live!;
		const t = live.texture;
		if (t.version === live.version || f - live.lastFrame < live.every) return;
		const img = t.image as {width: number; height: number; data?: Uint8Array} & CanvasImageSource;
		const width = img.width, height = img.height;
		if (!width || !height) return;
		let rgba: Uint8Array;
		if ((t as THREE.CanvasTexture).isCanvasTexture) {
			const c = new OffscreenCanvas(width, height);
			const g = c.getContext('2d')!;
			g.drawImage(img, 0, 0);
			rgba = new Uint8Array(g.getImageData(0, 0, width, height).data.buffer);
		} else rgba = (img.data as Uint8Array).slice(0, width * height * 4);
		// (pictures are written top row first as v = 0, as the game's textures
		// are; a canvas goes up flipped, its top row at v = 1)
		if (t.flipY) {
			const row = width * 4, flipped = new Uint8Array(rgba.length);
			for (let y = 0; y < height; y++) flipped.set(rgba.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
			rgba = flipped;
		}
		live.version = t.version;
		live.lastFrame = f;
		const index = live.count++;
		live.keys.push(f, index);
		const file = `${rec.file}/${String(index + 1).padStart(4, '0')}.png`;
		this.writes.push(encodePng(width, height, rgba, true).then(png => this.sink.write(file, png)));
	}
	private dataTexture(key: string, t: THREE.DataTexture, linear: boolean): number {
		return this.addTexture(key, `textures/${BlenderCapture.fileName(key)}`, linear ? 'linear' : 'srgb', async () => {
			const {width, height, data} = t.image as {width: number; height: number; data: ArrayBufferView};
			if (t.type === HALF) return {data: await encodeExr(width, height, data as Uint16Array, true), ext: 'exr', width, height, alpha: true};
			if (t.type === THREE.FloatType) {
				const f = data as Float32Array;
				const half = new Uint16Array(f.length);
				for (let i = 0; i < f.length; i++) half[i] = THREE.DataUtils.toHalfFloat(f[i]);
				return {data: await encodeExr(width, height, half, true), ext: 'exr', width, height, alpha: true};
			}
			if (data instanceof Uint8Array && data.length === width * height * 4) return {data: await encodePng(width, height, data, true), ext: 'png', width, height, alpha: true};
			return null;
		});
	}

	// a cubemap, as an equirectangular HDR image (from its file at full size)
	private cubeTexture(cube: THREE.CubeTexture): number {
		const path = this.cubePaths.get(cube) ?? `cube_${cube.id}`;
		return this.addTexture(`cube:${path}`, `textures/cube_${BlenderCapture.fileName(path)}`, 'linear', async () => {
			let faces: {width: number; height: number; data: Uint16Array | Uint8Array}[] | null = null;
			for (const ext of ['.hdr.vtf', '.vtf']) {
				const bytes = this.cubePaths.has(cube) ? await this.files.read(`materials/${path}${ext}`) : null;
				const f = bytes && readVtfCube(bytes, 1 << 16);
				if (!f) continue;
				faces = f.map(face => face.format === VtfFormat.RGBA16161616F
					? {width: face.width, height: face.height, data: new Uint16Array(face.data.slice(0, face.width * face.height * 8).buffer)}
					: {width: face.width, height: face.height, data: decodeVtf(face)});
				break;
			}
			if (!faces) {
				// (from the texture itself)
				const imgs = cube.image as THREE.DataTexture[];
				faces = imgs.map(i => ({width: i.image.width, height: i.image.height, data: i.image.data as Uint16Array | Uint8Array}));
			}
			const width = Math.max(64, Math.min(2048, faces[0].width * 4));
			const half = cubeToEquirect(faces, width);
			return {data: await encodeExr(width, width >> 1, half, false), ext: 'exr', width, height: width >> 1, alpha: false};
		});
	}

	// what a material does, or null if it's nothing Blender's side draws yet
	private describe(m: THREE.Material, mesh: THREE.Mesh): Record<string, unknown> | null {
		const u = m.userData;
		const defines = (m as THREE.ShaderMaterial).defines ?? {};
		const has = (k: string) => k in defines;
		const basic = m as THREE.MeshBasicMaterial;
		if ((m as THREE.ShaderMaterial).isShaderMaterial) return this.describeShader(m as THREE.ShaderMaterial);
		const common = {
			...this.blendOf(m),
			color: basic.color ? [basic.color.r, basic.color.g, basic.color.b] : [1, 1, 1],
			map: this.tex(basic.map),
			vertexColors: !!basic.vertexColors,
			offset: m.polygonOffset || undefined,
			fog: (basic as THREE.MeshBasicMaterial).fog !== false,
		};
		const flags = {
			refractTint: has('REFRACT_TINT'), refractEnv: has('REFRACT_ENV'), refractUnscaled: has('REFRACT_UNSCALED'),
			decalModulate: has('DECAL_MODULATE'), refractLocal: has('REFRACT_LOCAL'),
		};
		const anyFlag = Object.values(flags).some(Boolean);
		const refractLocal = u.refractLocal as {normal: {value: THREE.Texture | null}; params: {value: THREE.Vector2}} | undefined;
		const refract = anyFlag ? {...flags, localNormal: flags.refractLocal ? this.tex(refractLocal?.normal.value) : undefined, localParams: flags.refractLocal ? refractLocal?.params.value.toArray() : undefined} : undefined;
		if (u.water) return {kind: 'water', ...common, water: u.water};
		const env = u.envUniforms as Record<string, {value: any}> | undefined;
		const envDesc = env && has('ENVMAP_CUBE') ? {
			cube: env.envCube.value ? this.tex(env.envCube.value) : null,
			tint: env.envTint.value.toArray(), scale: env.envScale.value, contrast: env.envContrast.value,
			saturation: env.envSaturation.value.toArray(), lightScale: env.envLightScale.value,
			fresnel: env.envFresnel?.value ?? 0, fresnelReflection: has('ENV_FRESNEL_REFLECT') ? env.envFresnelReflection?.value : 1,
			mask: has('ENVMASK_BASE') ? 'base' : has('ENVMASK_BUMP') ? 'bump' : has('ENVMASK_TEXTURE') ? 'texture' : has('ENVMASK_ALPHA') ? 'alpha' : 'none',
			maskMap: has('ENVMASK_TEXTURE') || has('ENVMASK_ALPHA') ? this.tex(env.envMaskMap.value) : null,
		} : undefined;
		if (u.ambientLit) {
			const amb = u.ambUniforms as Record<string, {value: any}> | undefined;
			const phong = has('PHONG') && amb ? {
				exponent: amb.phongExponent.value, boost: amb.phongBoost.value, fresnel: amb.phongFresnel.value.toArray(), tint: amb.phongTint.value.toArray(),
				mask: has('PHONG_BASEMASK') ? 'base' : has('PHONG_BUMPMASK') ? 'bump' : 'none',
				maskMap: has('PHONG_BUMPMASK') ? this.tex(amb.phongMaskMap.value) : null,
				expMap: has('PHONG_EXPMAP') ? this.tex(amb.phongExpMap.value) : null,
			} : undefined;
			const selfIllum = has('SELFILLUM') && amb ? {tint: amb.selfIllumTint.value.toArray(), mask: has('SELFILLUM_MASK') ? this.tex(amb.selfIllumMask.value) : null} : undefined;
			return {kind: 'model', ...common, ambScale: amb?.ambScale.value ?? 1.5, phong, selfIllum, env: envDesc, envPerObject: !!u.modelEnv, refract};
		}
		if (u.vertexLit) {
			const si = u.selfIllum as {tint: number[]; mask: THREE.Texture | null} | undefined;
			return {kind: 'vertexlit', ...common, selfIllum: has('SELFILLUM') && si ? {tint: si.tint, mask: this.tex(si.mask)} : undefined, refract};
		}
		if (env) {
			// a world material (hookWorldMaterial): lightmapped
			const blend2 = u.blend2 as {map2: {value: THREE.Texture | null}; modulate: {value: THREE.Texture | null}} | undefined;
			const lm = basic.lightMap;
			return {
				kind: 'world', ...common,
				lightmap: lm ? this.tex(lm) : null, lightmapScale: lm ? basic.lightMapIntensity / Math.PI : 0,
				bump: has('BUMPLIGHT') && u.bumpNormal ? {normal: this.tex(u.bumpNormal), ssbump: has('SSBUMP'), lights: [0, 1, 2].map(i => this.tex(this.view.bumpTex[i]))} : undefined,
				selfIllum: has('WORLD_SELFILLUM') ? {tint: env.worldGlowTint.value.toArray()} : undefined,
				blend2: has('BLEND2') && blend2 ? {map: this.tex(blend2.map2.value), modulate: has('BLEND2_MODULATE') ? this.tex(blend2.modulate.value) : null} : undefined,
				detail: has('DETAIL_MODE') ? {mode: Number(defines.DETAIL_MODE), map: this.tex(env.detailMap.value), scale: env.detailScale.value, blend: env.detailBlend.value} : undefined,
				env: envDesc, refract,
				// (an ssbump's normal map also carries the reflection mask)
				bumpNormal: has('ENVMASK_BUMP') && u.bumpNormal ? this.tex(u.bumpNormal) : undefined,
				textureless: !!u.textureless,
			};
		}
		// the sky faces' stencil: where the 3D sky (or the 2D one) shows
		if (!m.colorWrite && (m as THREE.MeshBasicMaterial).stencilWrite) return {kind: 'skymask', side: 'double'};
		if ((m as THREE.MeshBasicMaterial).isMeshBasicMaterial || (m as THREE.MeshLambertMaterial).isMeshLambertMaterial) return {kind: 'unlit', ...common, refract};
		return null;
	}

	// an effect's own shader (portals, sprites, beams, energy surfaces...):
	// which one it is, its settings and textures (Blender has a port of each)
	private describeShader(m: THREE.ShaderMaterial): Record<string, unknown> {
		const u = m.uniforms;
		const has = (k: string) => k in u;
		const shader = has('overbright') ? 'spritecard'
			: has('staticAmount') ? 'portal'
			: has('vortex1') ? 'fizzler'
			: has('detail1Offset') ? 'solidenergy'
			: has('t2') && has('ramp') ? 'laser'
			: has('dial') ? 'screen'
			: has('normalMap') && has('alphaTest') ? 'rope'
			: m.fragmentShader.includes('wet sheen') ? 'gelblob'
			: `unknown:${Object.keys(u).sort().join(',')}`;
		const values: Record<string, number | number[]> = {};
		const textures: Record<string, number | null> = {};
		for (const [name, {value}] of Object.entries(u)) {
			if ((value as THREE.Texture | null)?.isTexture) textures[name] = this.tex(value as THREE.Texture);
			else {
				const flat = flatten(value);
				if (flat) values[name] = flat.length === 1 ? flat[0] : flat;
			}
		}
		return {kind: 'shader', shader, ...this.blendOf(m), depthTest: m.depthTest, defines: m.defines ?? {}, values, textures};
	}

	// ---- the end ----

	// the 2D sky's six faces as one equirectangular image
	private async skyTexture(): Promise<number | null> {
		const name = (this.view.bsp?.entities.find((e: {classname: string}) => e.classname === 'worldspawn') as {skyname?: string} | undefined)?.skyname;
		if (!name) return null;
		// (from the files, at full size: rt bk lf ft up dn)
		const read = async (side: string) => {
			for (const n of [`skybox/${name}_hdr${side}`, `skybox/${name}${side}`]) {
				const info = await this.view.library?.materials.get(n);
				if (!info?.found || !info.baseTexture) continue;
				const bytes = await this.files.read(`materials/${info.baseTexture.toLowerCase()}.vtf`);
				const level = bytes && vtfLevel(bytes, 1 << 16);
				if (!bytes || !level) continue;
				const data = bytes.subarray(level.offset, level.offset + level.size);
				if (level.format === VtfFormat.RGBA16161616F) return {width: level.width, height: level.height, data: new Uint16Array(data.slice().buffer), srgb: false};
				return {width: level.width, height: level.height, data: decodeVtf({...level, data}), srgb: true};
			}
			return null;
		};
		const sides = await Promise.all(['rt', 'bk', 'lf', 'ft', 'up', 'dn'].map(read));
		if (sides.some(s => !s)) return null;
		// the viewer's sky box: each face's corners (s, t in -1..1) at a
		// direction (see View3D.loadSky); texture u = (s+1)/2, v = (1-t)/2
		const at: ((s: number, t: number) => number[])[] = [
			(s, t) => [1, -s, t], (s, t) => [-1, s, t], (s, t) => [s, 1, t],
			(s, t) => [-s, -1, t], (s, t) => [-t, -s, 1], (s, t) => [t, -s, -1],
		];
		const width = Math.min(4096, Math.max(256, sides[0]!.width * 4));
		const height = width >> 1;
		const out = new Uint16Array(width * height * 4);
		const toHalf = THREE.DataUtils.toHalfFloat, fromHalf = THREE.DataUtils.fromHalfFloat;
		const dir = new THREE.Vector3();
		for (let row = 0; row < height; row++) {
			const elev = (0.5 - (row + 0.5) / height) * Math.PI;
			for (let col = 0; col < width; col++) {
				const azim = (0.5 - (col + 0.5) / width) * 2 * Math.PI;
				dir.set(Math.cos(elev) * Math.cos(azim), Math.cos(elev) * Math.sin(azim), Math.sin(elev));
				// the face whose plane it hits first, then (s, t) on it
				let best = -1, bs = 0, bt = 0, bd = -Infinity;
				for (let k = 0; k < 6; k++) {
					// face k's normal is at(0, 0); s and t axes from at(1,0)-at(0,0)
					const n = at[k](0, 0), sa = at[k](1, 0).map((x, i) => x - n[i]), ta = at[k](0, 1).map((x, i) => x - n[i]);
					const dn = dir.x * n[0] + dir.y * n[1] + dir.z * n[2];
					if (dn <= bd) continue;
					bd = dn;
					best = k;
					bs = (dir.x * sa[0] + dir.y * sa[1] + dir.z * sa[2]) / dn;
					bt = (dir.x * ta[0] + dir.y * ta[1] + dir.z * ta[2]) / dn;
				}
				const face = sides[best]!;
				const u = (bs + 1) / 2, v = (1 - bt) / 2;
				const x = Math.min(face.width - 1, Math.max(0, Math.floor(u * face.width))), y = Math.min(face.height - 1, Math.max(0, Math.floor(v * face.height)));
				const o = (row * width + col) * 4, i = (y * face.width + x) * 4;
				for (let c = 0; c < 3; c++) {
					const raw = face.data[i + c];
					// (sRGB bytes to linear, as the viewer's sky texture is sampled)
					const lin = face.srgb ? srgbToLinear(raw / 255) : fromHalf(raw);
					out[o + c] = toHalf(lin);
				}
				out[o + 3] = toHalf(1);
			}
		}
		return this.addTexture('sky2d', 'textures/sky2d', 'linear', async () => ({data: await encodeExr(width, height, out, false), ext: 'exr', width, height, alpha: false}));
	}

	// writes the bundle: textures, data.bin and scene.json
	async finish(progress: (note: string) => void = () => {}): Promise<{bytes: number; unsupported: Record<string, number>}> {
		const sky2d = await this.skyTexture();
		let done = 0;
		await Promise.all(this.writes);
		for (const t of this.texList) {
			progress(`Textures ${++done}/${this.texList.length}`);
			if (t.live) {
				// (its pictures are written already: the first, or the sequence)
				t.alpha = true;
				t.file = t.live.count ? `${t.file}/0001.png` : '';
				continue;
			}
			const made = await t.make().catch(() => null);
			if (!made) {
				t.file = '';
				continue;
			}
			t.file = `${t.file}.${made.ext}`;
			t.alpha = made.alpha;
			await this.sink.write(t.file, made.data);
		}
		progress('Scene data');
		const bin = this.bin;
		const tracks = (t: Track) => t.write(bin);
		const uniforms = (u?: UniformTrack) => (u && u.layout.length ? {layout: u.layout, track: tracks(u.track)} : undefined);
		const objects = this.objList.map(o => ({
			id: o.id, name: o.name, scene: o.scene, group: o.group, geometry: o.geometry, material: o.material, skeleton: o.skeleton,
			visible: tracks(o.visible), transform: tracks(o.transform),
			lighting: o.lighting ? tracks(o.lighting) : undefined, cube: o.cube ? tracks(o.cube) : undefined,
			uniforms: uniforms(o.uniforms),
			portal: o.portal ? tracks(o.portal) : undefined,
		}));
		// which uniforms of each effect material ever change (in any object
		// drawn with it): only those are per-object, keyed values in Blender
		// (Eevee reads at most 8 per material); the rest are its constants
		for (const r of [...this.objList, ...this.dynList]) {
			const u = r.uniforms;
			if (!u || u.track.frames.length < 2) continue;
			const desc = this.matList[r.material] as {animated?: string[]};
			const set = new Set(desc.animated ?? []);
			let col = 0;
			const w = u.track.width, vals = u.track.values;
			for (const [name, size] of u.layout) {
				for (let c = 0; c < size; c++, col++) {
					for (let k = w + col; k < vals.length; k += w) if (vals[k] !== vals[col]) {
						set.add(name);
						break;
					}
				}
			}
			desc.animated = [...set].sort();
		}
		const dynamics = this.dynList.filter(d => d.vertices).map(d => ({
			id: d.id, name: d.name, scene: d.scene, group: d.group, material: d.material, vertices: d.vertices,
			layout: d.layout, quads: d.quads, spans: bin.add(new Float64Array(d.spans)),
			uniforms: uniforms(d.uniforms),
		}));
		const skeletons = this.skelList.map(s => ({
			id: s.id,
			bones: s.skeleton.bones.map((b, i) => ({name: b.name, parent: s.skeleton.bones.indexOf(b.parent as THREE.Bone), rest: s.skeleton.boneInverses[i].clone().invert().toArray()})),
			pose: tracks(s.pose),
		}));
		const v = this.view;
		const sc = v.skyCamera as {origin: THREE.Vector3; scale: number; fog: THREE.Fog | null} | null;
		const scene = {
			format: 'p2-demo-blender', version: 1,
			...this.info,
			frames: this.frames,
			textures: this.texList.map(t => ({
				id: t.id, file: t.file, colorspace: t.colorspace, alpha: t.alpha,
				sequence: t.live && t.live.count > 1 ? {count: t.live.count, keys: bin.add(new Float64Array(t.live.keys))} : undefined,
			})),
			paint: this.paint,
			geometries: this.geoList,
			materials: this.matList,
			skeletons,
			objects,
			dynamics,
			camera: tracks(this.camera),
			vmCamera: tracks(this.vmCamera),
			skyCamera: sc ? {origin: sc.origin.toArray(), scale: sc.scale, fog: sc.fog ? {color: sc.fog.color.toArray(), start: sc.fog.near, end: sc.fog.far} : null, track: tracks(this.skyCamera)} : null,
			sky2d,
			globals: {layout: ['exposure', 'fadeR', 'fadeG', 'fadeB', 'fadeA', 'fadeModulate', 'ambientR', 'ambientG', 'ambientB', 'bloom'], track: tracks(this.globals)},
			fog: {layout: ['r', 'g', 'b', 'start', 'end', 'maxDensity'], track: tracks(this.fog)},
			flash: this.flashCookie !== null ? {cookie: this.flashCookie, layout: ['on', 'x', 'y', 'z', 'qw', 'qx', 'qy', 'qz', 'fov', 'near', 'far', 'r', 'g', 'b', 'shadows'], track: tracks(this.flash)} : null,
			unsupported: Object.fromEntries(this.unsupported),
		};
		await bin.flush(this.sink);
		const json = new TextEncoder().encode(JSON.stringify(scene));
		await this.sink.write('scene.json', json);
		return {bytes: bin.size + json.length, unsupported: scene.unsupported};
	}
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// a geometry's state: its buffers' versions (bumped when written), which
// buffers they are, and its draw range
const attrIds = new WeakMap<object, number>();
let nextAttrId = 1;
function geometrySig(g: THREE.BufferGeometry): string {
	const id = (a: object) => {
		let n = attrIds.get(a);
		if (!n) attrIds.set(a, n = nextAttrId++);
		return n;
	};
	// (not its index: bounds trees reorder it, or add one, for ray tests,
	// leaving the same triangles)
	let sig = `${g.drawRange.start}:${g.drawRange.count}`;
	for (const [name, a] of Object.entries(g.attributes)) sig += `|${name}${id(a)}v${(a as THREE.BufferAttribute).version}`;
	return sig;
}

// a uniform's value as numbers (null: not a number, vector, colour or matrix)
function flatten(v: unknown): number[] | null {
	if (typeof v === 'number') return [v];
	if (typeof v === 'boolean') return [v ? 1 : 0];
	if (!v || typeof v !== 'object') return null;
	const o = v as {isVector2?: boolean; isVector3?: boolean; isVector4?: boolean; isColor?: boolean; isMatrix3?: boolean; isMatrix4?: boolean; toArray?: () => number[]; elements?: number[]};
	if (o.isColor || o.isVector2 || o.isVector3 || o.isVector4) return o.toArray!();
	if (o.isMatrix3 || o.isMatrix4) return Array.from(o.elements!);
	return null;
}

function uniformTrack(m: THREE.Material): UniformTrack | undefined {
	const sm = m as THREE.ShaderMaterial;
	if (!sm.isShaderMaterial) return undefined;
	const layout: [string, number][] = [];
	for (const name of Object.keys(sm.uniforms).sort()) {
		if (SHARED_UNIFORMS.has(name)) continue;
		const flat = flatten(sm.uniforms[name].value);
		if (flat) layout.push([name, flat.length]);
	}
	return layout.length ? {layout, track: new Track(layout.reduce((n, [, k]) => n + k, 0))} : undefined;
}

function uniformValues(m: THREE.ShaderMaterial, layout: [string, number][]): number[] {
	const out: number[] = [];
	for (const [name, size] of layout) {
		const flat = flatten(m.uniforms?.[name]?.value) ?? [];
		for (let i = 0; i < size; i++) out.push(flat[i] ?? 0);
	}
	return out;
}
