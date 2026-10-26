// The liquid surfaces of maps (material, vertex count, height range):
//   node --experimental-strip-types tools/liquids.ts <map>...
import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {nodeFS, ROOT} from './nodefs.ts';

for (const map of process.argv.slice(2)) {
	const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
	const bsp = await loadBsp(nodeFS, path, map);
	bsp.models.forEach((m, id) => {
		for (const g of m.groups) {
			if (g.surface !== 'liquid') continue;
			let lo = Infinity, hi = -Infinity;
			for (let i = 2; i < g.positions.length; i += 3) lo = Math.min(lo, g.positions[i]), hi = Math.max(hi, g.positions[i]);
			console.log(map, `*${id}`, g.material, 'verts', g.positions.length / 3, 'z', lo, hi);
		}
	});
}
