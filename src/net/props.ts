// Reading the values of an entity update (the props after a field index).
import type {BitReader} from '../core/readers.ts';
import {F, PropType, highestBit} from './datatables.ts';
import type {FlatProp, SendProp} from './datatables.ts';

const COORD_INT_BITS = 14, COORD_FRAC_BITS = 5, COORD_INT_BITS_MP = 11, COORD_FRAC_BITS_MP_LP = 3;
const NORMAL_FRAC_BITS = 11, DT_MAX_STRING_BITS = 9;

export type PropValue = number | string | number[] | PropValue[];

function readFloat(br: BitReader, p: SendProp): number {
	const f = p.flags;
	if (f & F.COORD) {
		const hasInt = br.bit(), hasFrac = br.bit();
		if (!hasInt && !hasFrac) return 0;
		const sign = br.bit();
		const i = hasInt ? br.u(COORD_INT_BITS) + 1 : 0;
		const fr = hasFrac ? br.u(COORD_FRAC_BITS) : 0;
		const v = i + fr / (1 << COORD_FRAC_BITS);
		return sign ? -v : v;
	}
	if (f & (F.COORDMP | F.COORDMPLP | F.COORDMPINT)) {
		const inBounds = br.bit();
		if (f & F.COORDMPINT) {
			if (!br.bit()) return 0;
			const sign = br.bit();
			const v = br.u(inBounds ? COORD_INT_BITS_MP : COORD_INT_BITS) + 1;
			return sign ? -v : v;
		}
		const hasInt = br.bit(), sign = br.bit();
		const i = hasInt ? br.u(inBounds ? COORD_INT_BITS_MP : COORD_INT_BITS) + 1 : 0;
		const lp = (f & F.COORDMPLP) !== 0;
		const fr = br.u(lp ? COORD_FRAC_BITS_MP_LP : COORD_FRAC_BITS);
		const v = i + fr / (1 << (lp ? COORD_FRAC_BITS_MP_LP : COORD_FRAC_BITS));
		return sign ? -v : v;
	}
	if (f & F.NOSCALE) return br.f32();
	if (f & F.NORMAL) {
		const sign = br.bit();
		const v = br.u(NORMAL_FRAC_BITS) / ((1 << NORMAL_FRAC_BITS) - 1);
		return sign ? -v : v;
	}
	if (f & F.CELLCOORD) return br.u(p.bits) + br.u(COORD_FRAC_BITS) / (1 << COORD_FRAC_BITS);
	if (f & F.CELLCOORDLP) return br.u(p.bits) + br.u(COORD_FRAC_BITS_MP_LP) / (1 << COORD_FRAC_BITS_MP_LP);
	if (f & F.CELLCOORDINT) return br.u(p.bits);
	const raw = br.u(p.bits);
	return p.low + (p.high - p.low) * (raw / (2 ** p.bits - 1));
}

function readProp(br: BitReader, p: SendProp, element?: SendProp): PropValue {
	switch (p.type) {
	case PropType.INT:
		return p.flags & F.UNSIGNED ? br.u(p.bits) : br.s(p.bits);
	case PropType.FLOAT:
		return readFloat(br, p);
	case PropType.VEC3: {
		const x = readFloat(br, p), y = readFloat(br, p);
		if (p.flags & F.NORMAL) {
			const sign = br.bit();
			const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
			return [x, y, sign ? -z : z];
		}
		return [x, y, readFloat(br, p)];
	}
	case PropType.VEC2:
		return [readFloat(br, p), readFloat(br, p)];
	case PropType.STRING: {
		const n = br.u(DT_MAX_STRING_BITS);
		const chars: number[] = [];
		for (let i = 0; i < n; i++) chars.push(br.u(8));
		return String.fromCharCode(...chars);
	}
	case PropType.ARRAY: {
		const n = br.u(highestBit(p.elements) + 1);
		const out: PropValue[] = [];
		for (let i = 0; i < n; i++) out.push(readProp(br, element!));
		return out;
	}
	}
	throw new Error(`bad prop type ${p.type}`);
}

function readUBitInt(br: BitReader) {
	const r = br.u(4);
	switch (br.u(2)) {
	case 0: return r;
	case 1: return r | (br.u(4) << 4);
	case 2: return r | (br.u(8) << 4);
	default: return r + br.u(28) * 16;
	}
}
export {readUBitInt};

function readFieldIndex(br: BitReader, last: number, newWay: boolean) {
	if (newWay && br.bit()) return last + 1;
	let ret: number;
	if (newWay && br.bit()) {
		ret = br.u(3);
	} else {
		ret = br.u(5);
		const sel = br.u(2);
		if (sel === 1) ret |= br.u(2) << 5;
		else if (sel === 2) ret |= br.u(4) << 5;
		else if (sel === 3) ret |= br.u(7) << 5;
	}
	return ret === 0xfff ? -1 : last + 1 + ret;
}

// Reads one entity's changed props into `state`; returns the changed indices.
export function readEntityProps(br: BitReader, flat: FlatProp[], state: PropValue[]): number[] {
	const changed: number[] = [];
	const newWay = br.bit() === 1;
	let i = -1;
	for (;;) {
		i = readFieldIndex(br, i, newWay);
		if (i === -1) break;
		if (i < 0 || i >= flat.length) throw new Error(`bad field index ${i} (${flat.length} props)`);
		state[i] = readProp(br, flat[i].prop, flat[i].element);
		changed.push(i);
	}
	return changed;
}
