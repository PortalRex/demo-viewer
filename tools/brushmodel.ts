// A brush model's bounds and origin as stored in the BSP:
//   node --experimental-strip-types tools/brushmodel.ts <map> <model index>...
import {existsSync} from 'node:fs';
import {mapPaths} from '../src/game/gamefs.ts';
import {nodeFS, ROOT} from './nodefs.ts';

const [map, ...ids] = process.argv.slice(2);
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const file = (await nodeFS.read(path))!;
const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
const lump = (i: number) => new DataView(file.buffer, file.byteOffset + dv.getInt32(8 + i * 16, true), dv.getInt32(12 + i * 16, true));
const models = lump(14);
for (const id of ids.map(Number)) {
	const f = (o: number) => models.getFloat32(id * 48 + o, true).toFixed(1);
	console.log(`*${id}: mins ${f(0)} ${f(4)} ${f(8)} maxs ${f(12)} ${f(16)} ${f(20)} origin ${f(24)} ${f(28)} ${f(32)} faces ${models.getInt32(id * 48 + 44, true)}`);
}
