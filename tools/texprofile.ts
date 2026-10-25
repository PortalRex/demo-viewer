// A texture's size and its average brightness along each axis:
//   node --experimental-strip-types tools/texprofile.ts <path under materials, no .vtf>
import {nodeFS} from './nodefs.ts';
import {GameFiles} from '../src/game/files.ts';
import {readVtf, decodeVtf} from '../src/game/vtf.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
for (const p of process.argv.slice(2)) {
	const b = await files.read(`materials/${p}.vtf`);
	const img = b && readVtf(b, 1024);
	if (!img) {
		console.log(p, 'missing');
		continue;
	}
	const d = decodeVtf(img);
	const lum = (i: number) => (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
	const rows: number[] = [], cols: number[] = [];
	for (let y = 0; y < img.height; y++) {
		let s = 0;
		for (let x = 0; x < img.width; x++) s += lum(y * img.width + x);
		rows.push(Math.round(s / img.width));
	}
	for (let x = 0; x < img.width; x++) {
		let s = 0;
		for (let y = 0; y < img.height; y++) s += lum(y * img.width + x);
		cols.push(Math.round(s / img.height));
	}
	const pick = (a: number[]) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / 16)) === 0).join(' ');
	console.log(`${p}: ${img.width}x${img.height} alpha=${img.hasAlpha}\n  rows (down): ${pick(rows)}\n  cols (across): ${pick(cols)}\n  centre rgb ${[0, 1, 2].map(k => d[(Math.floor(img.height / 2) * img.width + Math.floor(img.width / 2)) * 4 + k])}`);
}
