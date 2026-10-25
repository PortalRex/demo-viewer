// A model's sequences (index, label, looping, frames) and attachments:
//   node --experimental-strip-types tools/seqlist.ts models/x.mdl [label filter]
import {GameFiles} from '../src/game/files.ts';
import {loadSkeleton} from '../src/game/anim.ts';
import {nodeFS} from './nodefs.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const sk = await loadSkeleton(files, (await files.read(process.argv[2]))!);
const re = new RegExp(process.argv[3] ?? '.', 'i');
console.log(`${sk.bones.length} bones, ${sk.sequences.length} sequences; attachments: ${sk.attachments.map((a, i) => `${i + 1}:${a.name}@${sk.bones[a.bone]?.name}`).join(' ')}`);
sk.sequences.forEach((s, i) => {
	if (re.test(s.label)) console.log(`  ${i} ${s.label}${s.looping ? " (loop)" : ""} [${s.groupSize} ${s.params.join(",")} ${JSON.stringify(s.paramRange)}] frames ${s.anim?.frames ?? '-'} fps ${s.anim?.fps ?? '-'}`);
});
