import type {ByteReader} from './readers.ts';
import type {Vec3} from './model.ts';

// democmdinfo_t: per split-screen slot, flags + view origin/angles/local
// angles, then the same again for the second view. Two slots in Portal 2.
export const CMDINFO_SIZE = 76;
export const CMDINFO_SLOTS = 2;

export function readCmdInfo(r: ByteReader): {origin: Vec3; angles: Vec3}[] {
	const out = [];
	for (let slot = 0; slot < CMDINFO_SLOTS; slot++) {
		const start = r.pos;
		r.i32();  // flags
		const origin: Vec3 = [r.f32(), r.f32(), r.f32()];
		const angles: Vec3 = [r.f32(), r.f32(), r.f32()];
		r.pos = start + CMDINFO_SIZE;
		out.push({origin, angles});
	}
	return out;
}
