// A material's shader, parameters and base texture's average colour:
//   node --experimental-strip-types tools/matinfo.ts <material>...
import {nodeFS} from './nodefs.ts';
import {GameFiles} from '../src/game/files.ts';
import {Materials} from '../src/game/materials.ts';
import {readVtf, decodeVtf} from '../src/game/vtf.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const mats = new Materials(files);
for (const n of process.argv.slice(2)) {
	const r = await mats.raw(n);
	if (!r) {
		console.log(n, 'missing');
		continue;
	}
	let avg = '-';
	const bt = r.params.get('$basetexture');
	const b = bt ? await files.read(`materials/${bt.toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '')}.vtf`) : null;
	const img = b ? readVtf(b, 256) : null;
	if (img) {
		const d = decodeVtf(img);
		const s = [0, 0, 0, 0];
		for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 4; k++) s[k] += d[i + k];
		avg = s.map(x => (x / (d.length / 4)).toFixed(0)).join(',');
	}
	console.log(`${n}: ${r.shader} rgba ${avg}\n  ${[...r.params].map(x => x.join('=')).join('  ')}`);
}
