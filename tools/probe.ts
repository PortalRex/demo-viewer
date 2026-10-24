// Loads files with the viewer's readers and prints a summary:
//   npm run probe -- fixtures/fullgame.sarp fixtures/showcase_conv.dem
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {segmentDuration} from '../src/core/model.ts';
import {describeSarEvent} from '../src/core/sardata.ts';

for (const path of process.argv.slice(2)) {
	const bytes = new Uint8Array(readFileSync(path));
	const t0 = performance.now();
	const run = await loadRun(bytes, basename(path));
	console.log(`\n== ${run.fileName} (${run.format}, ${(run.fileSize / 1024).toFixed(0)} KB, read in ${(performance.now() - t0).toFixed(0)} ms)`);
	console.log(`game ${run.game}, player ${run.player}`);
	for (const [k, v] of run.info) console.log(`  ${k}: ${v}`);
	if (run.verification) for (const [k, c] of Object.entries(run.verification)) console.log(`  [${c.state}] ${k}: ${c.detail}`);
	for (const w of run.warnings) console.log(`  warning: ${w}`);
	for (const s of run.segments) {
		console.log(`  segment ${s.index} ${s.map}: ticks ${s.firstTick}..${s.lastTick} (${segmentDuration(s).toFixed(2)} s), ${s.views.length} views, ${s.userCmds.length} usercmds, ${s.consoleCmds.length} cmds, ${s.sar.length} sar${s.endReason ? `, end: ${s.endReason}` : ''}`);
		const v = s.views[Math.floor(s.views.length / 2)];
		if (v) console.log(`    mid view tick ${v.tick} at ${v.origin.map(x => x.toFixed(1)).join(' ')} ang ${v.angles.map(x => x.toFixed(1)).join(' ')}`);
		const c = s.userCmds.find(u => u.buttons || u.forwardMove);
		if (c) console.log(`    first active usercmd tick ${c.tick}: buttons ${c.buttons} fwd ${c.forwardMove} side ${c.sideMove} ang ${c.viewAngles.map(x => x.toFixed(1)).join(' ')}`);
		for (const e of s.sar.filter(e => e.kind !== 'entityInput' && e.kind !== 'cvar' && e.kind !== 'fileChecksum').slice(0, 6)) console.log(`    sar @${e.tick}: ${describeSarEvent(e)}`);
		for (const cmd of s.consoleCmds.filter(c => !c.initialValue).slice(0, 4)) console.log(`    cmd @${cmd.tick}: ${cmd.text}`);
	}
}
