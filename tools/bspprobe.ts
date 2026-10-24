// Loads maps from the local install with the viewer's BSP reader:
//   node --experimental-strip-types tools/bspprobe.ts sp_a1_intro1 sp_a2_column_blocker
import {openSync, readSync, fstatSync, existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import type {GameFS} from '../src/game/gamefs.ts';

const ROOT = process.env.P2_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Portal 2';
const fs: GameFS = {
	label: 'node',
	async read(path, offset = 0, length) {
		const p = `${ROOT}/${path}`;
		if (!existsSync(p)) return null;
		const fd = openSync(p, 'r');
		const n = length ?? fstatSync(fd).size - offset;
		const buf = new Uint8Array(n);
		readSync(fd, buf, 0, n, offset);
		return buf;
	},
	async size(path) {
		const p = `${ROOT}/${path}`;
		return existsSync(p) ? fstatSync(openSync(p, 'r')).size : null;
	},
};

for (const map of process.argv.slice(2)) {
	const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`));
	if (!path) {
		console.log(map, 'not found');
		continue;
	}
	const t0 = performance.now();
	const bsp = await loadBsp(fs, path, map);
	const tris = (m: {positions: Float32Array}) => m.positions.length / 9;
	console.log(`${map}: ${bsp.faceCount} faces, ${bsp.models.length} models, world ${tris(bsp.models[0].solid)} + ${tris(bsp.models[0].translucent)} tris, ${(performance.now() - t0).toFixed(0)} ms, bounds ${bsp.bounds.min.map(Math.round)} .. ${bsp.bounds.max.map(Math.round)}`, bsp.warnings);
}
