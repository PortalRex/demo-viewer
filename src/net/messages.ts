// Walks the net messages of a packet (demo protocol 4 / Portal 2), handing
// string table changes and svc_PacketEntities to the entity decoder and
// skipping the rest.
import {BitReader} from '../core/readers.ts';
import {highestBit, readBitString} from './datatables.ts';
import {applyEntries, lzssDecompress} from './stringtables.ts';
import type {StringTable} from './stringtables.ts';

const NET_MSG_TYPE_BITS = 6, MAX_EDICT_BITS = 11, USER_MSG_LEN_BITS = 12, SP_MODEL_INDEX_BITS = 11;
const COORD_INT_BITS = 14, COORD_FRAC_BITS = 5;

export interface PacketEntitiesHeader {
	maxEntries: number;
	isDelta: boolean;
	deltaFrom: number;
	baseline: number;
	updated: number;
	updateBaseline: boolean;
	data: BitReader;  // the entity data, on its own
}

export interface NetHandlers {
	tables: StringTable[];  // in creation order (updates refer to them by index)
	classBits: number;
	onTableChange?: (t: StringTable) => void;
	onPacketEntities?: (h: PacketEntitiesHeader) => void;
	trace?: (type: number, bitPos: number) => void;
	onUserMessage?: (type: number, data: BitReader) => void;
	onPaintmap?: (data: BitReader) => void;
	onTempEntities?: (count: number, data: BitReader) => void;
}

// reads a length, then skips that many units (pos += u() would read pos first)
const skipLength = (br: BitReader, lengthBits: number, unitBits: number) => {
	const n = br.u(lengthBits);
	br.pos += n * unitBits;
};

const skipString = (br: BitReader) => {
	while (br.u(8) !== 0);
};

function sub(br: BitReader, nbits: number) {
	// a reader over the next nbits, without copying
	const r = new BitReader(br.bytes, br.pos + nbits);
	r.pos = br.pos;
	br.pos += nbits;
	if (br.pos > br.end) throw new RangeError('message runs past the end of the packet');
	return r;
}

