// Ambient cube and lights at a point:  node --experimental-strip-types tools/ambprobe.ts <map> x y z
import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {nodeFS, ROOT} from './nodefs.ts';

const [map, ...xyz] = process.argv.slice(2);
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const bsp = await loadBsp(nodeFS, path, map, {});
const a = bsp.ambient;
if (!a) {
	console.log('no ambient lighting');
} else {
	console.log(`${a.lights.length} world lights (${a.lights.filter(l => l.inAmbient).length} in ambient); types ${[...new Set(a.lights.map(l => l.type))]}`);
	const s = a.at(xyz.map(Number));
	console.log('cube', [0, 1, 2, 3, 4, 5].map(i => s.cube.slice(i * 3, i * 3 + 3).map(x => x.toFixed(4)).join(',')).join(' | '));
	for (const l of s.lights) console.log('light', l.pos.map(Math.round), l.color.map(x => x.toFixed(4)));
	console.log('sample light', JSON.stringify(a.lights.find(l => !l.inAmbient && l.type === 1)));
}
if (a) {
	const anyA = a as unknown as {leafAt(p: number[]): number; index: DataView; leaves: DataView};
	const leaf = anyA.leafAt(xyz.map(Number));
	console.log('leaf', leaf, 'contents', anyA.leaves.getInt32(leaf * 32, true), 'count/first', anyA.index.getUint16(leaf * 4, true), anyA.index.getUint16(leaf * 4 + 2, true));
}
