// Bink 1 video (revision 'i': the movies Portal 2 ships in media/, shown on
// elevator signs and vgui_movie_display panels): the container's frame index,
// and frames decoded to YUV 4:2:0 planes. A frame is coded plane by plane in
// 8x8 blocks (copied from the last frame, moved, filled, patterned, run
// coded, DCT coded or a residue on a moved block, or the same at half
// resolution scaled up 2x), each row's values sent ahead in nine
// Huffman-coded bundles. The decoder's tables (the 16 Huffman trees, the
// coefficient scan, the 16 run patterns and the quantisers) are the game's
// own: read out of its binkw32.dll.

export interface BinkTables {
	treeLens: Uint8Array;    // 16 trees x 16 code lengths
	treeCodes: Uint8Array;   // their codes, read least significant bit first
	scan: Uint8Array;        // coefficient order in an 8x8 block
	patterns: Uint8Array;    // 16 x 64: pixel orders for run blocks
	intraQuant: Int32Array;  // 16 x 64, by scan position (x 2^11)
	interQuant: Int32Array;
}

const isPermutation = (b: Uint8Array, o: number) => {
	let seen = 0n;
	for (let i = 0; i < 64; i++) {
		const v = b[o + i];
		if (v > 63 || (seen >> BigInt(v)) & 1n) return false;
		seen |= 1n << BigInt(v);
	}
	return true;
};

// The tables in binkw32.dll: 17 permutations of 0..63 in a row (the scan,
// then the run patterns), the trees' lengths and codes just before them,
// the intra and inter quantisers just after
export function binkTablesFromDll(dll: Uint8Array): BinkTables | null {
	for (let o = 0x200; o + 17 * 64 + 2 * 4096 <= dll.length; o += 64) {
		let n = 0;
		while (n < 17 && isPermutation(dll, o + n * 64)) n++;
		if (n < 17) continue;
		const lens = dll.slice(o - 0x200, o - 0x100), codes = dll.slice(o - 0x100, o);
		// (every tree's lengths make a complete code)
		let complete = true;
		for (let t = 0; t < 16 && complete; t++) {
			let kraft = 0;
			for (let i = 0; i < 16; i++) kraft += lens[t * 16 + i] ? 2 ** -lens[t * 16 + i] : 0;
			complete = Math.abs(kraft - 1) < 1e-9 || lens.subarray(t * 16, t * 16 + 16).every(l => l === 4);
		}
		if (!complete) continue;
		const view = new DataView(dll.buffer, dll.byteOffset, dll.byteLength);
		const quant = (at: number) => Int32Array.from({length: 1024}, (_, i) => view.getInt32(at + i * 4, true));
		const q = o + 17 * 64;
		return {
			treeLens: lens, treeCodes: codes, scan: dll.slice(o, o + 64), patterns: dll.slice(o + 64, o + 17 * 64),
			intraQuant: quant(q), interQuant: quant(q + 4096),
		};
	}
	return null;
}

// a tree's codes as a lookup on the next 7 bits: symbol in the low byte,
// its length above
function treeLookup(t: BinkTables, tree: number): Uint16Array {
	const table = new Uint16Array(128);
	for (let s = 0; s < 16; s++) {
		const len = t.treeLens[tree * 16 + s], code = t.treeCodes[tree * 16 + s];
		for (let hi = 0; hi < 1 << (7 - len); hi++) table[code | (hi << len)] = s | (len << 8);
	}
	return table;
}

// bits read least significant first out of little-endian bytes
class Bits {
	private data: Uint8Array;
	pos: number;
	readonly start: number;  // where the packet starts (alignment counts from there)
	private end: number;
	constructor(data: Uint8Array, start: number, end: number) {
		this.data = data;
		this.pos = this.start = start * 8;
		this.end = end * 8;
	}
	get(n: number): number {
		if (n === 0) return 0;
		let v = 0, got = 0;
		while (got < n) {
			const byte = this.pos >> 3, shift = this.pos & 7;
			const take = Math.min(8 - shift, n - got);
			const b = byte < this.data.length ? this.data[byte] : 0;
			v |= ((b >> shift) & ((1 << take) - 1)) << got;
			got += take;
			this.pos += take;
		}
		return v >>> 0;
	}
	bit(): number {
		const b = this.pos >> 3;
		const v = b < this.data.length ? (this.data[b] >> (this.pos & 7)) & 1 : 0;
		this.pos++;
		return v;
	}
	peek7(): number {
		const at = this.pos;
		const v = this.get(7);
		this.pos = at;
		return v;
	}
	get left() {
		return this.end - this.pos;
	}
}

