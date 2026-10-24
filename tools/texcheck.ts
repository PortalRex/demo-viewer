// Which of a map's materials don't end up with a readable base texture
import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {GameFiles} from '../src/game/files.ts';
import {Materials} from '../src/game/materials.ts';
import type {MaterialInfo} from '../src/game/materials.ts';
import {Zip} from '../src/game/zip.ts';
import {readVtf} from '../src/game/vtf.ts';
import {nodeFS, ROOT} from './nodefs.ts';
const files = new GameFiles(nodeFS);
await files.init('portal2');
const map = process.argv[2];
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const mats = new Materials(files);
const bsp = await loadBsp(nodeFS, path, map, {materials: async (names, pak) => {
	files.mapPak = pak ? new Zip(pak) : null;
	const out = new Map<string, MaterialInfo>();
	await Promise.all(names.map(async n => out.set(n, await mats.get(n))));
	return out;
}});
const formats = new Map<number, number>();
for (const [name, m] of bsp.materials) {
	if (!m.found) { console.log('missing vmt', name); continue; }
	if (!m.baseTexture) { console.log('no $basetexture', name, m.shader); continue; }
	const b = await files.read(`materials/${m.baseTexture}.vtf`);
	if (!b) { console.log('missing vtf', name, '->', m.baseTexture); continue; }
	const img = readVtf(b);
	if (!img) { console.log('unreadable vtf', name, '->', m.baseTexture, 'version', new DataView(b.buffer, b.byteOffset).getUint32(8, true), 'format', new DataView(b.buffer, b.byteOffset).getInt32(52, true)); continue; }
	formats.set(img.format, (formats.get(img.format) ?? 0) + 1);
}
console.log('formats', [...formats]);

// model materials (static props)
import {loadModel} from '../src/game/mdl.ts';
const seen = new Set<string>();
for (const p of bsp.staticProps) {
	if (seen.has(p.model)) continue;
	seen.add(p.model);
	const m = await loadModel(files, p.model, [1, 1, 1], p.skin);
	if (!m) { console.log('model failed', p.model); continue; }
	for (const g of m.groups) {
		let ok = false;
		for (const c of g.materialCandidates) if ((await mats.get(c)).found) { ok = true; break; }
		if (!ok) console.log('model material missing', p.model, g.materialCandidates);
	}
}
