// Compare static prop vertex light colours with the lightmap near each prop
import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {Zip} from '../src/game/zip.ts';
import {nodeFS, ROOT} from './nodefs.ts';
const map = process.argv[2] ?? 'sp_a1_intro4';
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const bsp = await loadBsp(nodeFS, path, map);
const zip = new Zip(bsp.pak!);
// lightmap tint over all world vertices
const lm = bsp.lightmap!;
let lr = 0, lg = 0, lb = 0, n = 0;
for (const g of bsp.models[0].groups) for (let i = 0; i < g.lightUv!.length; i += 2) {
	const o = (Math.floor(g.lightUv![i + 1] * lm.height) * lm.width + Math.floor(g.lightUv![i] * lm.width)) * 4;
	lr += lm.data[o]; lg += lm.data[o + 1]; lb += lm.data[o + 2]; n++;
}
console.log('lightmap mean rgb', (lr / n).toFixed(3), (lg / n).toFixed(3), (lb / n).toFixed(3));
let s = [0, 0, 0, 0], c = 0;
for (let i = 0; i < bsp.staticProps.length; i++) {
	const b = await zip.read(`sp_hdr_${i}.vhv`);
	if (!b) continue;
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const off = v.getUint32(40 + 8, true), nv = v.getUint32(16, true);
	for (let k = 0; k < nv; k++) { for (let j = 0; j < 4; j++) s[j] += b[off + k * 4 + j]; c++; }
}
console.log('vhv mean bytes 0..3', s.map(x => (x / c / 255).toFixed(3)).join(' '), 'over', c, 'vertices');
