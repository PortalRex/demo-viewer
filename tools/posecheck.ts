// Is a model's mesh stored in the posed space? Compare its bounds, raw and
// skinned with sequence 0, against the header's hull.
import {GameFiles} from '../src/game/files.ts';
import {loadModel} from '../src/game/mdl.ts';
import {loadSkeleton, samplePose, referencePose} from '../src/game/anim.ts';
import {nodeFS} from './nodefs.ts';
import * as THREE from 'three';
const files = new GameFiles(nodeFS);
await files.init('portal2');
for (const name of process.argv.slice(2)) {
	const m = (await loadModel(files, name, [1, 1, 1]))!;
	const sk = await loadSkeleton(files, m.bytes);
	const pose = referencePose(sk);
	samplePose(sk, 0, 0, pose);
	// bone world matrices
	const world: THREE.Matrix4[] = [];
	sk.bones.forEach((b, i) => {
		const local = new THREE.Matrix4().compose(new THREE.Vector3(...pose.pos.slice(i * 3, i * 3 + 3)), new THREE.Quaternion(...pose.quat.slice(i * 4, i * 4 + 4)), new THREE.Vector3(1, 1, 1));
		world.push(b.parent >= 0 ? world[b.parent].clone().multiply(local) : local);
	});
	const skin = sk.bones.map((b, i) => { const m = new THREE.Matrix4(); m.elements.splice(0, 16, ...new THREE.Matrix4().set(b.poseToBone[0], b.poseToBone[1], b.poseToBone[2], b.poseToBone[3], b.poseToBone[4], b.poseToBone[5], b.poseToBone[6], b.poseToBone[7], b.poseToBone[8], b.poseToBone[9], b.poseToBone[10], b.poseToBone[11], 0, 0, 0, 1).elements); return world[i].clone().multiply(m); });
	const raw = new THREE.Box3(), posed = new THREE.Box3();
	for (const g of m.groups) for (let v = 0; v < g.positions.length / 3; v++) {
		const p = new THREE.Vector3(g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]);
		raw.expandByPoint(p);
		const out = new THREE.Vector3();
		for (let k = 0; k < 4; k++) {
			const w = g.skinWeight[v * 4 + k];
			if (w) out.addScaledVector(p.clone().applyMatrix4(skin[g.skinIndex[v * 4 + k]]), w);
		}
		posed.expandByPoint(out);
	}
	const f = (b: THREE.Box3) => `${b.min.toArray().map(x => x.toFixed(0))} .. ${b.max.toArray().map(x => x.toFixed(0))}`;
	console.log(`${name}\n  hull ${m.min.map(x => x.toFixed(0))} .. ${m.max.map(x => x.toFixed(0))}\n  raw  ${f(raw)}\n  posed ${f(posed)}`);
}
