// The info_particle_system effects a recording shows, with when they're active:
//   node --experimental-strip-types tools/partprobe.ts <file>
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities} from '../src/net/entities.ts';

for (const path of process.argv.slice(2)) {
	const run = await loadRun(new Uint8Array(readFileSync(path)), basename(path));
	for (const seg of run.segments) {
		const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
		console.log(`${seg.map}: ${tl.particleNames.length} effect names`);
		for (const t of tl.tracks.filter(t => t.className === 'CParticleSystem')) {
			const k = t.keys[0];
			const e = k.extra ?? {};
			const act = t.keys.filter(k => Number(k.extra?.m_bActive)).map(k => k.tick);
			console.log(`  #${t.index} ${tl.particleNames[Number(e.m_iEffectIndex)]} at ${k.origin.map(Math.round)} active ticks ${act[0] ?? '-'}..${act.at(-1) ?? '-'} start ${e.m_flStartTime} keys ${t.keys.length}`);
		}
	}
}
