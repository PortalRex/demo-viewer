// Source demo (.dem) reader, Portal 2 flavour (demo protocol 4).
import {ByteReader} from './readers.ts';
import {readCmdInfo, CMDINFO_SIZE, CMDINFO_SLOTS} from './cmdinfo.ts';
import {decodeUserCmd} from './usercmd.ts';
import {decodeSarData} from './sardata.ts';
import type {Run, Segment} from './model.ts';

const Cmd = {
	SIGNON: 1,
	PACKET: 2,
	SYNCTICK: 3,
	CONSOLECMD: 4,
	USERCMD: 5,
	DATATABLES: 6,
	STOP: 7,
	CUSTOMDATA: 8,
	STRINGTABLES: 9,
} as const;

export const isDem = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 8)) === 'HL2DEMO\0';

export function readDem(bytes: Uint8Array, fileName: string): Run {
	const r = new ByteReader(bytes, 8);
	const demoProtocol = r.i32();
	const netProtocol = r.i32();
	const server = r.fixedString(260);
	const client = r.fixedString(260);
	const map = r.fixedString(260);
	const gameDir = r.fixedString(260);
	const playbackTime = r.f32();
	const ticks = r.i32();
	const frames = r.i32();
	r.i32();  // signon length

	const warnings: string[] = [];
	if (demoProtocol !== 4) warnings.push(`Demo protocol ${demoProtocol}; this viewer expects Portal 2's (4).`);

	const seg: Segment = {
		index: 0, map, startedMidMap: false, intervalPerTick: ticks > 0 && playbackTime > 0 ? playbackTime / ticks : 1 / 60,
		firstTick: Infinity, lastTick: -Infinity, views: [], userCmds: [], consoleCmds: [], sar: [], net: [],
	};

	let synced = false;
	let dataTables: Uint8Array | undefined;
	frameLoop: while (r.remaining >= 6) {
		const cmd = r.u8();
		const tick = r.i32();
		const slot = r.u8();
		try {
			switch (cmd) {
			case Cmd.SIGNON:
			case Cmd.PACKET: {
				const views = readCmdInfo(r);
				r.i32(); r.i32();  // sequence numbers
				const size = r.i32();
				const data = r.bytesN(size);
				seg.net.push({kind: 'packet', tick: Math.max(0, tick), data, bits: size * 8, signon: cmd === Cmd.SIGNON, backdoor: false});
				if (cmd === Cmd.PACKET && synced && tick >= 0) {
					seg.views.push({tick, ...views[0]});
					if (tick < seg.firstTick) seg.firstTick = tick;
					if (tick > seg.lastTick) seg.lastTick = tick;
				}
				break;
			}
			case Cmd.SYNCTICK:
				synced = true;
				break;
			case Cmd.CONSOLECMD:
				seg.consoleCmds.push({tick, text: new TextDecoder().decode(r.bytesN(r.i32())).replace(/\0+$/, '')});
				break;
			case Cmd.USERCMD: {
				r.i32();  // outgoing sequence
				const data = r.bytesN(r.i32());
				if (tick >= 0) seg.userCmds.push(decodeUserCmd(data, tick, slot));
				break;
			}
			case Cmd.DATATABLES:
				dataTables = r.bytesN(r.i32());
				break;
			case Cmd.STRINGTABLES:
				seg.net.push({kind: 'snapshot', tick: Math.max(0, tick), data: r.bytesN(r.i32())});
				break;
			case Cmd.CUSTOMDATA: {
				const callback = r.i32();
				const data = r.bytesN(r.i32());
				if (callback === 0) {
					const e = decodeSarData(data, tick);
					if (e) seg.sar.push(e);
				}
				break;
			}
			case Cmd.STOP:
				break frameLoop;
			default:
				warnings.push(`Unknown frame type ${cmd} at byte ${r.pos - 6}; stopped reading there.`);
				break frameLoop;
			}
		} catch {
			warnings.push('The demo ends in the middle of a frame (it was cut short).');
			break;
		}
	}
	if (!isFinite(seg.firstTick)) seg.firstTick = seg.lastTick = 0;

	return {
		format: 'dem', fileName, fileSize: bytes.length,
		info: [
			['Server', server], ['Client', client], ['Map', map], ['Game', gameDir],
			['Demo protocol', String(demoProtocol)], ['Network protocol', String(netProtocol)],
			['Header ticks', String(ticks)], ['Header time', `${playbackTime.toFixed(3)} s`], ['Frames', String(frames)],
		],
		game: gameDir, gameDir, player: client, segments: [seg], dataTables, warnings,
	};
}

export {CMDINFO_SIZE, CMDINFO_SLOTS};
