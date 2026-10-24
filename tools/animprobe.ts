// Animated entities in a segment: sequences used, client-side or not
import {readFileSync} from 'node:fs';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities} from '../src/net/entities.ts';
const run = await loadRun(new Uint8Array(readFileSync(process.argv[2])), 'x');
const seg = run.segments[Number(process.argv[3] ?? 0)];
const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
for (const t of tl.tracks) {
	const a = t.keys.filter(k => k.anim);
	if (!a.length || !t.model.endsWith('.mdl')) continue;
	const seqs = [...new Set(a.map(k => k.anim!.sequence))];
	const cs = a.some(k => k.anim!.clientSide);
	const cycles = a.map(k => k.anim!.cycle);
	if (seqs.length > 1 || new Set(cycles).size > 1) console.log(`${t.className} ${t.model}: seqs ${seqs.join(',')} clientSide ${cs} keys ${a.length} cycles ${[...new Set(cycles)].slice(0, 5).map(c => c.toFixed(2)).join(',')}`);
}
