import {GameFiles} from '../src/game/files.ts';
import {loadSkeleton, samplePose, referencePose} from '../src/game/anim.ts';
import {nodeFS} from './nodefs.ts';
const files = new GameFiles(nodeFS);
await files.init('portal2');
const mdl = (await files.read(process.argv[2]))!;
const sk = await loadSkeleton(files, mdl);
const seq = Number(process.argv[3]);
const a = sk.sequences[seq].anim!;
console.log('desc', {fps: a.fps, flags: a.flags.toString(16), frames: a.frames, block: a.animBlock, index: a.animIndex, sectionFrames: a.sectionFrames, sectionIndex: a.sectionIndex});
// raw anim records
const v = new DataView(mdl.buffer, mdl.byteOffset, mdl.byteLength);
let p = a.offset + a.animIndex;
for (let i = 0; i < 30; i++) {
	const bone = v.getUint8(p), flags = v.getUint8(p + 1), next = v.getInt16(p + 2, true);
	console.log(`  rec @${p}: bone ${bone} (${sk.bones[bone]?.name}) flags ${flags.toString(2)} next ${next}`);
	if (!next) break;
	p += next;
}
const pose = referencePose(sk);
for (const c of [0, 1]) {
	samplePose(sk, seq, c, pose);
	sk.bones.forEach((b, i) => console.log(`c${c} ${b.name}: pos ${[...pose.pos.slice(i * 3, i * 3 + 3)].map(x => x.toFixed(1))} ref ${b.pos.map(x => x.toFixed(1))} q ${[...pose.quat.slice(i * 4, i * 4 + 4)].map(x => x.toFixed(2))} refq ${b.quat.map(x => x.toFixed(2))}`));
}
