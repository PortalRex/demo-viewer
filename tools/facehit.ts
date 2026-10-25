// Every BSP face a ray crosses (any model, drawn or not), nearest first:
//   node --experimental-strip-types tools/facehit.ts <map> x y z pitch yaw
import {existsSync} from 'node:fs';
import {mapPaths} from '../src/game/gamefs.ts';
import {nodeFS, ROOT} from './nodefs.ts';

const [map, ...nums] = process.argv.slice(2);
const [x, y, z, pitch, yaw] = nums.map(Number);
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const file = (await nodeFS.read(path))!;
const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
const lump = (i: number) => new DataView(file.buffer, file.byteOffset + dv.getInt32(8 + i * 16, true), dv.getInt32(12 + i * 16, true));
const planes = lump(1), texdata = lump(2), verts = lump(3), texinfo = lump(6), faces = lump(7), edges = lump(12), surfedges = lump(13), models = lump(14);
const strData = lump(43), strTable = lump(44);
const hdrFaces = lump(58), light = lump(53);
// a face's luxels: average linear colour, per bump sample block
const luxels = (f: number) => {
	const o = f * 56, ofs = hdrFaces.getInt32(o + 20, true);
	if (ofs < 0) return 'unlit';
	const w = hdrFaces.getInt32(o + 36, true) + 1, h = hdrFaces.getInt32(o + 40, true) + 1;
	const ti = faces.getInt16(o + 10, true);
	const bump = (texinfo.getInt32(ti * 72 + 64, true) & 0x800) ? 4 : 1;
	const styles = [16, 17, 18, 19].map(k => hdrFaces.getUint8(o + k));
	const out: string[] = [];
	for (let blk = 0; blk < bump * styles.filter(x => x !== 255).length; blk += bump) {
		let sum = 0;
		for (let i = 0; i < w * h; i++) {
			const b = ofs + (blk * w * h + i) * 4;
			const e = 2 ** light.getInt8(b + 3);
			sum += (light.getUint8(b) * 0.2126 + light.getUint8(b + 1) * 0.7152 + light.getUint8(b + 2) * 0.0722) * e / 255;
		}
		out.push((sum / (w * h)).toFixed(3));
	}
	return `${w}x${h} styles ${styles} lum ${out.join(' ')}`;
};
const texName = (ti: number) => {
	const td = texinfo.getInt32(ti * 72 + 68, true);
	const off = strTable.getInt32(texdata.getInt32(td * 32 + 12, true) * 4, true);
	let s = '';
	for (let i = off; strData.getUint8(i); i++) s += String.fromCharCode(strData.getUint8(i));
	return s;
};
const modelOf = (f: number) => {
	for (let m = 0; m < models.byteLength / 48; m++) {
		const first = models.getInt32(m * 48 + 40, true), n = models.getInt32(m * 48 + 44, true);
		if (f >= first && f < first + n) return m;
	}
	return -1;
};
const p = pitch * Math.PI / 180, w = yaw * Math.PI / 180;
const d = [Math.cos(p) * Math.cos(w), Math.cos(p) * Math.sin(w), -Math.sin(p)];
const o = [x, y, z];
const hits: string[] = [];
const out: [number, string][] = [];
for (let f = 0; f < faces.byteLength / 56; f++) {
	const fo = f * 56;
	const pn = faces.getUint16(fo, true);
	const side = faces.getUint8(fo + 2);
	const n = [0, 1, 2].map(i => planes.getFloat32(pn * 20 + i * 4, true) * (side ? -1 : 1));
	const dist = planes.getFloat32(pn * 20 + 12, true) * (side ? -1 : 1);
	const denom = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
	if (Math.abs(denom) < 1e-6) continue;
	const t = (dist - (n[0] * o[0] + n[1] * o[1] + n[2] * o[2])) / denom;
	if (t <= 0 || t > 8000) continue;
	const hp = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
	const first = faces.getInt32(fo + 4, true), num = faces.getInt16(fo + 8, true);
	const vs: number[][] = [];
	for (let i = 0; i < num; i++) {
		const se = surfedges.getInt32((first + i) * 4, true);
		const e = Math.abs(se);
		const vi = edges.getUint16(e * 4 + (se < 0 ? 2 : 0), true);
		vs.push([0, 1, 2].map(k => verts.getFloat32(vi * 12 + k * 4, true)));
	}
	// inside the convex polygon?
	let pos = 0, neg = 0;
	for (let i = 0; i < vs.length; i++) {
		const a = vs[i], b = vs[(i + 1) % vs.length];
		const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], h = [hp[0] - a[0], hp[1] - a[1], hp[2] - a[2]];
		const c = [e[1] * h[2] - e[2] * h[1], e[2] * h[0] - e[0] * h[2], e[0] * h[1] - e[1] * h[0]];
		const s = c[0] * n[0] + c[1] * n[1] + c[2] * n[2];
		if (s > 0.01) pos++;
		else if (s < -0.01) neg++;
	}
	if (pos && neg) continue;
	// the facing the vertex winding gives (Source winds clockwise seen from the front)
	let wn = [0, 0, 0];
	for (let i = 1; i + 1 < vs.length; i++) {
		const e1 = [0, 1, 2].map(k => vs[i][k] - vs[0][k]), e2 = [0, 1, 2].map(k => vs[i + 1][k] - vs[0][k]);
		wn = [wn[0] + e1[1] * e2[2] - e1[2] * e2[1], wn[1] + e1[2] * e2[0] - e1[0] * e2[2], wn[2] + e1[0] * e2[1] - e1[1] * e2[0]];
	}
	const windingAgrees = (wn[0] * n[0] + wn[1] * n[1] + wn[2] * n[2]) < 0 ? 'cw' : 'ccw';
	const ti = faces.getInt16(fo + 10, true);
	const flags = ti >= 0 ? texinfo.getInt32(ti * 72 + 64, true) : -1;
	out.push([t, `t=${t.toFixed(0)} face ${f} model ${modelOf(f)} ${ti >= 0 ? texName(ti) : '-'} flags 0x${flags.toString(16)} side ${side} wind ${windingAgrees} disp ${faces.getInt16(fo + 12, true)} ${denom < 0 ? 'front' : 'back'} ${luxels(f)}`]);
}
out.sort((a, b) => a[0] - b[0]);
for (const [, s] of out.slice(0, 12)) hits.push(s);
console.log(hits.join('\n'));
