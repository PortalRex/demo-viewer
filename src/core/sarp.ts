// SAR proof (.sarp) reader. Format: SAR's docs/proofs.md (branch proof).
import {ByteReader} from './readers.ts';
import {readCmdInfo} from './cmdinfo.ts';
import {decodeUserCmd} from './usercmd.ts';
import {decodeSarData} from './sardata.ts';
import type {Check, Run, Segment, Verification} from './model.ts';

const Rec = {
	FILE_INFO: 0x01,
	DATATABLES: 0x02,
	CUSTOMDATA_TABLE: 0x03,
	SEGMENT_BEGIN: 0x10,
	SEGMENT_END: 0x11,
	SYNC: 0x12,
	PACKET: 0x20,
	ENTITIES: 0x21,
	STRINGTABLE: 0x22,
	USERCMD: 0x23,
	CONSOLECMD: 0x24,
	CUSTOMDATA: 0x25,
	EVENT: 0x27,
	END: 0x7f,
} as const;

const CHUNK_MAGIC = 0x4b4e4843;  // "CHNK"
const END_MAGIC = 0x444e4553;    // "SEND"

export const isSarp = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 8)) === 'SARPROOF';

async function inflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array) {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const sha512 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-512', data as BufferSource));
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function readSarp(bytes: Uint8Array, fileName: string): Promise<Run> {
	const r = new ByteReader(bytes);
	r.pos = 8;
	r.u32();  // format version
	const headerSize = r.u32();
	const created = Number(r.u64());
	const warnings: string[] = [];

	// chunks
	const chunks: Uint8Array[] = [];
	let trailer: {count: number; hash: Uint8Array; sig: Uint8Array; key: Uint8Array} | undefined;
	let badCrc = 0;
	r.pos = headerSize;
	while (r.remaining >= 4) {
		const magic = r.u32();
		if (magic === END_MAGIC) {
			trailer = {count: r.u32(), hash: r.bytesN(64), sig: r.bytesN(64), key: r.bytesN(32)};
			break;
		}
		if (magic !== CHUNK_MAGIC || r.remaining < 20) {
			warnings.push(`Unexpected data at byte ${r.pos - 4}; stopped reading there.`);
			break;
		}
		const index = r.u32(), rawSize = r.u32(), storedSize = r.u32(), flags = r.u32(), crc = r.u32();
		if (r.remaining < storedSize) {
			warnings.push(`Chunk ${index} is cut off (the recording didn't finish writing it).`);
			break;
		}
		const stored = r.bytesN(storedSize);
		if (crc32(stored) !== crc) badCrc++;
		const raw = flags & 1 ? await inflate(stored) : stored;
		if (raw.length !== rawSize) warnings.push(`Chunk ${index} unpacked to ${raw.length} bytes, expected ${rawSize}.`);
		chunks.push(raw);
	}

	const verification = await verify(bytes.subarray(0, headerSize), chunks, trailer, badCrc);

	// records
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const all = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		all.set(c, off);
		off += c.length;
	}

	const run: Run = {
		format: 'sarp', fileName, fileSize: bytes.length, info: [['Created', new Date(created * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC']],
		game: '', gameDir: '', player: '', segments: [], verification, warnings,
	};

	let seg: Segment | undefined;
	let sync: number | undefined;
	let lastTick = 0;
	let dataTables: Uint8Array | undefined;
	// ticks before 0 are loading (and the clock resets at the next level
	// change, a few packets before the segment ends): kept off the timeline
	const tickOf = (clock: number) => (sync === undefined ? -1 : clock - sync);
	const touch = (s: Segment, tick: number) => {
		if (tick < s.firstTick) s.firstTick = tick;
		if (tick > s.lastTick) s.lastTick = tick;
	};

	const rr = new ByteReader(all);
	while (rr.remaining > 0) {
		const type = rr.u8();
		const len = rr.varint();
		const body = new ByteReader(rr.bytesN(len));
		try {
			switch (type) {
			case Rec.FILE_INFO: {
				const n = body.varint();
				for (let i = 0; i < n; i++) {
					const k = body.string(), v = body.string();
					run.info.push([k, v]);
					if (k === 'game') run.game = v;
					if (k === 'player') run.player = v;
				}
				break;
			}
			case Rec.SEGMENT_BEGIN: {
				const index = body.varint();
				const flags = body.u8();
				const map = body.string();
				const gameDir = body.string();
				body.string();  // server
				const clientName = body.string();
				body.i32();     // network protocol
				const interval = body.f32();
				run.game ||= gameDir;
				run.gameDir ||= gameDir;
				run.player ||= clientName;
				seg = {
					index, map, startedMidMap: (flags & 1) !== 0, intervalPerTick: interval || 1 / 60,
					firstTick: Infinity, lastTick: -Infinity, views: [], userCmds: [], consoleCmds: [], sar: [], net: [],
				};
				seg.dataTables = dataTables;
				sync = undefined;
				run.segments.push(seg);
				break;
			}
			case Rec.SEGMENT_END:
				if (seg) {
					body.i32();  // clock: read after the next map reset it, so not this segment's
					seg.endReason = body.string();
				}
				seg = undefined;
				break;
			case Rec.SYNC:
				sync = body.i32();
				break;
			case Rec.PACKET: {
				if (!seg) break;
				const flags = body.u8();
				const clock = body.i32();
				const views = readCmdInfo(body);
				const tick = tickOf(clock);
				body.i32(); body.i32();  // sequence numbers
				const bits = body.varint();
				seg.net.push({kind: 'packet', tick: Math.max(0, tick), data: body.bytesN(Math.ceil(bits / 8)), bits, signon: (flags & 1) !== 0, backdoor: (flags & 2) !== 0});
				lastTick = Math.max(0, tick);
				if (flags & 1 || tick < 0) break;  // signon or loading
				touch(seg, tick);
				seg.views.push({tick, ...views[0]});
				break;
			}
			case Rec.DATATABLES:
				// raw payload; written again only if the tables change
				dataTables = body.bytesN(body.remaining);
				run.dataTables ??= dataTables;
				if (seg) seg.dataTables = dataTables;
				break;
			case Rec.ENTITIES: {
				if (!seg) break;
				body.i32();  // server tick
				const flags = body.u8();
				const maxEntries = body.varint(), updated = body.varint(), bits = body.varint();
				seg.net.push({kind: 'entities', tick: lastTick, isDelta: (flags & 1) !== 0, maxEntries, updated, data: body.bytesN(Math.ceil(bits / 8)), bits});
				break;
			}
			case Rec.STRINGTABLE: {
				if (!seg) break;
				body.i32();  // tick
				const name = body.string();
				const n = body.varint();
				const entries = [];
				for (let i = 0; i < n; i++) {
					const index = body.varint();
					const f = body.u8();
					entries.push({index, name: f & 1 ? body.string() : undefined, data: f & 2 ? body.blob() : undefined});
				}
				seg.net.push({kind: 'table', tick: lastTick, name, entries});
				break;
			}
			case Rec.USERCMD: {
				if (!seg) break;
				const tick = tickOf(body.i32());
				if (tick < 0) break;
				body.i32();  // command number
				const slot = body.u8();
				seg.userCmds.push(decodeUserCmd(body.blob(), tick, slot));
				break;
			}
			case Rec.CONSOLECMD: {
				if (!seg) break;
				const tick = Math.max(0, tickOf(body.i32()));
				const flags = body.u8();
				seg.consoleCmds.push({tick, text: body.string(), initialValue: (flags & 1) !== 0});
				break;
			}
			case Rec.CUSTOMDATA: {
				if (!seg) break;
				const tick = Math.max(0, tickOf(body.i32()));
				const callback = body.i32();
				const data = body.blob();
				if (callback === 0) {
					const e = decodeSarData(data, tick);
					if (e) seg.sar.push(e);
				}
				break;
			}
			}
		} catch (e) {
			warnings.push(`Couldn't read a record of type 0x${type.toString(16)}: ${(e as Error).message}`);
		}
	}

	for (const s of run.segments) {
		if (!isFinite(s.firstTick)) s.firstTick = s.lastTick = 0;
	}
	return run;
}

async function verify(header: Uint8Array, chunks: Uint8Array[], trailer: {count: number; hash: Uint8Array; sig: Uint8Array; key: Uint8Array} | undefined, badCrc: number): Promise<Verification> {
	let hash = await sha512(header);
	for (const c of chunks) {
		const buf = new Uint8Array(hash.length + c.length);
		buf.set(hash);
		buf.set(c, hash.length);
		hash = await sha512(buf);
	}

	const complete: Check = trailer
		? {state: 'ok', detail: `Stopped cleanly after ${trailer.count} chunks.`}
		: {state: 'unknown', detail: 'No end marker: the recording was cut short (crash or game closed). Everything up to the last whole chunk is readable.'};

	let hashChain: Check;
	if (badCrc) hashChain = {state: 'bad', detail: `${badCrc} chunk(s) fail their CRC check: the file is damaged.`};
	else if (!trailer) hashChain = {state: 'unknown', detail: 'Chunks read fine, but there is no final hash to check them against.'};
	else if (trailer.count !== chunks.length) hashChain = {state: 'bad', detail: `The end marker says ${trailer.count} chunks, the file has ${chunks.length}.`};
	else if (!equal(hash, trailer.hash)) hashChain = {state: 'bad', detail: 'The data does not match the final hash: the file was changed after recording.'};
	else hashChain = {state: 'ok', detail: `All ${chunks.length} chunks match the hash chain.`};

	let signature: Check;
	if (!trailer || trailer.sig.every(b => b === 0)) {
		signature = {state: 'none', detail: 'Not signed (development builds of SAR don\'t sign proofs).'};
	} else {
		try {
			const key = await crypto.subtle.importKey('raw', trailer.key as BufferSource, {name: 'Ed25519'}, false, ['verify']);
			const ok = await crypto.subtle.verify({name: 'Ed25519'}, key, trailer.sig as BufferSource, trailer.hash as BufferSource);
			signature = ok
				? {state: 'ok', detail: `Valid signature by key ${hex(trailer.key).slice(0, 16)}…`}
				: {state: 'bad', detail: 'The signature does not match the final hash.'};
		} catch {
			signature = {state: 'unknown', detail: 'This browser can\'t check Ed25519 signatures.'};
		}
	}

	return {hashChain, signature, complete};
}
