// Sample a model's sequence and print how its bones move:
//   animtest.ts models/props/portal_button.mdl [seq]
import {GameFiles} from '../src/game/files.ts';
import {loadSkeleton, samplePose, referencePose, sequenceRate} from '../src/game/anim.ts';
import {nodeFS} from './nodefs.ts';
const files = new GameFiles(nodeFS);
await files.init('portal2');
const mdl = (await files.read(process.argv[2]))!;
const sk = await loadSkeleton(files, mdl);
console.log(`${sk.bones.length} bones: ${sk.bones.slice(0, 8).map(b => b.name).join(', ')}`);
console.log(`${sk.sequences.length} sequences: ${sk.sequences.slice(0, 20).map((s, i) => `${i}:${s.label}${s.anim ? `(${s.anim.frames}f@${s.anim.fps}${s.anim.animBlock ? ' ani' : ''}${s.anim.sectionFrames ? ' sect' : ''})` : ''}`).join(' ')}`);
const seq = Number(process.argv[3] ?? 1);
const pose = referencePose(sk);
for (const c of [0, 0.25, 0.5, 0.75, 1]) {
	samplePose(sk, seq, c, pose);
	const moved = sk.bones.map((b, i) => Math.hypot(pose.pos[i * 3] - b.pos[0], pose.pos[i * 3 + 1] - b.pos[1], pose.pos[i * 3 + 2] - b.pos[2]) + 50 * Math.abs(Math.abs(pose.quat[i * 4] * b.quat[0] + pose.quat[i * 4 + 1] * b.quat[1] + pose.quat[i * 4 + 2] * b.quat[2] + pose.quat[i * 4 + 3] * b.quat[3]) - 1));
	console.log(`cycle ${c}: max change ${Math.max(...moved).toFixed(2)} (bone ${sk.bones[moved.indexOf(Math.max(...moved))].name}), rate ${sequenceRate(sk, seq).toFixed(3)}/s`);
}
