// SAR's demo data: custom data callback 0, an 8-byte co-op radial menu cursor
// position, then a type byte and the message (see SAR's RecordData callers).
import {ByteReader} from './readers.ts';
import type {SarEvent, SarSplit} from './model.ts';

export function decodeSarData(data: Uint8Array, tick: number): SarEvent | null {
	if (data.length < 9) return null;
	const r = new ByteReader(data, 8);
	const type = r.u8();
	try {
		switch (type) {
		case 0x01:
			return {tick, kind: 'timescale', timescale: r.f32()};
		case 0x02:
			return {tick, kind: 'cvar', name: r.cstring(), value: r.cstring()};
		case 0x03:
		case 0x04: {
			const slot = type === 0x04 ? r.u8() : undefined;
			return {tick, kind: 'entityInput', slot, target: r.cstring(), className: r.cstring(), input: r.cstring(), param: r.cstring()};
		}
		case 0x05:
			return {tick, kind: 'portal', slot: r.u8(), orange: r.u8() !== 0, pos: [r.f32(), r.f32(), r.f32()]};
		case 0x06:
			return {tick, kind: 'cmFlags', slot: r.u8()};
		case 0x07:
			return {tick, kind: 'crouchFly', slot: r.u8()};
		case 0x08:
			return {tick, kind: 'pause', ticks: r.i32(), timed: r.u8() !== 0};
		case 0x09:
		case 0x0D:  // hwait
			return {tick, kind: 'waitRun', tick2: r.i32(), cmd: r.cstring()};
		case 0x0A:
		case 0x12:
			return {tick, kind: 'speedrunTime', complete: type === 0x0A, ...readSummary(r)};
		case 0x0B: {
			const year = r.u16(), month = r.u8(), day = r.u8(), h = r.u8(), m = r.u8(), s = r.u8();
			return {tick, kind: 'timestamp', date: new Date(Date.UTC(year, month, day, h, m, s))};
		}
		case 0x0C:
			return {tick, kind: 'fileChecksum', sum: r.u32(), path: r.cstring()};
		case 0x0E:
			return {tick, kind: 'entitySerial', slot: r.i32(), serial: r.i32()};
		case 0x0F:
			return {tick, kind: 'frametime', frametime: r.f32()};
		case 0x10:
			return {tick, kind: 'queuedCmd', cmd: r.cstring()};
		case 0x13:
			return {tick, kind: 'speedrunId', id: [...r.bytesN(16)].map(b => b.toString(16).padStart(2, '0')).join('')};
		case 0x14:
			return {tick, kind: 'vscriptChecksum', sum: r.u32(), path: r.cstring()};
		default:
			return {tick, kind: 'other', type, size: data.length - 9};
		}
	} catch {
		return {tick, kind: 'other', type, size: data.length - 9};
	}
}

function readSummary(r: ByteReader) {
	const splits: SarSplit[] = [];
	const nSplits = r.i32();
	for (let i = 0; i < nSplits; i++) {
		const name = r.cstring();
		const segments = [];
		const n = r.i32();
		for (let j = 0; j < n; j++) segments.push({name: r.cstring(), ticks: r.i32()});
		splits.push({name, segments});
	}
	const rules: {name: string; description: string}[] = [];
	if (r.remaining >= 8) {
		r.i32();  // rules format version
		const n = r.i32();
		for (let i = 0; i < n; i++) rules.push({name: r.cstring(), description: r.cstring()});
	}
	return {splits, rules};
}

export function describeSarEvent(e: SarEvent): string {
	switch (e.kind) {
	case 'timescale': return `Timescale ${e.timescale.toFixed(3)} detected`;
	case 'cvar': return `${e.name} = ${e.value}`;
	case 'entityInput': return `${e.target || e.className}: ${e.input}${e.param ? ` (${e.param})` : ''}`;
	case 'portal': return `${e.orange ? 'Orange' : 'Blue'} portal at ${e.pos.map(v => v.toFixed(0)).join(' ')}`;
	case 'cmFlags': return 'Challenge mode flags';
	case 'crouchFly': return 'Crouch fly';
	case 'pause': return `Paused ${e.ticks} ticks${e.timed ? ' (timed)' : ''}`;
	case 'waitRun': return `wait ${e.tick2}: ${e.cmd}`;
	case 'speedrunTime': return `Speedrun ${e.complete ? 'finished' : 'summary'}: ${e.splits.length} splits`;
	case 'timestamp': return `Recorded ${e.date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
	case 'fileChecksum': return `File checksum ${e.path}`;
	case 'entitySerial': return `Entity slot ${e.slot} serial ${e.serial}`;
	case 'frametime': return `Frame time ${(e.frametime * 1000).toFixed(2)} ms`;
	case 'queuedCmd': return `Queued: ${e.cmd}`;
	case 'speedrunId': return `Speedrun id ${e.id}`;
	case 'vscriptChecksum': return `VScript checksum ${e.path}`;
	case 'other': return `SAR data type 0x${e.type.toString(16)} (${e.size} bytes)`;
	}
}
