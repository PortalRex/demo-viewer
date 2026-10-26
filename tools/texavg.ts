// Textures' size and average colour (as stored, and that taken as sRGB to linear):
//   node --experimental-strip-types tools/texavg.ts <texture under materials/>...
import {nodeFS} from './nodefs.ts';
import {GameFiles} from '../src/game/files.ts';
import {readVtf, decodeVtf} from '../src/game/vtf.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const lin = (v: number) => Math.pow(v / 255, 2.2);
for (const n of process.argv.slice(2)) {
	const b = await files.read(`materials/${n.replace(/\\/g, '/').toLowerCase()}.vtf`);
	const img = b && readVtf(b, 128);
	if (!img) {
		console.log(n, 'missing');
		continue;
	}
	const d = decodeVtf(img);
	const s = [0, 0, 0, 0];
	for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 4; k++) s[k] += d[i + k];
	const c = d.length / 4;
	console.log(n, img.width, img.height, 'avg', s.map(x => (x / c).toFixed(0)).join(','), 'linear', [0, 1, 2].map(k => lin(s[k] / c).toFixed(3)).join(','));
}
