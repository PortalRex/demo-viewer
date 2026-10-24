// Network string tables: the entries of svc_CreateStringTable /
// svc_UpdateStringTable, and the dem_stringtables snapshot. The viewer needs
// "instancebaseline" (class baselines) and "modelprecache" (model names).
import {BitReader} from '../core/readers.ts';
import {highestBit, readBitString} from './datatables.ts';

const SUBSTRING_BITS = 5;
const MAX_USERDATA_BITS = 14;

export interface StringTable {
	name: string;
	maxEntries: number;
	fixedSize: boolean;
	userDataBits: number;
	entries: {name: string; data?: Uint8Array}[];
}

function readBits(br: BitReader, nbits: number) {
	const out = new Uint8Array(Math.ceil(nbits / 8));
	let i = 0;
	for (; nbits >= 8; nbits -= 8) out[i++] = br.u(8);
	if (nbits) out[i] = br.u(nbits);
	return out;
}

// Applies an entry list (the data of a create or update message).
export function applyEntries(t: StringTable, br: BitReader, count: number) {
	if (br.bit()) throw new Error(`string table ${t.name}: dictionary encoding isn't supported`);
	const history: string[] = [];
	let index = -1;
	const indexBits = highestBit(t.maxEntries);
	for (let n = 0; n < count; n++) {
		index++;
		if (!br.bit()) index = br.u(indexBits);
		let name: string | undefined;
		if (br.bit()) {
			if (br.bit()) {
				const h = br.u(SUBSTRING_BITS), len = br.u(SUBSTRING_BITS);
				name = (history[h] ?? '').slice(0, len) + readBitString(br);
			} else {
				name = readBitString(br);
			}
		}
		const entry = t.entries[index] ?? (t.entries[index] = {name: ''});
		if (name !== undefined) entry.name = name;
		if (history.length === 32) history.shift();
		history.push(entry.name);
		if (br.bit()) {
			entry.data = t.fixedSize ? readBits(br, t.userDataBits) : readBits(br, br.u(MAX_USERDATA_BITS) * 8);
		}
	}
}

export function lzssDecompress(src: Uint8Array): Uint8Array {
	const out: number[] = [];
	let p = 0, cmd = 0, getCmd = 0;
	for (;;) {
		if (getCmd === 0) cmd = src[p++];
		getCmd = (getCmd + 1) & 7;
		if (cmd & 1) {
			const position = (src[p] << 4) | (src[p + 1] >> 4);
			const count = (src[p + 1] & 0x0f) + 1;
			p += 2;
			if (count === 1) break;
			const start = out.length - position - 1;
			for (let i = 0; i < count; i++) out.push(out[start + i]);
		} else {
			out.push(src[p++]);
		}
		cmd >>= 1;
		if (p > src.length) break;
	}
	return new Uint8Array(out);
}

// dem_stringtables (frame 9): every table's entries at the start of a demo
export function readStringTableSnapshot(data: Uint8Array, tables: Map<string, StringTable>) {
	const br = new BitReader(data);
	const n = br.u(8);
	for (let i = 0; i < n; i++) {
		const name = readBitString(br);
		const t = tables.get(name) ?? {name, maxEntries: 0, fixedSize: false, userDataBits: 0, entries: []};
		tables.set(name, t);
		const count = br.u(16);
		for (let e = 0; e < count; e++) {
			const ename = readBitString(br);
			const entry = t.entries[e] ?? (t.entries[e] = {name: ''});
			entry.name = ename;
			if (br.bit()) entry.data = readBits(br, br.u(16) * 8);
		}
		if (br.bit()) {
			const c = br.u(16);
			for (let e = 0; e < c; e++) {
				readBitString(br);
				if (br.bit()) {
					const n = br.u(16);
					br.pos += n * 8;
				}
			}
		}
	}
}
