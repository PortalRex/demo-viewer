// Dispatched effects (temp entities) in a recording:
//   node --experimental-strip-types tools/fxlist.ts <file>
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities} from '../src/net/entities.ts';

for (const path of process.argv.slice(2)) {
	const run = await loadRun(new Uint8Array(readFileSync(path)), basename(path));
	for (const seg of run.segments) {
		const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
		const counts = new Map<string, number>();
		for (const e of tl.effects) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
		console.log(`${seg.map}: ${tl.effects.length} effects ${[...counts].map(([k, n]) => `${k}:${n}`).join(' ')}; errors ${tl.errors.length} ${tl.errors.slice(0, 2).join(' | ')}`);
		for (const e of tl.effects.slice(0, 8)) console.log(`  @${e.tick} ${e.name} origin ${e.origin.map(Math.round)} start ${e.start.map(Math.round)} color ${e.color} ent ${e.entity} att ${e.attachment} hitbox ${e.hitbox} scale ${e.scale.toFixed(2)}${e.name === 'ParticleEffect' ? ' -> ' + tl.particleNames[e.hitbox] : ''}`);
	}
}
