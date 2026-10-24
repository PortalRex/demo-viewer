// Entity models in a run: do they load, and do their materials resolve?
import {readFileSync} from 'node:fs';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities} from '../src/net/entities.ts';
import {GameFiles} from '../src/game/files.ts';
import {Materials} from '../src/game/materials.ts';
import {loadModel} from '../src/game/mdl.ts';
import {readVtf} from '../src/game/vtf.ts';
import {nodeFS} from './nodefs.ts';
const run = await loadRun(new Uint8Array(readFileSync(process.argv[2])), 'x');
const files = new GameFiles(nodeFS);
await files.init('portal2');
const mats = new Materials(files);
const seg = run.segments[Number(process.argv[3] ?? 0)];
const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
const models = new Map<string, string>();
for (const t of tl.tracks) if (t.model) models.set(t.model, t.className);
for (const [model, cls] of models) {
	if (model.startsWith('*')) continue;
	const m = await loadModel(files, model, [1, 1, 1]);
	if (!m) { console.log('FAILED  ', cls, model); continue; }
	const bad: string[] = [];
	for (const g of m.groups) {
		let ok = false;
		for (const c of g.materialCandidates) {
			const info = await mats.get(c);
			if (!info.found) continue;
			ok = true;
			const b = info.baseTexture ? await files.read(`materials/${info.baseTexture}.vtf`) : null;
			if (!b || !readVtf(b)) bad.push(`${c} -> tex "${info.baseTexture}" (${info.shader}) ${b ? 'unreadable' : 'missing'}`);
			break;
		}
		if (!ok) bad.push(g.materialCandidates[0]);
	}
	console.log(bad.length ? 'NO MAT  ' : 'ok      ', cls, model, bad.join(' '));
}