// the bundles a row's values come in, and the block types
const Src = {BlockTypes: 0, SubBlockTypes: 1, Colors: 2, Pattern: 3, XOff: 4, YOff: 5, IntraDC: 6, InterDC: 7, Run: 8, Count: 9} as const;
const Block = {Skip: 0, Scaled: 1, Motion: 2, Run: 3, Residue: 4, Intra: 5, Fill: 6, Inter: 7, Pattern: 8, Raw: 9} as const;
const RLE_LENS = [4, 8, 12, 32];
const DC_START_BITS = 11;

interface Tree {
	lookup: Uint16Array;
	syms: Uint8Array;
}

interface Bundle {
	len: number;       // bits of the count of values a row sends
	tree: Tree;
	data: Int16Array;
	dec: number;       // where decoded values end (-1: no more this plane)
	ptr: number;       // the next value used
}

export interface BinkFrame {
	width: number;
	height: number;
	y: Uint8Array;     // planes at their strides
	u: Uint8Array;
	v: Uint8Array;
	yStride: number;
	cStride: number;
}

export class BinkVideo {
	readonly width: number;
	readonly height: number;
	readonly frames: number;
	readonly fps: number;
	private data: Uint8Array;
	private tables: BinkTables;
	private lookups: Uint16Array[];
	private index: {offset: number; size: number; key: boolean}[] = [];
	private audioTracks: number;
	private cur: Uint8Array[];
	private prev: Uint8Array[];
	private strides: number[];
	private heights: number[];
	private bundles: Bundle[];
	private colHigh: Tree[];
	private colLast = 0;
	private block = new Int32Array(64);
	private tmp = new Int32Array(64);
	private ublock = new Uint8Array(64);
	decoded = -1;      // the frame the planes hold

	constructor(data: Uint8Array, tables: BinkTables) {
		const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
		if (v.getUint32(0, true) !== 0x694b4942) throw new Error('not a Bink 1 (BIKi) movie');  // "BIKi"
		this.data = data;
		this.tables = tables;
		this.lookups = Array.from({length: 16}, (_, i) => treeLookup(tables, i));
		const fileSize = v.getUint32(4, true) + 8;
		this.frames = v.getUint32(8, true);
		this.width = v.getUint32(20, true);
		this.height = v.getUint32(24, true);
		this.fps = v.getUint32(28, true) / Math.max(1, v.getUint32(32, true));
		const flags = v.getUint32(36, true);
		if (flags & 0x00100000) throw new Error('Bink alpha planes are not supported');
		this.audioTracks = v.getUint32(40, true);
		let p = 44 + this.audioTracks * 12;
		let next = v.getUint32(p, true);
		for (let i = 0; i < this.frames; i++) {
			const at = next;
			next = i === this.frames - 1 ? fileSize : v.getUint32(p + 4 + i * 4, true);
			this.index.push({offset: at & ~1, size: (next & ~1) - (at & ~1), key: (at & 1) === 1});
		}
		const bw = (this.width + 7) >> 3, bh = (this.height + 7) >> 3;
		// (planes padded to whole blocks, and a block past the edge for the scaled blocks)
		this.strides = [bw * 8 + 16, ((this.width >> 1) + 7 & ~7) + 16, ((this.width >> 1) + 7 & ~7) + 16];
		this.heights = [bh * 8 + 16, ((this.height >> 1) + 7 & ~7) + 16, ((this.height >> 1) + 7 & ~7) + 16];
		this.cur = [0, 1, 2].map(i => new Uint8Array(this.strides[i] * this.heights[i]));
		this.prev = [0, 1, 2].map(i => new Uint8Array(this.strides[i] * this.heights[i]));
		const blocks = bw * bh;
		const tree = (): Tree => ({lookup: this.lookups[0], syms: Uint8Array.from({length: 16}, (_, i) => i)});
		this.bundles = Array.from({length: Src.Count}, () => ({len: 0, tree: tree(), data: new Int16Array(blocks * 64 + 64), dec: 0, ptr: 0}));
		this.colHigh = Array.from({length: 16}, tree);
	}

