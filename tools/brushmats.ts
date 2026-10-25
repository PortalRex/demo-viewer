// A brush model's materials and how bright its lightmap is under each:
//   node --experimental-strip-types tools/brushmats.ts <map> <model index>...
import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {nodeFS, ROOT} from './nodefs.ts';

const [map, ...ids] = process.argv.slice(2);
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const bsp = await loadBsp(nodeFS, path, map);
const lm = bsp.lightmap!;
for (const id of ids.map(Number)) {
	for (const g of bsp.models[id].groups) {
		const uv = g.lightUv;
		let sum = 0, n = 0;
		if (uv) for (let i = 0; i < uv.length; i += 2) {
			const x = Math.min(lm.width - 1, Math.floor(uv[i] * lm.width)), y = Math.min(lm.height - 1, Math.floor(uv[i + 1] * lm.height));
			const o = (y * lm.width + x) * 4;
			sum += (lm.data[o] + lm.data[o + 1] + lm.data[o + 2]) / 3;
			n++;
		}
		console.log(`*${id}`, g.material, 'verts', g.positions.length / 3, 'light', n ? (sum / n).toFixed(4) : '-');
	}
}
