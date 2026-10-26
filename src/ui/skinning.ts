// Posing studio models: bone matrices from a pose, baking a pose into
// geometry (static props, which the game draws posed with sequence 0), and
// live skinned models for animated entities.
import * as THREE from 'three';
import type {Skeleton, Pose, Gesture} from '../game/anim.ts';
import {referencePose, samplePose} from '../game/anim.ts';
import type {ModelGroup} from '../game/mdl.ts';

const poseToBone = (m: number[]) => new THREE.Matrix4().set(...(m as [number, number, number, number, number, number, number, number, number, number, number, number]), 0, 0, 0, 1);

// bone space -> model space, per bone, in a pose
export function boneMatrices(sk: Skeleton, pose: Pose): THREE.Matrix4[] {
	const world: THREE.Matrix4[] = [];
	const v = new THREE.Vector3(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
	sk.bones.forEach((b, i) => {
		v.fromArray(pose.pos, i * 3);
		q.fromArray(pose.quat, i * 4);
		const local = new THREE.Matrix4().compose(v, q, one);
		world.push(b.parent >= 0 && world[b.parent] ? world[b.parent].clone().multiply(local) : local);
	});
	return world;
}

// model space -> posed model space, per bone
export function skinMatrices(sk: Skeleton, pose: Pose): THREE.Matrix4[] {
	const world = boneMatrices(sk, pose);
	return sk.bones.map((b, i) => world[i].clone().multiply(poseToBone(b.poseToBone)));
}

// an attachment's transform in model space
export function attachmentMatrix(sk: Skeleton, bones: THREE.Matrix4[], index: number): THREE.Matrix4 | null {
	const a = sk.attachments[index];
	if (!a || !bones[a.bone]) return null;
	return bones[a.bone].clone().multiply(poseToBone(a.local));
}

// positions and normals of a group in the pose (or null if the pose doesn't
// move anything)
export function bakePose(g: ModelGroup, mats: THREE.Matrix4[]): {positions: Float32Array; normals: Float32Array} | null {
	if (mats.every(m => m.equals(IDENTITY))) return null;
	const n = g.positions.length / 3;
	const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
	const p = new THREE.Vector3(), nr = new THREE.Vector3(), out = new THREE.Vector3(), outN = new THREE.Vector3(), tmp = new THREE.Vector3();
	const nm = mats.map(m => new THREE.Matrix3().setFromMatrix4(m));
	for (let i = 0; i < n; i++) {
		p.fromArray(g.positions, i * 3);
		nr.fromArray(g.normals, i * 3);
		out.set(0, 0, 0);
		outN.set(0, 0, 0);
		let total = 0;
		for (let k = 0; k < 4; k++) {
			const w = g.skinWeight[i * 4 + k];
			const m = mats[g.skinIndex[i * 4 + k]];
			if (!w || !m) continue;
			out.addScaledVector(tmp.copy(p).applyMatrix4(m), w);
			outN.addScaledVector(tmp.copy(nr).applyMatrix3(nm[g.skinIndex[i * 4 + k]]), w);
			total += w;
		}
		if (!total) {
			out.copy(p);
			outN.copy(nr);
		}
		out.toArray(positions, i * 3);
		outN.normalize().toArray(normals, i * 3);
	}
	return {positions, normals};
}
const IDENTITY = new THREE.Matrix4();

// A model whose bones follow an animation: skinned meshes sharing one
// skeleton, bones as children of the returned group (so the entity's
// transform carries them). Its bounds follow the pose: each bone with the
// farthest any of its vertices reaches from it, all in one box (for
// culling and ray tests); a ray that reaches the box is tested against the
// triangles of the bones it passes near, only their vertices posed (three's
// own test skins every vertex again for every triangle).
export class AnimatedModel {
	readonly group = new THREE.Group();
	private sk: Skeleton;
	private bones: THREE.Bone[];
	private reach: Float32Array;  // per bone (-1: moves no vertex)
	private bounds = new THREE.Sphere();
	private box = new THREE.Box3();
	private boneMats: THREE.Matrix4[] = [];
	private stamp = 0;  // the pose's number (posed vertices are kept per pose)
	private skinMats: Float32Array | null = null;
	private skinMatsStamp = -1;
	private rayStamp = 0;
	readonly pose: Pose;
	private last = '';

	constructor(sk: Skeleton, meshes: {geometry: THREE.BufferGeometry; material: THREE.Material}[]) {
		this.sk = sk;
		this.pose = referencePose(sk);
		this.bones = sk.bones.map(b => {
			const bone = new THREE.Bone();
			bone.name = b.name;
			return bone;
		});
		sk.bones.forEach((b, i) => (b.parent >= 0 ? this.bones[b.parent] : this.group).add(this.bones[i]));
		const inverses = sk.bones.map(b => poseToBone(b.poseToBone));
		const skeleton = new THREE.Skeleton(this.bones, inverses);
		this.reach = new Float32Array(sk.bones.length).fill(-1);
		const v = new THREE.Vector3();
		for (const m of meshes) {
			const mesh = new THREE.SkinnedMesh(m.geometry, m.material);
			mesh.bind(skeleton, new THREE.Matrix4());
			mesh.boundingSphere = this.bounds;
			mesh.boundingBox = this.box;
			this.group.add(mesh);
			const pos = m.geometry.getAttribute('position'), index = m.geometry.getAttribute('skinIndex'), weight = m.geometry.getAttribute('skinWeight');
			if (!pos || !index || !weight) continue;
			const ray = rayMesh(m.geometry);
			if (ray) {
				mesh.raycast = (r, hits) => this.raycast(mesh, ray, r, hits);
			}
			for (let i = 0; i < pos.count; i++) {
				for (let k = 0; k < 4; k++) {
					const b = index.getComponent(i, k);
					if (!weight.getComponent(i, k) || !inverses[b]) continue;
					// (its distance from the bone, in the bone's own space)
					this.reach[b] = Math.max(this.reach[b], v.fromBufferAttribute(pos, i).applyMatrix4(inverses[b]).length());
				}
			}
		}
		this.setPose(0, 0);
	}

	setPose(sequence: number, cycle: number, params?: Record<string, number>, gestures: Gesture[] = []) {
		const key = `${sequence}:${cycle.toFixed(4)}:${params ? Object.values(params).map(v => v.toFixed(1)).join(',') : ''}:${gestures.map(g => `${g.seq}/${g.cycle.toFixed(3)}/${g.weight.toFixed(2)}`).join(',')}`;
		if (key === this.last) return;
		this.last = key;
		samplePose(this.sk, sequence, cycle, this.pose, params, gestures);
		this.stamp++;
		this.bones.forEach((bone, i) => {
			bone.position.fromArray(this.pose.pos, i * 3);
			bone.quaternion.fromArray(this.pose.quat, i * 4);
		});
		this.fitBounds();
	}

	// the box around every vertex-moving bone and its reach, in the pose
	private fitBounds() {
		const p = new THREE.Vector3(), r = new THREE.Vector3();
		this.box.makeEmpty();
		this.boneMats = boneMatrices(this.sk, this.pose);
		this.boneMats.forEach((m, i) => {
			if (this.reach[i] < 0) return;
			p.setFromMatrixPosition(m);
			r.setScalar(this.reach[i]);
			this.box.expandByPoint(p.clone().sub(r)).expandByPoint(p.add(r));
		});
		if (this.box.isEmpty()) this.box.set(p.set(0, 0, 0), p.clone());
		this.box.getBoundingSphere(this.bounds);
	}

	// how far along a ray it's hit, as shots hit models: their hitboxes,
	// each a box on its bone (null: missed, or no hitboxes)
	hitboxDistance(ray: THREE.Ray, world: THREE.Matrix4): number | null {
		const boxes = this.sk.hitboxes;
		if (!boxes.length) return null;
		const local = new THREE.Ray(), box = new THREE.Box3(), at = new THREE.Vector3(), m = new THREE.Matrix4();
		let best: number | null = null;
		for (const h of boxes) {
			const bone = this.boneMats[h.bone];
			if (!bone) continue;
			m.multiplyMatrices(world, bone);
			local.copy(ray).applyMatrix4(m.clone().invert());
			box.min.fromArray(h.min);
			box.max.fromArray(h.max);
			if (!local.intersectBox(box, at)) continue;
			const d = at.applyMatrix4(m).distanceTo(ray.origin);
			if (best === null || d < best) best = d;
		}
		return best;
	}

	get hasHitboxes() {
		return this.sk.hitboxes.length > 0;
	}

	private raycast(mesh: THREE.SkinnedMesh, rm: RayMesh, raycaster: THREE.Raycaster, hits: THREE.Intersection[]) {
		const world = new THREE.Sphere().copy(this.bounds).applyMatrix4(mesh.matrixWorld);
		if (!raycaster.ray.intersectsSphere(world)) return;
		const local = raycaster.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
		if (!local.intersectsBox(this.box)) return;
		// the skinning matrices, flat, once per pose
		if (this.skinMatsStamp !== this.stamp || !this.skinMats) {
			const mats = skinMatrices(this.sk, this.pose);
			this.skinMats ??= new Float32Array(mats.length * 16);
			mats.forEach((m, i) => this.skinMats!.set(m.elements, i * 16));
			this.skinMatsStamp = this.stamp;
		}
		if (rm.poseStamp !== this.stamp) {
			rm.poseStamp = this.stamp;
			rm.done.fill(0);
		}
		const tick = ++this.rayStamp;
		const centre = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), at = new THREE.Vector3();
		for (const [bone, tris] of rm.boneTris) {
			const reach = this.reach[bone], m = this.boneMats[bone];
			if (reach < 0 || !m || local.distanceSqToPoint(centre.setFromMatrixPosition(m)) > reach * reach) continue;
			for (let n = 0; n < tris.length; n++) {
				const tri = tris[n];
				if (rm.seen[tri] === tick) continue;
				rm.seen[tri] = tick;
				const i0 = rm.index ? rm.index[tri * 3] : tri * 3, i1 = rm.index ? rm.index[tri * 3 + 1] : tri * 3 + 1, i2 = rm.index ? rm.index[tri * 3 + 2] : tri * 3 + 2;
				this.posedVertex(rm, i0, a);
				this.posedVertex(rm, i1, b);
				this.posedVertex(rm, i2, c);
				// (either side: what blocks a line of sight)
				if (!local.intersectTriangle(a, b, c, false, at)) continue;
				const point = at.clone().applyMatrix4(mesh.matrixWorld);
				const distance = point.distanceTo(raycaster.ray.origin);
				if (distance < raycaster.near || distance > raycaster.far) continue;
				hits.push({distance, point, object: mesh, faceIndex: tri});
			}
		}
	}

	// a vertex in the current pose (each worked out once per pose)
	private posedVertex(rm: RayMesh, i: number, out: THREE.Vector3) {
		const p = rm.posed;
		if (!rm.done[i]) {
			const e = this.skinMats!, x = rm.pos[i * 3], y = rm.pos[i * 3 + 1], z = rm.pos[i * 3 + 2];
			let px = 0, py = 0, pz = 0, total = 0;
			for (let k = 0; k < 4; k++) {
				const w = rm.weight[i * 4 + k];
				if (!w) continue;
				const o = rm.bone[i * 4 + k] * 16;
				if (o + 16 > e.length) continue;
				px += w * (e[o] * x + e[o + 4] * y + e[o + 8] * z + e[o + 12]);
				py += w * (e[o + 1] * x + e[o + 5] * y + e[o + 9] * z + e[o + 13]);
				pz += w * (e[o + 2] * x + e[o + 6] * y + e[o + 10] * z + e[o + 14]);
				total += w;
			}
			if (total) {
				p[i * 3] = px / total;
				p[i * 3 + 1] = py / total;
				p[i * 3 + 2] = pz / total;
			} else {
				p[i * 3] = x;
				p[i * 3 + 1] = y;
				p[i * 3 + 2] = z;
			}
			rm.done[i] = 1;
		}
		return out.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
	}
}