	// the keyframe at or before frame `i` (decoding can start there)
	keyframeBefore(i: number): number {
		while (i > 0 && !this.index[i].key) i--;
		return i;
	}

	// decodes frame `i`, which must be the next one or a keyframe
	decode(i: number): BinkFrame {
		const f = this.index[i];
		// (past each audio track's packet: its size, then its bytes)
		let p = f.offset;
		const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
		for (let t = 0; t < this.audioTracks; t++) p += 4 + view.getUint32(p, true);
		[this.cur, this.prev] = [this.prev, this.cur];
		const gb = new Bits(this.data, p, f.offset + f.size);
		gb.get(16);
		gb.get(16);  // (revision i: a 32-bit field first)
		// luma, then the planes swapped: Cr, Cb
		for (const plane of [0, 2, 1]) {
			this.decodePlane(gb, plane, plane !== 0);
			if (gb.left <= 0) break;
		}
		this.decoded = i;
		return {width: this.width, height: this.height, y: this.cur[0], u: this.cur[1], v: this.cur[2], yStride: this.strides[0], cStride: this.strides[1]};
	}

	private readTree(gb: Bits, tree: Tree) {
		const num = gb.get(4);
		tree.lookup = this.lookups[num];
		const syms = tree.syms;
		if (!num) {
			for (let i = 0; i < 16; i++) syms[i] = i;
			return;
		}
		if (gb.bit()) {
			let len = gb.get(3);
			const used = new Uint8Array(16);
			for (let i = 0; i <= len; i++) {
				syms[i] = gb.get(4);
				used[syms[i]] = 1;
			}
			for (let i = 0; i < 16 && len < 15; i++) if (!used[i]) syms[++len] = i;
		} else {
			const len = gb.get(2);
			let src = Uint8Array.from({length: 16}, (_, i) => i), dst = new Uint8Array(16);
			for (let i = 0; i <= len; i++) {
				const size = 1 << i;
				for (let t = 0; t < 16; t += size << 1) {
					// merge two sorted runs, a bit choosing which goes next
					let a = t, b = t + size, out = t, na = size, nb = size;
					while (na && nb) {
						if (!gb.bit()) {
							dst[out++] = src[a++];
							na--;
						} else {
							dst[out++] = src[b++];
							nb--;
						}
					}
					while (na--) dst[out++] = src[a++];
					while (nb--) dst[out++] = src[b++];
				}
				[src, dst] = [dst, src];
			}
			syms.set(src);
		}
	}

	private huff(gb: Bits, tree: Tree): number {
		const e = tree.lookup[gb.peek7()];
		gb.pos += e >> 8;
		return tree.syms[e & 255];
	}

	// a row's count of new values, unless the last ones aren't all used yet
	// (or the bundle's done for this plane): -1 when nothing's read
	private count(gb: Bits, b: Bundle): number {
		if (b.dec < 0 || b.dec > b.ptr) return -1;
		const t = gb.get(b.len);
		if (!t) {
			b.dec = -1;
			return -1;
		}
		return t;
	}

	private readBlockTypes(gb: Bits, b: Bundle) {
		const t = this.count(gb, b);
		if (t < 0) return;
		const end = b.dec + t;
		if (gb.bit()) {
			b.data.fill(gb.get(4), b.dec, end);
			b.dec = end;
			return;
		}
		let last = 0;
		while (b.dec < end) {
			const v = this.huff(gb, b.tree);
			if (v < 12) {
				last = v;
				b.data[b.dec++] = v;
			} else {
				const run = Math.min(RLE_LENS[v - 12], end - b.dec);
				b.data.fill(last, b.dec, b.dec + run);
				b.dec += run;
			}
		}
	}

