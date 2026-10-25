// Screen fades (the "Fade" user messages) in recordings:
//   node --experimental-strip-types tools/fadelist.ts <files...>
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities} from '../src/net/entities.ts';

for (const path of process.argv.slice(2)) {
	const run = await loadRun(new Uint8Array(readFileSync(path)), basename(path));
	run.segments.forEach((seg, i) => {
		const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
		const list = tl.fades.map(f => `${f.tick}:${f.flags}/${f.duration}+${f.hold}/${f.color.join(',')}`).join(' ');
		console.log(`${basename(path)} #${i} ${seg.map ?? ''}: ${list || '-'}`);
	});
}
