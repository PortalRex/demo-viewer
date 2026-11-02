// Textures cut to a size for hosting: the levels kept are the original's, the
// header says the new size, and what's already small enough is left alone
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bytesFor, trimVtf, VtfFormat, vtfLevel} from '../src/game/vtf.ts';

// a version 7.2 texture (no resource table): header, no low-res image, then
// each level from the smallest, every byte of a level its level number
function vtf(width: number, height: number, mips: number, format = VtfFormat.DXT1): Uint8Array {
	const headerSize = 80;
	const levels: Uint8Array[] = [];
	for (let m = mips - 1; m >= 0; m--) levels.push(new Uint8Array(bytesFor(format, Math.max(1, width >> m), Math.max(1, height >> m))).fill(m));
	const out = new Uint8Array(headerSize + levels.reduce((n, l) => n + l.length, 0));
	const v = new DataView(out.buffer);
	v.setUint32(0, 0x00465456, true);
	v.setUint32(4, 7, true);
	v.setUint32(8, 2, true);
	v.setUint32(12, headerSize, true);
	v.setUint16(16, width, true);
	v.setUint16(18, height, true);
	v.setUint16(24, 1, true);  // frames
	v.setInt32(52, format, true);
	v.setUint8(56, mips);
	v.setInt32(57, -1, true);  // no low-res image
	v.setUint16(63, 1, true);  // depth
	let o = headerSize;
	for (const l of levels) {
		out.set(l, o);
		o += l.length;
	}
	return out;
}

test('a 2048 texture cut to 512 keeps its 512 level and smaller', () => {
	const big = vtf(2048, 1024, 12);
	const cut = trimVtf(big, 512);
	assert.ok(cut.length < big.length);
	const a = vtfLevel(big, 512)!, b = vtfLevel(cut, 512)!;
	assert.deepEqual([b.width, b.height], [512, 256]);
	assert.deepEqual(cut.subarray(b.offset, b.offset + b.size), big.subarray(a.offset, a.offset + a.size));
	// (its own largest level now: nothing above 512 left)
	assert.deepEqual([vtfLevel(cut, 4096)!.width, vtfLevel(cut, 4096)!.height], [512, 256]);
	assert.equal(cut[b.offset], 2);  // (the original's third level)
});

test('a texture already small enough is left as it is', () => {
	const small = vtf(512, 512, 10);
	assert.equal(trimVtf(small, 512), small);
});

test("a file that isn't a texture is left as it is", () => {
	const junk = new Uint8Array(100).fill(7);
	assert.equal(trimVtf(junk, 512), junk);
});