	private readPatterns(gb: Bits, b: Bundle) {
		const t = this.count(gb, b);
		if (t < 0) return;
		const end = b.dec + t;
		while (b.dec < end) {
			const lo = this.huff(gb, b.tree);
			b.data[b.dec++] = lo | (this.huff(gb, b.tree) << 4);
		}
	}

	private readColors(gb: Bits, b: Bundle) {
		const t = this.count(gb, b);
		if (t < 0) return;
		const end = b.dec + t;
		const one = () => {
			this.colLast = this.huff(gb, this.colHigh[this.colLast]);
			return (this.colLast << 4) | this.huff(gb, b.tree);
		};
		if (gb.bit()) {
			b.data.fill(one(), b.dec, end);
			b.dec = end;
		} else {
			while (b.dec < end) b.data[b.dec++] = one();
		}
	}

	private readMotion(gb: Bits, b: Bundle) {
		const t = this.count(gb, b);
		if (t < 0) return;
		const end = b.dec + t;
		if (gb.bit()) {
			let v = gb.get(4);
			if (v && gb.bit()) v = -v;
			b.data.fill(v, b.dec, end);
			b.dec = end;
			return;
		}
		while (b.dec < end) {
			let v = this.huff(gb, b.tree);
			if (v && gb.bit()) v = -v;
			b.data[b.dec++] = v;
		}
	}

	private readDCs(gb: Bits, b: Bundle, signed: boolean) {
		let len = this.count(gb, b);
		if (len < 0) return;
		let v = gb.get(DC_START_BITS - (signed ? 1 : 0));
		if (v && signed && gb.bit()) v = -v;
		b.data[b.dec++] = v;
		len--;
		for (let i = 0; i < len; i += 8) {
			const n = Math.min(len - i, 8);
			const size = gb.get(4);
			for (let j = 0; j < n; j++) {
				if (size) {
					let d = gb.get(size);
					if (d && gb.bit()) d = -d;
					v += d;
				}
				b.data[b.dec++] = v;
			}
		}
	}

	private readRuns(gb: Bits, b: Bundle) {
		const t = this.count(gb, b);
		if (t < 0) return;
		const end = b.dec + t;
		if (gb.bit()) {
			b.data.fill(gb.get(4), b.dec, end);
			b.dec = end;
		} else {
			while (b.dec < end) b.data[b.dec++] = this.huff(gb, b.tree);
		}
	}

	private value(src: number): number {
		const b = this.bundles[src];
		return b.data[b.ptr++];
	}

	// the coefficients sent as bit planes from the top bit down, positions
	// opened four at a time (a 4x4 quarter's worth in scan order), then
	// dequantised (x quant >> 11)
	private readDCT(gb: Bits, block: Int32Array, quantSet: Int32Array) {
		const scan = this.tables.scan;
		const coefList = new Int32Array(128), modeList = new Int32Array(128), coefIdx = new Int32Array(64);
		let start = 64, end = 64, count = 0;
		const push = (c: number, m: number) => {
			coefList[end] = c;
			modeList[end++] = m;
		};
		push(4, 0);
		push(24, 0);
		push(44, 0);
		push(1, 3);
		push(2, 3);
		push(3, 3);
		const value = (bits: number) => {
			if (!bits) return 1 - (gb.bit() << 1);
			const t = gb.get(bits) | (1 << bits);
			return gb.bit() ? -t : t;
		};
		for (let bits = gb.get(4) - 1; bits >= 0; bits--) {
			let pos = start;
			while (pos < end) {
				if (!(modeList[pos] | coefList[pos]) || !gb.bit()) {
					pos++;
					continue;
				}
				let c = coefList[pos];
				const mode = modeList[pos];
				if (mode === 1) {
					modeList[pos] = 2;
					for (let i = 0; i < 3; i++) {
						c += 4;
						push(c, 2);
					}
				} else if (mode === 3) {
					block[scan[c]] = value(bits);
					coefIdx[count++] = c;
					coefList[pos] = 0;
					modeList[pos++] = 0;
				} else {
					if (mode === 0) {
						coefList[pos] = c + 4;
						modeList[pos] = 1;
					} else {
						coefList[pos] = 0;
						modeList[pos++] = 0;
					}
					for (let i = 0; i < 4; i++, c++) {
						if (gb.bit()) {
							coefList[--start] = c;
							modeList[start] = 3;
						} else {
							block[scan[c]] = value(bits);
							coefIdx[count++] = c;
						}
					}
				}
			}
		}
		const q = gb.get(4) * 64;
		block[0] = Math.floor(block[0] * quantSet[q] / 2048);
		for (let i = 0; i < count; i++) {
			const idx = coefIdx[i];
			block[scan[idx]] = Math.floor(block[scan[idx]] * quantSet[q + scan[idx]] / 2048);
		}
	}

