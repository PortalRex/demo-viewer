// Paint events in a segment
import {readFileSync} from 'node:fs';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities} from '../src/net/entities.ts';
const run = await loadRun(new Uint8Array(readFileSync(process.argv[2])), 'x');
const seg = run.segments[Number(process.argv[3] ?? 0)];
const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
const kinds = new Map<string, number>();
for (const e of tl.paint) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
console.log(seg.map, [...kinds], tl.errors.length, 'errors');
const m = tl.paint.find(e => e.kind === 'map');
if (m && m.kind === 'map') console.log(' map: surfaces', m.surfaces.length, m.surfaces.slice(0, 3).map(s => `${s.face}:${s.data.length}b first ${[...s.data.slice(0, 8)].join(',')}`));
const w = tl.paint.filter(e => e.kind === 'world').slice(0, 3);
for (const e of w) if (e.kind === 'world') console.log(` world @${e.tick} power ${e.power} ent ${e.entity} r ${e.radius.toFixed(1)} a ${e.alpha.toFixed(2)} pts ${e.points.length} first ${e.points[0]?.map(Math.round)}`);
