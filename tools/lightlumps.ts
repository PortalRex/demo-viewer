// A map's LDR and HDR lightmaps compared face by face: how many faces are
// dark in one and lit in the other (Portal 2's maps mostly carry both).
//   node --experimental-strip-types tools/lightlumps.ts <map>
import {existsSync, readFileSync} from 'node:fs';
import {mapPaths} from '../src/game/gamefs.ts';
import {ROOT} from './nodefs.ts';

const map = process.argv[2] ?? 'sp_a2_bts3';
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const bytes = readFileSync(`${ROOT}/${path}`);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const lump = (i: number) => ({offset: view.getInt32(8 + i * 16, true), length: view.getInt32(12 + i * 16, true)});
const FACES = 7, LIGHTING = 8, FACES_HDR = 58, LIGHTING_HDR = 53;

// a lightmap's mean (ColorRGBExp32: rgb times 2^exponent), style 0 only
function faceLight(faces: {offset: number; length: number}, light: {offset: number; length: number}) {
	const out: number[] = [];
	for (let f = 0; f < faces.length / 56; f++) {
		const o = faces.offset + f * 56;
		const lightofs = view.getInt32(o + 20, true);
		const w = view.getInt32(o + 36, true) + 1, h = view.getInt32(o + 40, true) + 1;
		if (lightofs < 0 || !light.length) {
			out.push(-1);
			continue;
		}
		let sum = 0;
		for (let i = 0; i < w * h; i++) {
			const p = light.offset + lightofs + i * 4;
			const e = view.getInt8(p + 3);
			sum += (bytes[p] + bytes[p + 1] + bytes[p + 2]) / 3 * Math.pow(2, e) / 255;
		}
		out.push(sum / (w * h));
	}
	return out;
}

const ldrFaces = lump(FACES), hdrFaces = lump(FACES_HDR);
const ldr = faceLight(ldrFaces, lump(LIGHTING));
const hdr = faceLight(hdrFaces.length ? hdrFaces : ldrFaces, lump(LIGHTING_HDR));
let darkHdrLitLdr = 0, darkLdrLitHdr = 0, both = 0;
for (let i = 0; i < Math.min(ldr.length, hdr.length); i++) {
	if (ldr[i] < 0 || hdr[i] < 0) continue;
	both++;
	if (hdr[i] < 1e-4 && ldr[i] > 0.01) darkHdrLitLdr++;
	if (ldr[i] < 1e-4 && hdr[i] > 0.01) darkLdrLitHdr++;
}
const mean = (a: number[]) => a.filter(v => v >= 0).reduce((s, v) => s + v, 0) / Math.max(1, a.filter(v => v >= 0).length);
console.log(`${map}: faces ${ldr.length}/${hdr.length}, lit both ${both}; mean LDR ${mean(ldr).toFixed(4)} HDR ${mean(hdr).toFixed(4)}; dark in HDR but lit in LDR ${darkHdrLitLdr}, the reverse ${darkLdrLitHdr}`);
