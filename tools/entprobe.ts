// Decodes the entities of each segment and prints a summary:
//   node --experimental-strip-types tools/entprobe.ts fixtures/showcase.sarp
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities, keyAt} from '../src/net/entities.ts';

for (const path of process.argv.slice(2)) {
	const run = await loadRun(new Uint8Array(readFileSync(path)), basename(path));
	console.log(`\n== ${run.fileName}`);
	for (const seg of run.segments) {
		const t0 = performance.now();
		const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
		const ms = performance.now() - t0;
		const keys = tl.tracks.reduce((n, t) => n + t.keys.length, 0);
		console.log(`segment ${seg.index} ${seg.map}: ${tl.tracks.length} entities, ${keys} keys, ${ms.toFixed(0)} ms, ${tl.errors.length} errors`);
		for (const e of tl.errors.slice(0, 5)) console.log(`  error: ${e}`);
		const top = [...tl.classCounts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, n]) => `${c}:${n}`).join(' ');
		console.log(`  ${top}`);
		if (tl.player) {
			const mid = seg.views[Math.floor(seg.views.length / 2)];
			const k = keyAt(tl.player, mid.tick);
			console.log(`  player ${tl.player.keys.length} keys; at tick ${mid.tick}: entity ${k?.origin.map(v => v.toFixed(1)).join(' ')} vs view ${mid.origin.map(v => v.toFixed(1)).join(' ')}`);
		}
		for (const p of tl.tracks.filter(t => t.className === 'CProp_Portal').slice(0, 4)) {
			const act = p.keys.filter(k => k.active);
			console.log(`  portal #${p.index} ${p.orange ? 'orange' : 'blue'} ${p.model}: ${p.keys.length} keys, ${act.length} active; first active ${act[0] ? act[0].origin.map(v => v.toFixed(0)).join(' ') + ' @' + act[0].tick : '-'}`);
		}
		const cube = tl.tracks.find(t => /cube/i.test(t.model));
		if (cube) console.log(`  cube ${cube.className} ${cube.model} mins ${cube.mins} maxs ${cube.maxs}, ${cube.keys.length} keys`);
	}
}
