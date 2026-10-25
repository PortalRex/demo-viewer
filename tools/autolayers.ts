// A model's (and its $includemodel files') sequence auto-layers
// (mstudioautolayer_t) and per-bone weight lists:
//   node --experimental-strip-types tools/autolayers.ts models/x.mdl
import {GameFiles} from '../src/game/files.ts';
import {nodeFS} from './nodefs.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');

async function dump(name: string) {
	const b = (await files.read(name))!;
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const cstr = (o: number) => { let s = ''; while (b[o]) s += String.fromCharCode(b[o++]); return s; };
	const nSeq = v.getInt32(188, true), seqOff = v.getInt32(192, true);
	const nBones = v.getInt32(156, true), boneOff = v.getInt32(160, true);
	const label = (i: number) => cstr(seqOff + i * 212 + v.getInt32(seqOff + i * 212 + 4, true));
	console.log(`${name}: ${nSeq} sequences, ${nBones} bones`);
	for (let i = 0; i < nSeq; i++) {
		const o = seqOff + i * 212;
		const n = v.getInt32(o + 148, true), lo = v.getInt32(o + 152, true), wl = v.getInt32(o + 156, true);
		const flags = v.getInt32(o + 12, true);
		const layers = [];
		for (let k = 0; k < n; k++) {
			const a = o + lo + k * 24;
			layers.push(`${label(v.getInt16(a, true))} pose${v.getInt16(a + 2, true)} fl${v.getInt32(a + 4, true).toString(16)} ${[8, 12, 16, 20].map(x => v.getFloat32(a + x, true).toFixed(2)).join('/')}`);
		}
		const w = [];
		for (let k = 0; k < nBones; k++) w.push(v.getFloat32(o + wl + k * 4, true));
		const zero = w.map((x, k) => x === 0 ? cstr(boneOff + k * 216 + v.getInt32(boneOff + k * 216, true)) : '').filter(Boolean);
		console.log(`  ${i} ${label(i)} flags ${flags.toString(16)} layers [${layers.join('; ')}] zero-weight bones: ${zero.length}${zero.length < 14 ? ' ' + zero.join(',') : ''}`);
	}
	const nInc = v.getInt32(336, true), incOff = v.getInt32(340, true);
	for (let i = 0; i < nInc; i++) await dump(cstr(incOff + i * 8 + v.getInt32(incOff + i * 8 + 4, true)).replace(/\\/g, '/').toLowerCase());
}
await dump(process.argv[2]);
