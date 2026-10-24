// Gel: the paint state the server sends at connect (svc_PaintmapData) and
// the paint user messages that change it during play.
import type {BitReader} from '../core/readers.ts';
import type {Vec3} from '../core/model.ts';

export const Power = {BOUNCE: 0, REFLECT: 1, SPEED: 2, PORTAL: 3, NONE: 4} as const;

// Portal 2's user message numbers (registration order)
const MSG_PAINT_WORLD = 49, MSG_REMOVE_ALL_PAINT = 53, MSG_PAINT_ALL_SURFACES = 54, MSG_REMOVE_PAINT = 55;

export type PaintEvent = {tick: number} & (
	// full state: per surface (world face index), one byte per lightmap luxel
	| {kind: 'map'; surfaces: {face: number; data: Uint8Array}[]}
	// splats at points on a brush entity's surfaces (entity 0 = the world)
	| {kind: 'world'; power: number; entity: number; radius: number; alpha: number; points: Vec3[]}
	| {kind: 'removeAll'}
	| {kind: 'all'; power: number}
	| {kind: 'remove'; entity: number}
);

const handleIndex = (h: number) => h & 0x7ff;

export function readPaintMessage(type: number, br: BitReader, tick: number): PaintEvent | null {
	try {
		switch (type) {
		case MSG_PAINT_WORLD: {
			const power = br.u(8);
			const entity = handleIndex(br.s(32));
			const radius = br.f32();
			const alpha = br.f32();
			const n = br.u(8);
			const c: Vec3 = [br.f32(), br.f32(), br.f32()];
			const points: Vec3[] = [];
			for (let i = 0; i < n; i++) points.push([c[0] + br.s(16), c[1] + br.s(16), c[2] + br.s(16)]);
			return {tick, kind: 'world', power, entity, radius, alpha, points};
		}
		case MSG_REMOVE_ALL_PAINT:
			return {tick, kind: 'removeAll'};
		case MSG_PAINT_ALL_SURFACES:
			return {tick, kind: 'all', power: br.u(8)};
		case MSG_REMOVE_PAINT:
			return {tick, kind: 'remove', entity: handleIndex(br.s(32))};
		}
	} catch {
		// a short message: ignore it
	}
	return null;
}

// svc_PaintmapData: big-endian dwords; per painted surface its index, the
// RLE length, then RLE data (negative count: a run of one dword, positive:
// that many raw dwords). The decoded dwords are the surface's paint bytes.
export function readPaintmap(br: BitReader, tick: number): PaintEvent | null {
	const n = Math.floor(br.remaining / 32);
	const words = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		const le = br.u(32);
		words[i] = ((le & 0xff) << 24 | (le & 0xff00) << 8 | (le >>> 8) & 0xff00 | le >>> 24) >>> 0;
	}
	const surfaces: {face: number; data: Uint8Array}[] = [];
	let p = 0;
	while (p + 2 <= n) {
		const face = words[p++];
		const size = words[p++];
		const end = Math.min(n, p + size);
		const out: number[] = [];
		while (p < end) {
			const count = words[p++] | 0;
			if (count < 0) {
				const v = words[p++];
				for (let i = 0; i < -count; i++) out.push(v);
			} else {
				for (let i = 0; i < count && p < end; i++) out.push(words[p++]);
			}
		}
		const bytes = new Uint8Array(out.length * 4);
		const dv = new DataView(bytes.buffer);
		out.forEach((w, i) => dv.setUint32(i * 4, w, true));
		surfaces.push({face, data: bytes});
		p = end;
	}
	return surfaces.length ? {tick, kind: 'map', surfaces} : null;
}