	// a residue: the same bit-plane coding, as plain values (one per mask
	// bit set), up to `masks` of them
	private readResidue(gb: Bits, block: Int32Array, masks: number) {
		const scan = this.tables.scan;
		const coefList = new Int32Array(128), modeList = new Int32Array(128), nz = new Int32Array(64);
		let start = 64, end = 64, nzCount = 0;
		const push = (c: number, m: number) => {
			coefList[end] = c;
			modeList[end++] = m;
		};
		push(4, 0);
		push(24, 0);
		push(44, 0);
		push(0, 2);
		for (let mask = 1 << gb.get(3); mask; mask >>= 1) {
			for (let i = 0; i < nzCount; i++) {
				if (!gb.bit()) continue;
				block[nz[i]] += block[nz[i]] < 0 ? -mask : mask;
				if (--masks < 0) return;
			}
			let pos = start;
			while (pos < end) {
				if (!(coefList[pos] | modeList[pos]) || !gb.bit()) {
					pos++;
					continue;
				}
				let c = coefList[pos];
				const mode = modeList[pos];
				if (mode === 1) {
					modeList[pos] = 2;
					for (let i = 0; i < 3; i++) {
						c += 4;
						push(c, 2);
					}
				} else if (mode === 3) {
					nz[nzCount++] = scan[c];
					block[scan[c]] = gb.bit() ? -mask : mask;
					coefList[pos] = 0;
					modeList[pos++] = 0;
					if (--masks < 0) return;
				} else {
					if (mode === 0) {
						coefList[pos] = c + 4;
						modeList[pos] = 1;
					} else {
						coefList[pos] = 0;
						modeList[pos++] = 0;
					}
					for (let i = 0; i < 4; i++, c++) {
						if (gb.bit()) {
							coefList[--start] = c;
							modeList[start] = 3;
						} else {
							nz[nzCount++] = scan[c];
							block[scan[c]] = gb.bit() ? -mask : mask;
							if (--masks < 0) return;
						}
					}
				}
			}
		}
	}

	// Bink's 8x8 inverse DCT: columns, then rows rounded down 8 bits
	private idct(block: Int32Array) {
		const t = this.tmp;
		const A1 = 2896, A2 = 2217, A3 = 3784, A4 = -5352;
		const mul = (x: number, y: number) => (Math.imul(x, y) >> 11);
		const pass = (src: Int32Array, s: number, step: number, dst: Int32Array, d: number, row: boolean) => {
			const at = (k: number) => src[s + k * step];
			const a0 = at(0) + at(4), a1 = at(0) - at(4);
			const a2 = at(2) + at(6), a3 = mul(A1, at(2) - at(6));
			const a4 = at(5) + at(3), a5 = at(5) - at(3);
			const a6 = at(1) + at(7), a7 = at(1) - at(7);
			const b0 = a4 + a6, b1 = mul(A3, a5 + a7);
			const b2 = mul(A4, a5) - b0 + b1;
			const b3 = mul(A1, a6 - a4) - b2;
			const b4 = mul(A2, a7) + b3 - b1;
			const out = [a0 + a2 + b0, a1 + a3 - a2 + b2, a1 - a3 + a2 + b3, a0 - a2 - b4, a0 - a2 + b4, a1 - a3 + a2 - b3, a1 + a3 - a2 - b2, a0 + a2 - b0];
			for (let k = 0; k < 8; k++) dst[d + k * step] = row ? (out[k] + 0x7f) >> 8 : out[k];
		};
		for (let i = 0; i < 8; i++) {
			if (!(block[8 + i] | block[16 + i] | block[24 + i] | block[32 + i] | block[40 + i] | block[48 + i] | block[56 + i])) {
				for (let k = 0; k < 8; k++) t[i + k * 8] = block[i];
			} else {
				pass(block, i, 8, t, i, false);
			}
		}
		for (let i = 0; i < 8; i++) pass(t, i * 8, 1, block, i * 8, true);
	}

