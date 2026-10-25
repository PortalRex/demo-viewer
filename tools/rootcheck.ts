// Root bone pose per sequence/blend:  node --experimental-strip-types tools/rootcheck.ts models/x.mdl label...
import {GameFiles} from '../src/game/files.ts';
import {loadSkeleton, samplePose, referencePose} from '../src/game/anim.ts';
import {nodeFS} from './nodefs.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const sk = await loadSkeleton(files, (await files.read(process.argv[2]))!);
const pose = referencePose(sk);
const fmt = (a: ArrayLike<number>, o: number, n: number) => Array.from({length: n}, (_, i) => a[o + i].toFixed(2)).join(',');
console.log('ref root', fmt(pose.pos, 0, 3), fmt(pose.quat, 0, 4), sk.bones[0].name, 'bone1', sk.bones[1]?.name, fmt(pose.quat, 4, 4));
for (const label of process.argv.slice(3)) {
	const i = sk.sequences.findIndex(s => s.label === label);
	const s = sk.sequences[i];
	if (!s) continue;
	for (const [mx, my] of [[1, 0], [0, 0], [0, 1]]) {
		samplePose(sk, i, 0.3, pose, {move_x: mx, move_y: my});
		console.log(label, `x${mx} y${my}`, 'root', fmt(pose.pos, 0, 3), fmt(pose.quat, 0, 4), 'b1', fmt(pose.quat, 4, 4), 'flags', s.blends.map(b => b?.flags.toString(16)).join(' '));
	}
}