// what a skinned mesh's ray test needs: its vertices, their bones, and for
// each bone the triangles it moves
interface RayMesh {
	pos: ArrayLike<number>;
	bone: ArrayLike<number>;
	weight: ArrayLike<number>;
	index: ArrayLike<number> | null;
	boneTris: Map<number, Uint32Array>;
	posed: Float32Array;   // vertices in the pose (where done)
	done: Uint8Array;
	poseStamp: number;
	seen: Uint32Array;     // per triangle: the ray it was last tested for
}

function rayMesh(g: THREE.BufferGeometry): RayMesh | null {
	const pos = g.getAttribute('position'), bone = g.getAttribute('skinIndex'), weight = g.getAttribute('skinWeight');
	if (!(pos instanceof THREE.BufferAttribute) || !(bone instanceof THREE.BufferAttribute) || !(weight instanceof THREE.BufferAttribute)) return null;
	const index = g.index?.array ?? null;
	const triangles = index ? index.length / 3 : pos.count / 3;
	const lists = new Map<number, number[]>();
	const vertexBones = (v: number, into: Set<number>) => {
		for (let k = 0; k < 4; k++) if (weight.array[v * 4 + k]) into.add(bone.array[v * 4 + k]);
	};
	const bones = new Set<number>();
	for (let t = 0; t < triangles; t++) {
		bones.clear();
		for (let k = 0; k < 3; k++) vertexBones(index ? index[t * 3 + k] : t * 3 + k, bones);
		for (const b of bones) {
			let list = lists.get(b);
			if (!list) lists.set(b, list = []);
			list.push(t);
		}
	}
	return {
		pos: pos.array, bone: bone.array, weight: weight.array, index,
		boneTris: new Map([...lists].map(([b, list]) => [b, Uint32Array.from(list)])),
		posed: new Float32Array(pos.count * 3), done: new Uint8Array(pos.count), poseStamp: -1, seen: new Uint32Array(triangles),
	};
}

export function skinnedGeometry(g: ModelGroup, base: THREE.BufferGeometry): THREE.BufferGeometry {
	const geo = base.clone();
	geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(g.skinIndex, 4));
	geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(g.skinWeight, 4));
	return geo;
}
