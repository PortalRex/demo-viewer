// A model's attachments and its first bone's axes (portal particle anchors):
//   node --experimental-strip-types tools/attachments.ts
import {GameFiles} from '../src/game/files.ts';
import {loadSkeleton} from '../src/game/anim.ts';
import {nodeFS} from './nodefs.ts';
const files = new GameFiles(nodeFS);
await files.init('portal2');
for (const m of ['models/portals/portal1.mdl', 'models/portals/portal2.mdl']) {
	const sk = await loadSkeleton(files, (await files.read(m))!);
	for (const a of sk.attachments) console.log(m, a.name, sk.bones[a.bone]?.name, a.local.map(x => x.toFixed(3)).join(' '));
	console.log('bones', sk.bones.map(b => b.name + ':' + b.pos.map(x => x.toFixed(1)) + ':' + b.rot.map(x => x.toFixed(2))).join(' | '));
}
import * as THREE from 'three';
const sk2 = await loadSkeleton(files, (await files.read('models/portals/portal1.mdl'))!);
const b = sk2.bones[0];
const q = new THREE.Quaternion(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
m.extractBasis(x, y, z);
console.log('quat', b.quat.map(v => v.toFixed(3)).join(' '), 'X', x.toArray().map(v => v.toFixed(2)), 'Y', y.toArray().map(v => v.toFixed(2)), 'Z', z.toArray().map(v => v.toFixed(2)));
console.log('poseToBone', b.poseToBone.map(v => v.toFixed(2)).join(' '));
