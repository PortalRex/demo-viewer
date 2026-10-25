// Static props near a point: their model, index and vertex light (.vhv) means
//   node --experimental-strip-types tools/vhvnear.ts <map> x y z [radius]
import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {Zip} from '../src/game/zip.ts';
import {nodeFS, ROOT} from './nodefs.ts';
const [map, x, y, z, r = '400'] = process.argv.slice(2);
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const bsp = await loadBsp(nodeFS, path, map);
const zip = new Zip(bsp.pak!);
const at = [Number(x), Number(y), Number(z)];
for (const p of bsp.staticProps) {
	const d = Math.hypot(p.origin[0] - at[0], p.origin[1] - at[1], p.origin[2] - at[2]);
	if (d > Number(r)) continue;
	const b = process.env.LDR ? await zip.read(`sp_${p.index}.vhv`) : await zip.read(`sp_hdr_${p.index}.vhv`) ?? await zip.read(`sp_${p.index}.vhv`);
	let info = 'no vhv';
	if (b) {
		const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
		const meshes = v.getInt32(20, true), off = v.getUint32(40 + 8, true), count = v.getUint32(40 + 4, true);
		let s = 0;
		for (let k = 0; k < count; k++) s += b[off + k * 4] + b[off + k * 4 + 1] + b[off + k * 4 + 2];
		info = `meshes ${meshes} first ${count} verts mean ${(s / Math.max(1, count) / 3).toFixed(1)}`;
	}
	console.log(p.index, p.model, Math.round(d), JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => !['model', 'origin', 'angles', 'index'].includes(k)))), info);
}
