// Loads maps from the local install with the viewer's readers (geometry,
// materials, static props):
//   node --experimental-strip-types tools/bspprobe.ts sp_a1_intro1 sp_a2_column_blocker
import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {GameFiles} from '../src/game/files.ts';
import {Materials} from '../src/game/materials.ts';
import type {MaterialInfo} from '../src/game/materials.ts';
import {Zip} from '../src/game/zip.ts';
import {loadModel} from '../src/game/mdl.ts';
import {nodeFS, ROOT} from './nodefs.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
for (const map of process.argv.slice(2)) {
	const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`));
	if (!path) {
		console.log(map, 'not found');
		continue;
	}
	const t0 = performance.now();
	let stats = '';
	const bsp = await loadBsp(nodeFS, path, map, {
		materials: async (names, pak) => {
			files.mapPak = pak ? new Zip(pak) : null;
			const mats = new Materials(files);
			const out = new Map<string, MaterialInfo>();
			await Promise.all(names.map(async n => out.set(n, await mats.get(n))));
			const found = [...out.values()].filter(m => m.found);
			stats = `${found.length}/${names.length} materials read, ${found.filter(m => m.noPortal).length} noportal, ${found.filter(m => m.translucent).length} translucent; missing: ${[...out].filter(([, m]) => !m.found).map(([n]) => n).slice(0, 4).join(', ')}`;
			return out;
		},
	});
	const tris = (m: {groups: {positions: Float32Array}[]}) => m.groups.reduce((n, g) => n + g.positions.length / 9, 0);
	console.log(`${map}: ${bsp.faceCount} faces, world ${tris(bsp.models[0])} tris, ${bsp.models[0].groups.length} materials, lightmap ${bsp.lightmap ? bsp.lightmap.width + 'x' + bsp.lightmap.height : 'none'}, ${(performance.now() - t0).toFixed(0)} ms`, bsp.warnings);
	console.log(`  ${stats}`);
	const unique = [...new Set(bsp.staticProps.map(p => p.model))];
	const t1 = performance.now();
	let ok = 0, triCount = 0;
	const failed: string[] = [];
	for (const m of unique) {
		const mdl = await loadModel(files, m, [0.5, 0.5, 0.5]).catch(e => (failed.push(`${m} (${e.message})`), null));
		if (mdl) {
			ok++;
			triCount += mdl.groups.reduce((n, g) => n + g.positions.length / 9, 0);
		} else if (!failed.some(f => f.startsWith(m))) failed.push(m);
	}
	console.log(`  ${bsp.staticProps.length} static props, ${unique.length} models: ${ok} loaded (${triCount} tris) in ${(performance.now() - t1).toFixed(0)} ms; failed: ${failed.slice(0, 4).join(', ')}`);
	if (bsp.staticProps[0]) console.log(`  first prop`, bsp.staticProps[0]);
}
