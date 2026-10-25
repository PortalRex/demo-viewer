// A model's sequences with their activities (ACT_...), filtered:
//   node --experimental-strip-types tools/actlist.ts <model.mdl> [activity regex]
import {GameFiles} from '../src/game/files.ts';
import {loadSkeleton} from '../src/game/anim.ts';
import {nodeFS} from './nodefs.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const [model, filter] = process.argv.slice(2);
const sk = await loadSkeleton(files, (await files.read(model))!);
sk.sequences.forEach((s, i) => {
	if (filter && !new RegExp(filter, 'i').test(s.activity)) return;
	console.log(`${i} ${s.activity || '-'} ${s.label}${s.delta ? ' (delta)' : ''}${s.looping ? ' (loop)' : ''}`);
});
