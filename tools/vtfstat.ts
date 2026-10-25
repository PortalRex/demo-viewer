// A texture's size, format and mean colour/alpha (top mip decoded):
//   node --experimental-strip-types tools/vtfstat.ts materials/x.vtf
import {GameFiles} from '../src/game/files.ts';
import {nodeFS} from './nodefs.ts';
import {readVtf, decodeVtf} from '../src/game/vtf.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const bytes = (await files.read(process.argv[2]))!;
const img = readVtf(bytes)!;
const t = {width: img.width, height: img.height, format: (img as unknown as {format: number}).format, rgba: decodeVtf(img)};
const n = t.width * t.height, sum = [0, 0, 0, 0];
for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) sum[k] += t.rgba[i * 4 + k];
console.log(`${t.width}x${t.height} format ${t.format} mean rgba ${sum.map(s => (s / n).toFixed(1)).join(' ')}`);