	private decodePlane(gb: Bits, plane: number, chroma: boolean) {
		const width = chroma ? this.width >> 1 : this.width, height = chroma ? this.height >> 1 : this.height;
		const bw = chroma ? (this.width + 15) >> 4 : (this.width + 7) >> 3;
		const bh = chroma ? (this.height + 15) >> 4 : (this.height + 7) >> 3;
		const stride = this.strides[plane];
		const cur = this.cur[plane], prev = this.prev[plane];
		const w = (Math.max(width, 8) + 7) & ~7;
		const log2 = (x: number) => 31 - Math.clz32(x);
		const B = this.bundles;
		B[Src.BlockTypes].len = log2((w >> 3) + 511) + 1;
		B[Src.SubBlockTypes].len = log2((w >> 4) + 511) + 1;
		B[Src.Colors].len = log2(bw * 64 + 511) + 1;
		B[Src.IntraDC].len = B[Src.InterDC].len = B[Src.XOff].len = B[Src.YOff].len = log2((w >> 3) + 511) + 1;
		B[Src.Pattern].len = log2((bw << 3) + 511) + 1;
		B[Src.Run].len = log2(bw * 48 + 511) + 1;
		for (let s = 0; s < Src.Count; s++) {
			if (s === Src.Colors) {
				for (const tree of this.colHigh) this.readTree(gb, tree);
				this.colLast = 0;
			}
			if (s !== Src.IntraDC && s !== Src.InterDC) this.readTree(gb, B[s].tree);
			B[s].dec = B[s].ptr = 0;
		}
		const scan = this.tables.patterns, block = this.block, ub = this.ublock;
		const copy = (from: number, to: number) => {
			for (let y = 0; y < 8; y++) cur.set(prev.subarray(from + y * stride, from + y * stride + 8), to + y * stride);
		};
		const moved = (dst: number, bx: number, by: number) => {
			const xoff = this.value(Src.XOff), yoff = this.value(Src.YOff);
			const x = Math.min(Math.max(bx * 8 + xoff, 0), stride - 8), y = Math.min(Math.max(by * 8 + yoff, 0), this.heights[plane] - 8);
			copy(y * stride + x, dst);
		};
		const clip = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
		for (let by = 0; by < bh; by++) {
			this.readBlockTypes(gb, B[Src.BlockTypes]);
			this.readBlockTypes(gb, B[Src.SubBlockTypes]);
			this.readColors(gb, B[Src.Colors]);
			this.readPatterns(gb, B[Src.Pattern]);
			this.readMotion(gb, B[Src.XOff]);
			this.readMotion(gb, B[Src.YOff]);
			this.readDCs(gb, B[Src.IntraDC], false);
			this.readDCs(gb, B[Src.InterDC], true);
			this.readRuns(gb, B[Src.Run]);
			for (let bx = 0; bx < bw; bx++) {
				const dst = by * 8 * stride + bx * 8;
				let type = this.value(Src.BlockTypes);
				// (a 16x16 block's second row was drawn with its first)
				if ((by & 1) && type === Block.Scaled) {
					bx++;
					continue;
				}
				switch (type) {
				case Block.Skip:
					copy(dst, dst);
					break;
				case Block.Scaled: {
					type = this.value(Src.SubBlockTypes);
					switch (type) {
					case Block.Run: {
						let i = 0, k = gb.get(4) * 64;
						do {
							const run = this.value(Src.Run) + 1;
							i += run;
							if (gb.bit()) {
								const v = this.value(Src.Colors);
								for (let j = 0; j < run; j++) ub[scan[k++]] = v;
							} else {
								for (let j = 0; j < run; j++) ub[scan[k++]] = this.value(Src.Colors);
							}
						} while (i < 63);
						if (i === 63) ub[scan[k++]] = this.value(Src.Colors);
						break;
					}
					case Block.Intra:
						block.fill(0);
						block[0] = this.value(Src.IntraDC);
						this.readDCT(gb, block, this.tables.intraQuant);
						this.idct(block);
						for (let i = 0; i < 64; i++) ub[i] = clip(block[i]);
						break;
					case Block.Fill:
						ub.fill(this.value(Src.Colors));
						break;
					case Block.Pattern: {
						const c0 = this.value(Src.Colors), c1 = this.value(Src.Colors);
						for (let j = 0; j < 8; j++) {
							let v = this.value(Src.Pattern);
							for (let i = 0; i < 8; i++, v >>= 1) ub[i + j * 8] = v & 1 ? c1 : c0;
						}
						break;
					}
					case Block.Raw:
						for (let i = 0; i < 64; i++) ub[i] = this.value(Src.Colors);
						break;
					default:
						throw new Error(`Bink: bad scaled block type ${type}`);
					}
					// up 2x into a 16x16 block
					for (let y = 0; y < 8; y++) {
						for (let x = 0; x < 8; x++) {
							const v = ub[y * 8 + x], o = dst + y * 2 * stride + x * 2;
							cur[o] = cur[o + 1] = cur[o + stride] = cur[o + stride + 1] = v;
						}
					}
					bx++;
					break;
				}
				case Block.Motion:
					moved(dst, bx, by);
					break;
				case Block.Run: {
					let i = 0, k = gb.get(4) * 64;
					const put = (v: number) => {
						const s = scan[k++];
						cur[dst + (s & 7) + (s >> 3) * stride] = v;
					};
					do {
						const run = this.value(Src.Run) + 1;
						i += run;
						if (gb.bit()) {
							const v = this.value(Src.Colors);
							for (let j = 0; j < run; j++) put(v);
						} else {
							for (let j = 0; j < run; j++) put(this.value(Src.Colors));
						}
					} while (i < 63);
					if (i === 63) put(this.value(Src.Colors));
					break;
				}
				case Block.Residue: {
					moved(dst, bx, by);
					block.fill(0);
					this.readResidue(gb, block, gb.get(7));
					for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
						const o = dst + y * stride + x;
						cur[o] = (cur[o] + block[y * 8 + x]) & 255;
					}
					break;
				}
				case Block.Intra:
					block.fill(0);
					block[0] = this.value(Src.IntraDC);
					this.readDCT(gb, block, this.tables.intraQuant);
					this.idct(block);
					for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) cur[dst + y * stride + x] = clip(block[y * 8 + x]);
					break;
				case Block.Fill: {
					const v = this.value(Src.Colors);
					for (let y = 0; y < 8; y++) cur.fill(v, dst + y * stride, dst + y * stride + 8);
					break;
				}
				case Block.Inter:
					moved(dst, bx, by);
					block.fill(0);
					block[0] = this.value(Src.InterDC);
					this.readDCT(gb, block, this.tables.interQuant);
					this.idct(block);
					for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
						// (wrapping, not clamped, as the residue too)
						const o = dst + y * stride + x;
						cur[o] = (cur[o] + block[y * 8 + x]) & 255;
					}
					break;
				case Block.Pattern: {
					const c0 = this.value(Src.Colors), c1 = this.value(Src.Colors);
					for (let j = 0; j < 8; j++) {
						let v = this.value(Src.Pattern);
						for (let i = 0; i < 8; i++, v >>= 1) cur[dst + j * stride + i] = v & 1 ? c1 : c0;
					}
					break;
				}
				case Block.Raw:
					for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) cur[dst + j * stride + i] = this.value(Src.Colors);
					break;
				default:
					throw new Error(`Bink: bad block type ${type}`);
				}
			}
		}
		// (each plane ends on a 32-bit boundary)
		const over = (gb.pos - gb.start) & 31;
		if (over) gb.pos += 32 - over;
	}
}
