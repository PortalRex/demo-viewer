import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {nodeFS, ROOT} from './nodefs.ts';
const map = process.argv[2] ?? 'sp_a1_intro4';
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const bsp = await loadBsp(nodeFS, path, map);
const lm = bsp.lightmap!;
let sum = 0, n = 0, max = 0;
for (let i = 0; i < lm.data.length; i += 4) { const v = (lm.data[i] + lm.data[i + 1] + lm.data[i + 2]) / 3; sum += v; n++; max = Math.max(max, v); }
console.log('atlas', lm.width, lm.height, 'mean', (sum / n).toFixed(4), 'max', max.toFixed(3));
// sample the atlas at every world vertex's light uv
let s2 = 0, n2 = 0, out = 0;
for (const g of bsp.models[0].groups) {
	for (let i = 0; i < g.lightUv!.length; i += 2) {
		const u = g.lightUv![i], v = g.lightUv![i + 1];
		if (u < 0 || u > 1 || v < 0 || v > 1) { out++; continue; }
		const x = Math.floor(u * lm.width), y = Math.floor(v * lm.height);
		const o = (y * lm.width + x) * 4;
		s2 += (lm.data[o] + lm.data[o + 1] + lm.data[o + 2]) / 3; n2++;
	}
}
console.log('vertex samples mean', (s2 / n2).toFixed(4), 'out of range', out, 'of', n2 + out);
