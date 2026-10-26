// A map's baked cubemaps (env_cubemap, in its pak): each one's format,
// size and mean colour, plain and HDR:
//   node --experimental-strip-types tools/cubeprobe.ts <map>
import {existsSync, readFileSync} from 'node:fs';
import {mapPaths} from '../src/game/gamefs.ts';
import {Zip} from '../src/game/zip.ts';
import {readVtfCube, decodeVtf, VtfFormat} from '../src/game/vtf.ts';
import {ROOT} from './nodefs.ts';

const map = process.argv[2] ?? 'sp_a2_bridge_intro';
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const bytes = readFileSync(`${ROOT}/${path}`);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const PAKFILE = 40;
const offset = view.getInt32(8 + PAKFILE * 16, true), length = view.getInt32(12 + PAKFILE * 16, true);
const zip = new Zip(bytes.subarray(offset, offset + length));
const names = [...(zip as unknown as {files: Map<string, unknown>}).files.keys()].filter(n => /\/c-?\d+_-?\d+_-?\d+(\.hdr)?\.vtf$/.test(n)).sort();
const half = (h: number) => {
	const e = (h >> 10) & 31, m = h & 1023, s = h >> 15 ? -1 : 1;
	return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15);
};
for (const name of names) {
	const faces = readVtfCube((await zip.read(name))!, 64);
	if (!faces) {
		console.log(name, 'unreadable');
		continue;
	}
	const sum = [0, 0, 0, 0];
	let n = 0;
	for (const f of faces) {
		if (f.format === VtfFormat.RGBA16161616F) {
			const d = new Uint16Array(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.width * f.height * 8));
			for (let i = 0; i < d.length; i++) sum[i & 3] += half(d[i]);
		} else {
			const d = decodeVtf(f);
			for (let i = 0; i < d.length; i++) sum[i & 3] += d[i] / 255;
		}
		n += f.width * f.height;
	}
	console.log(`${name}: format ${faces[0].format} ${faces[0].width}px mean ${sum.map(s => (s / n).toFixed(3)).join(' ')}`);
}
