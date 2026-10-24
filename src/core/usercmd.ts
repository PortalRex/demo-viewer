// CUserCmd as written by CInput::EncodeUserCmdToBuffer: every field is a
// "changed" bit plus the value, relative to an all-zero command.
import {BitReader} from './readers.ts';
import type {UserCmd} from './model.ts';

export const Buttons = {
	ATTACK: 1 << 0,
	JUMP: 1 << 1,
	DUCK: 1 << 2,
	FORWARD: 1 << 3,
	BACK: 1 << 4,
	USE: 1 << 5,
	MOVELEFT: 1 << 9,
	MOVERIGHT: 1 << 10,
	ATTACK2: 1 << 11,
	ZOOM: 1 << 19,
} as const;

const MAX_EDICT_BITS = 11;

export function decodeUserCmd(data: Uint8Array, tick: number, slot: number): UserCmd {
	const br = new BitReader(data);
	const cmd: UserCmd = {
		tick, slot, commandNumber: 0, viewAngles: [0, 0, 0], forwardMove: 0, sideMove: 0, upMove: 0,
		buttons: 0, impulse: 0, mouseDx: 0, mouseDy: 0,
	};
	try {
		if (br.bit()) cmd.commandNumber = br.u(32);
		if (br.bit()) br.u(32);  // tick count
		for (let i = 0; i < 3; i++) if (br.bit()) cmd.viewAngles[i] = br.f32();
		if (br.bit()) cmd.forwardMove = br.f32();
		if (br.bit()) cmd.sideMove = br.f32();
		if (br.bit()) cmd.upMove = br.f32();
		if (br.bit()) cmd.buttons = br.u(32);
		if (br.bit()) cmd.impulse = br.u(8);
		if (br.bit()) {
			br.u(MAX_EDICT_BITS);  // weapon select
			if (br.bit()) br.u(6);  // subtype
		}
		if (br.bit()) cmd.mouseDx = br.s(16);
		if (br.bit()) cmd.mouseDy = br.s(16);
	} catch {
		// a short buffer just leaves the remaining fields at zero
	}
	return cmd;
}