export function walkPacket(data: Uint8Array, nbits: number, h: NetHandlers) {
	const br = new BitReader(data, nbits);
	while (br.remaining >= NET_MSG_TYPE_BITS) {
		const type = br.u(NET_MSG_TYPE_BITS);
		h.trace?.(type, br.pos);
		switch (type) {
		case 0: break;  // nop
		case 1: skipString(br); break;  // disconnect
		case 2: br.pos += 32; skipString(br); br.pos += 2; break;  // file
		case 3: br.pos += 1; break;  // split screen user
		case 4: br.pos += 64; break;  // tick
		case 5: skipString(br); break;  // string cmd
		case 6: {  // set convar
			const n = br.u(8);
			for (let i = 0; i < n; i++) {
				skipString(br);
				skipString(br);
			}
			break;
		}
		case 7: {  // signon state
			br.pos += 72;
			skipLength(br, 32, 8);
			skipLength(br, 32, 8);
			break;
		}
		case 8:  // server info
			br.pos += 16 + 32 + 1 + 1 + 32 + 32 + 16 + 32 + 8 + 8 + 32 + 8;
			skipString(br); skipString(br); skipString(br); skipString(br);
			break;
		case 9: throw new Error('svc_SendTable in a packet');
		case 10: {  // class info
			const n = br.u(16);
			if (!br.bit()) {
				for (let i = 0; i < n; i++) {
					br.pos += h.classBits;
					skipString(br);
					skipString(br);
				}
			}
			break;
		}
		case 11: br.pos += 1; break;  // set pause
		case 12: {  // create string table
			const name = readBitString(br);
			const maxEntries = br.u(16);
			const count = br.u(highestBit(maxEntries) + 1);
			const dataBits = br.u(20);
			const fixedSize = br.bit() === 1;
			let userDataBits = 0;
			if (fixedSize) {
				br.pos += 12;
				userDataBits = br.u(4);
			}
			const flags = br.u(2);
			const t: StringTable = {name, maxEntries, fixedSize, userDataBits, entries: []};
			h.tables.push(t);
			let blob = sub(br, dataBits);
			if (flags & 1) {
				// LZSS: u32 uncompressed size, u32 compressed size, "LZSS", u32 size, data
				blob.u(32);
				const compSize = blob.u(32);
				const bytes = new Uint8Array(compSize);
				for (let i = 0; i < compSize; i++) bytes[i] = blob.u(8);
				blob = new BitReader(lzssDecompress(bytes.subarray(8)));
			}
			applyEntries(t, blob, count);
			h.onTableChange?.(t);
			break;
		}
		case 13: {  // update string table
			const id = br.u(5);
			const count = br.bit() ? br.u(16) : 1;
			const dataBits = br.u(20);
			const blob = sub(br, dataBits);
			const t = h.tables[id];
			if (t) {
				applyEntries(t, blob, count);
				h.onTableChange?.(t);
			}
			break;
		}
		case 14: {  // voice init
			skipString(br);
			if (br.u(8) === 255) br.pos += 16;
			break;
		}
		case 15: br.pos += 16; skipLength(br, 16, 1); break;  // voice data
		case 16: skipString(br); break;  // print
		case 17: {  // sounds
			const reliable = br.bit();
			if (!reliable) br.pos += 8;
			skipLength(br, reliable ? 8 : 16, 1);
			break;
		}
		case 18: br.pos += MAX_EDICT_BITS; break;  // set view
		case 19: br.pos += 49; break;  // fix angle
		case 20: br.pos += 48; break;  // crosshair angle
		case 21: {  // bsp decal
			const has = [br.bit(), br.bit(), br.bit()];
			for (const e of has) {
				if (!e) continue;
				const hi = br.bit(), hf = br.bit();
				if (hi || hf) {
					br.bit();
					if (hi) br.pos += COORD_INT_BITS;
					if (hf) br.pos += COORD_FRAC_BITS;
				}
			}
			br.pos += 9;
			if (br.bit()) br.pos += MAX_EDICT_BITS + SP_MODEL_INDEX_BITS;
			br.pos += 1;
			break;
		}
		case 22: br.pos += 2 + MAX_EDICT_BITS; break;  // split screen
		case 23: {  // user message
			const msgType = br.u(8);
			const n = br.u(USER_MSG_LEN_BITS);
			const data = sub(br, n);
			h.onUserMessage?.(msgType, data);
			break;
		}
		case 24: br.pos += MAX_EDICT_BITS + 9; skipLength(br, 11, 1); break;  // entity message
		case 25: skipLength(br, 11, 1); break;  // game event
		case 26: {  // packet entities
			const maxEntries = br.u(MAX_EDICT_BITS);
			const isDelta = br.bit() === 1;
			const deltaFrom = isDelta ? br.s(32) : -1;
			const baseline = br.bit();
			const updated = br.u(MAX_EDICT_BITS);
			const dataBits = br.u(20);
			const updateBaseline = br.bit() === 1;
			const data = sub(br, dataBits);
			h.onPacketEntities?.({maxEntries, isDelta, deltaFrom, baseline, updated, updateBaseline, data});
			break;
		}
		case 27: {  // temp entities
			const count = br.u(8);
			const n = br.u(17);
			const data = sub(br, n);
			h.onTempEntities?.(count, data);
			break;
		}
		case 28: br.pos += 13; break;  // prefetch
		case 29: br.pos += 16; skipLength(br, 32, 1); break;  // menu
		case 30: br.pos += 9; skipLength(br, 20, 1); break;  // game event list
		case 31: br.pos += 32; skipString(br); break;  // get cvar value
		case 32: skipLength(br, 32, 8); break;  // cmd key values
		case 33: {  // paint map data
			const n = br.u(32);
			const data = sub(br, n);
			h.onPaintmap?.(data);
			break;
		}
		default: throw new Error(`unknown net message ${type}`);
		}
		if (br.pos > br.end) throw new RangeError(`net message ${type} runs past the end of the packet`);
	}
}
