// Posing studio models: bone matrices from a pose, baking a pose into
// geometry (static props, which the game draws posed with sequence 0), and
// live skinned models for animated entities.
import * as THREE from 'three';
import type {Skeleton, Pose} from '../game/anim.ts';
import {referencePose, samplePose} from '../game/anim.ts';
import type {ModelGroup} from '../game/mdl.ts';

const poseToBone = (m: number[]) => new THREE.Matrix4().set(...(m as [number, number, number, number, number, number, number, number, number, number, number, number]), 0, 0, 0, 1);

// model space -> posed model space, per bone
export function skinMatrices(sk: Skeleton, pose: Pose): THREE.Matrix4[] {
	const world: THREE.Matrix4[] = [];
	const v = new THREE.Vector3(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
	sk.bones.forEach((b, i) => {
		v.fromArray(pose.pos, i * 3);
		q.fromArray(pose.quat, i * 4);
		const local = new THREE.Matrix4().compose(v, q, one);
		world.push(b.parent >= 0 && world[b.parent] ? world[b.parent].clone().multiply(local) : local);
	});
	return sk.bones.map((b, i) => world[i].clone().multiply(poseToBone(b.poseToBone)));
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
// transform carries them).
export class AnimatedModel {
	readonly group = new THREE.Group();
	private sk: Skeleton;
	private bones: THREE.Bone[];
	private pose: Pose;
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
		const skeleton = new THREE.Skeleton(this.bones, sk.bones.map(b => poseToBone(b.poseToBone)));
		for (const m of meshes) {
			const mesh = new THREE.SkinnedMesh(m.geometry, m.material);
			mesh.frustumCulled = false;  // bounds don't follow the bones
			mesh.bind(skeleton, new THREE.Matrix4());
			this.group.add(mesh);
		}
		this.setPose(0, 0);
	}

	setPose(sequence: number, cycle: number) {
		const key = `${sequence}:${cycle.toFixed(4)}`;
		if (key === this.last) return;
		this.last = key;
		samplePose(this.sk, sequence, cycle, this.pose);
		this.bones.forEach((bone, i) => {
			bone.position.fromArray(this.pose.pos, i * 3);
			bone.quaternion.fromArray(this.pose.quat, i * 4);
		});
	}
}

export function skinnedGeometry(g: ModelGroup, base: THREE.BufferGeometry): THREE.BufferGeometry {
	const geo = base.clone();
	geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(g.skinIndex, 4));
	geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(g.skinWeight, 4));
	return geo;
}
