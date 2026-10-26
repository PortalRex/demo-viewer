// A map's faces by lightmap styles: how many are dark in their first style
// but lit in a later one (switchable lights), per style.
//   node --experimental-strip-types tools/facestyles.ts <map>
import {existsSync, readFileSync} from 'node:fs';
import {mapPaths} from '../src/game/gamefs.ts';
import {ROOT} from './nodefs.ts';

const map = process.argv[2] ?? 'sp_a2_bts3';
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const bytes = readFileSync(`${ROOT}/${path}`);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const lump = (i: number) => ({offset: view.getInt32(8 + i * 16, true), length: view.getInt32(12 + i * 16, true)});
const faces = lump(58).length ? lump(58) : lump(7), light = lump(53);
const mean = (at: number, n: number) => {
	let s = 0;
	for (let i = 0; i < n; i++) {
		const p = light.offset + at + i * 4;
		s += (bytes[p] + bytes[p + 1] + bytes[p + 2]) / 3 * Math.pow(2, view.getInt8(p + 3)) / 255;
	}
	return s / n;
};
const counts = new Map<string, number>();
let darkBase = 0, darkAll = 0, total = 0;
for (let f = 0; f < faces.length / 56; f++) {
	const o = faces.offset + f * 56;
	const styles = [0, 1, 2, 3].map(k => bytes[o + 16 + k]).filter(s => s !== 255);
	const ofs = view.getInt32(o + 20, true);
	if (ofs < 0 || !styles.length) continue;
	const n = (view.getInt32(o + 36, true) + 1) * (view.getInt32(o + 40, true) + 1);
	// (a bumped face stores 4 lightmaps per style)
	const per = n * ((bytes[o + 16] !== 255 && false) ? 4 : 1);
	const means = styles.map((_, k) => mean(ofs + k * per * 4, n));
	total++;
	const key = styles.join(',');
	counts.set(key, (counts.get(key) ?? 0) + 1);
	if (means[0] < 1e-4) {
		darkBase++;
		if (means.every(m => m < 1e-4)) darkAll++;
	}
}
console.log(`${map}: ${total} lit faces; dark in their first style ${darkBase}, dark in all ${darkAll}`);
console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `[${k}] ${v}`).join('  '));
