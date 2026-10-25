// Which recordings have entities of a class (regex), and when:
//   node --experimental-strip-types tools/classfind.ts <class regex> <file>...
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities} from '../src/net/entities.ts';

const re = new RegExp(process.argv[2]);
for (const path of process.argv.slice(3)) {
	const run = await loadRun(new Uint8Array(readFileSync(path)), basename(path));
	run.segments.forEach((seg, i) => {
		const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
		const hits = tl.tracks.filter(t => re.test(t.className) && t.keys.length);
		if (hits.length) console.log(`${basename(path)} #${i} ${seg.map ?? ''}: ${hits.map(t => `${t.className}@${t.keys[0].tick}-${t.keys.at(-1)!.tick}`).join(' ')}`);
	});
}
