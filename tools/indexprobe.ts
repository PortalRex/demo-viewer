// The tracks at a network index (class, model, ticks, serial):
//   node --experimental-strip-types tools/indexprobe.ts <file> <index> [handle]
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities} from '../src/net/entities.ts';

const [path, index] = process.argv.slice(2);
const run = await loadRun(new Uint8Array(readFileSync(path)), basename(path));
const seg = run.segments[0];
const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
for (const t of tl.tracks.filter(t => t.index === Number(index))) {
	console.log(t.className, t.model, t.keys[0]?.tick, '-', t.keys.at(-1)?.tick, 'serial', (t as unknown as {serial?: number}).serial);
}
const p = tl.tracks.find(t => t.className === 'CPortal_Player')!;
const hs = new Set(p.keys.map(k => Number(k.extra?.m_hAttachedObject ?? -1)).filter(h => h >= 0 && (h & 2047) !== 2047));
console.log('held handles', [...hs].map(h => `${h & 2047}#${h >> 11}`));
