// Gameplay entities in a segment and their props over time
import {readFileSync} from 'node:fs';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities, EXTRA_PROPS} from '../src/net/entities.ts';
const run = await loadRun(new Uint8Array(readFileSync(process.argv[2])), 'x');
const seg = run.segments[Number(process.argv[3] ?? 0)];
const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
for (const t of tl.tracks) {
	if (!EXTRA_PROPS[t.className] || t.className === 'CProp_Portal') continue;
	const ks = t.keys.filter(k => k.extra);
	const fmt = (v: unknown) => Array.isArray(v) ? `(${v.map(x => Number(x).toFixed(0)).join(' ')})` : typeof v === 'number' ? Number(v.toFixed(2)) : v;
	console.log(`${t.className} #${t.index} ${t.model}: ${ks.length} keys; first @${ks[0]?.tick}: ${ks[0] ? Object.entries(ks[0].extra!).map(([k, v]) => `${k}=${fmt(v)}`).join(' ') : ''}`);
}
const portals = tl.tracks.filter(t => t.className === 'CProp_Portal');
for (const p of portals.slice(0, 4)) { const k = p.keys.find(k => k.active); console.log(`portal #${p.index} linked ${k?.extra?.m_hLinkedPortal} -> index ${Number(k?.extra?.m_hLinkedPortal) & 2047} half ${k?.extra?.m_fNetworkHalfWidth}x${k?.extra?.m_fNetworkHalfHeight}`); }
