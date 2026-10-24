// Studio model skeletons and animation: bones, sequences (the model's own and
// those of $includemodel files, as the engine's virtual model lists them),
// and their compressed per-bone animation data, sampled at a cycle.
import type {GameFiles} from './files.ts';

export interface Bone {
	name: string;
	parent: number;
	pos: [number, number, number];
	quat: [number, number, number, number];  // x y z w
	rot: [number, number, number];           // RadianEuler of the same rotation
	posScale: [number, number, number];
	rotScale: [number, number, number];
	poseToBone: number[];  // 3x4, row major (model space -> bone space)
}

interface AnimDesc {
	src: SourceModel;
	offset: number;       // of the desc in its file
	fps: number;
	flags: number;
	frames: number;
	animBlock: number;
	animIndex: number;
	sectionIndex: number;
	sectionFrames: number;
}

export interface Sequence {
	label: string;
	looping: boolean;
	anim: AnimDesc | null;  // the first blend
}

interface SourceModel {
	bytes: Uint8Array;
	view: DataView;
	bones: Bone[];
	toMain: number[];           // source bone -> main model bone (-1 if none)
	animBlocks: {start: number; end: number}[];
	ani: Uint8Array | null;     // the .ani file, for anim blocks
}

export interface Skeleton {
	bones: Bone[];
	sequences: Sequence[];
	ref?: Pose;      // reference pose, made on first use
	scratch?: Pose;  // for the second frame when interpolating
}

const STUDIO_LOOPING = 0x1;
const STUDIO_DELTA = 0x4;
const STUDIO_ALLZEROS = 0x20;
const ANIM_RAWPOS = 0x1, ANIM_RAWROT = 0x2, ANIM_ANIMPOS = 0x4, ANIM_ANIMROT = 0x8, ANIM_RAWROT2 = 0x20;

const cstr = (b: Uint8Array, at: number) => {
	let end = at;
	while (end < b.length && b[end]) end++;
	return String.fromCharCode(...b.subarray(at, end));
};

function readBones(b: Uint8Array, v: DataView): Bone[] {
	const n = v.getInt32(156, true), offset = v.getInt32(160, true);
	const bones: Bone[] = [];
	for (let i = 0; i < n; i++) {
		const o = offset + i * 216;
		const f = (k: number) => v.getFloat32(o + k, true);
		bones.push({
			name: cstr(b, o + v.getInt32(o, true)).toLowerCase(),
			parent: v.getInt32(o + 4, true),
			pos: [f(32), f(36), f(40)],
			quat: [f(44), f(48), f(52), f(56)],
			rot: [f(60), f(64), f(68)],
			posScale: [f(72), f(76), f(80)],
			rotScale: [f(84), f(88), f(92)],
			poseToBone: Array.from({length: 12}, (_, k) => f(96 + k * 4)),
		});
	}
	return bones;
}

async function sourceModel(files: GameFiles, bytes: Uint8Array, main: Bone[] | null): Promise<SourceModel> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const bones = readBones(bytes, view);
	const byName = new Map((main ?? bones).map((b, i) => [b.name, i]));
	const toMain = bones.map((b, i) => (main ? byName.get(b.name) ?? -1 : i));
	const nBlocks = view.getInt32(352, true), blockIndex = view.getInt32(356, true);
	const animBlocks = [];
	for (let i = 0; i < nBlocks; i++) animBlocks.push({start: view.getInt32(blockIndex + i * 8, true), end: view.getInt32(blockIndex + i * 8 + 4, true)});
	let ani: Uint8Array | null = null;
	if (nBlocks > 1) {
		const name = cstr(bytes, view.getInt32(348, true)).toLowerCase().replace(/\\/g, '/');
		if (name) ani = await files.read(name);
	}
	return {bytes, view, bones, toMain, animBlocks, ani};
}

function readSequences(src: SourceModel): Sequence[] {
	const v = src.view;
	const nSeq = v.getInt32(188, true), seqOffset = v.getInt32(192, true);
	const nAnim = v.getInt32(180, true), animOffset = v.getInt32(184, true);
	const desc = (i: number): AnimDesc | null => {
		if (i < 0 || i >= nAnim) return null;
		const o = animOffset + i * 100;
		return {
			src, offset: o,
			fps: v.getFloat32(o + 8, true),
			flags: v.getInt32(o + 12, true),
			frames: v.getInt32(o + 16, true),
			animBlock: v.getInt32(o + 52, true),
			animIndex: v.getInt32(o + 56, true),
			sectionIndex: v.getInt32(o + 80, true),
			sectionFrames: v.getInt32(o + 84, true),
		};
	};
	const out: Sequence[] = [];
	for (let i = 0; i < nSeq; i++) {
		const o = seqOffset + i * 212;
		const animIndexIndex = v.getInt32(o + 60, true);
		out.push({
			label: cstr(src.bytes, o + v.getInt32(o + 4, true)).toLowerCase(),
			looping: (v.getInt32(o + 12, true) & STUDIO_LOOPING) !== 0,
			anim: desc(v.getInt16(o + animIndexIndex, true)),
		});
	}
	return out;
}

export async function loadSkeleton(files: GameFiles, mdl: Uint8Array): Promise<Skeleton> {
	const main = await sourceModel(files, mdl, null);
	const sequences = readSequences(main);
	// included models add their sequences (by label, the model's own first)
	const v = main.view;
	const nInc = v.getInt32(336, true), incOffset = v.getInt32(340, true);
	const labels = new Set(sequences.map(s => s.label));
	for (let i = 0; i < nInc; i++) {
		const o = incOffset + i * 8;
		const name = cstr(mdl, o + v.getInt32(o + 4, true)).toLowerCase().replace(/\\/g, '/');
		const bytes = name ? await files.read(name) : null;
		if (!bytes) continue;
		const inc = await sourceModel(files, bytes, main.bones);
		for (const s of readSequences(inc)) {
			if (labels.has(s.label)) continue;
			labels.add(s.label);
			sequences.push(s);
		}
	}
	return {bones: main.bones, sequences};
}

// ---- sampling ----

function half(h: number) {
	const e = (h >> 10) & 31, f = h & 1023;
	const v = e === 0 ? f / 1024 * 2 ** -14 : e === 31 ? 65504 : (1 + f / 1024) * 2 ** (e - 15);
	return h & 0x8000 ? -v : v;
}

function quatFromRadianEuler(x: number, y: number, z: number, out: Float32Array, o: number) {
	const sy = Math.sin(z / 2), cy = Math.cos(z / 2);
	const sp = Math.sin(y / 2), cp = Math.cos(y / 2);
	const sr = Math.sin(x / 2), cr = Math.cos(x / 2);
	out[o] = sr * cp * cy - cr * sp * sy;
	out[o + 1] = cr * sp * cy + sr * cp * sy;
	out[o + 2] = cr * cp * sy - sr * sp * cy;
	out[o + 3] = cr * cp * cy + sr * sp * sy;
}

// the value of an RLE-compressed track (mstudioanimvalue_t) at a frame
function animValue(v: DataView, p: number, frame: number): number {
	let k = frame;
	for (let guard = 0; guard < 10000; guard++) {
		const valid = v.getUint8(p), total = v.getUint8(p + 1);
		if (total === 0) return 0;
		if (total > k) return valid > k ? v.getInt16(p + (k + 1) * 2, true) : v.getInt16(p + valid * 2, true);
		k -= total;
		p += (valid + 1) * 2;
	}
	return 0;
}

// one frame of an animation into pos/quat (main model bone order); bones
// without data keep what's there (the reference pose)
function sampleFrame(desc: AnimDesc, frame: number, pos: Float32Array, quat: Float32Array) {
	const src = desc.src;
	let block = desc.animBlock, index = desc.animIndex, local = frame;
	if (desc.sectionFrames > 0) {
		const section = Math.floor(frame / desc.sectionFrames);
		local = frame - section * desc.sectionFrames;
		const so = desc.offset + desc.sectionIndex + section * 8;
		block = src.view.getInt32(so, true);
		index = src.view.getInt32(so + 4, true);
	}
	let v: DataView, p: number;
	if (block === 0) {
		v = src.view;
		p = desc.offset + index;
	} else {
		const b = src.animBlocks[block];
		if (!src.ani || !b) return;
		v = new DataView(src.ani.buffer, src.ani.byteOffset, src.ani.byteLength);
		p = b.start + index;
	}
	if (desc.flags & STUDIO_ALLZEROS) return;
	const delta = (desc.flags & STUDIO_DELTA) !== 0;
	for (let guard = 0; guard < 512 && p + 4 <= v.byteLength; guard++) {
		const srcBone = v.getUint8(p), flags = v.getUint8(p + 1), next = v.getInt16(p + 2, true);
		const bone = src.toMain[srcBone] ?? -1;
		const sb = src.bones[srcBone];
		if (bone >= 0 && sb && !delta) {
			let d = p + 4;
			if (flags & ANIM_RAWROT) {
				const x = v.getUint16(d, true), y = v.getUint16(d + 2, true), zw = v.getUint16(d + 4, true);
				const qx = (x - 32768) / 32768, qy = (y - 32768) / 32768, qz = ((zw & 0x7fff) - 16384) / 16384;
				const qw = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz)) * (zw & 0x8000 ? -1 : 1);
				quat.set([qx, qy, qz, qw], bone * 4);
				d += 6;
			} else if (flags & ANIM_RAWROT2) {
				const lo = v.getUint32(d, true), hi = v.getUint32(d + 4, true);
				const bits = BigInt(lo) | (BigInt(hi) << 32n);
				const part = (s: bigint) => Number((bits >> s) & 0x1fffffn);
				const qx = (part(0n) - 1048576) / 1048576.5, qy = (part(21n) - 1048576) / 1048576.5, qz = (part(42n) - 1048576) / 1048576.5;
				const qw = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz)) * (hi & 0x80000000 ? -1 : 1);
				quat.set([qx, qy, qz, qw], bone * 4);
				d += 8;
			} else if (flags & ANIM_ANIMROT) {
				const e = [0, 0, 0];
				for (let i = 0; i < 3; i++) {
					const off = v.getInt16(d + i * 2, true);
					e[i] = sb.rot[i] + (off > 0 ? animValue(v, d + off, local) * sb.rotScale[i] : 0);
				}
				quatFromRadianEuler(e[0], e[1], e[2], quat, bone * 4);
				d += 6;
			}
			if (flags & ANIM_RAWPOS) {
				pos.set([half(v.getUint16(d, true)), half(v.getUint16(d + 2, true)), half(v.getUint16(d + 4, true))], bone * 3);
			} else if (flags & ANIM_ANIMPOS) {
				for (let i = 0; i < 3; i++) {
					const off = v.getInt16(d + i * 2, true);
					pos[bone * 3 + i] = sb.pos[i] + (off > 0 ? animValue(v, d + off, local) * sb.posScale[i] : 0);
				}
			}
		}
		if (next === 0) break;
		p += next;
	}
}

export interface Pose {
	pos: Float32Array;   // 3 per bone, parent space
	quat: Float32Array;  // 4 per bone
}

export function referencePose(sk: Skeleton): Pose {
	const pos = new Float32Array(sk.bones.length * 3), quat = new Float32Array(sk.bones.length * 4);
	sk.bones.forEach((b, i) => {
		pos.set(b.pos, i * 3);
		quat.set(b.quat, i * 4);
	});
	return {pos, quat};
}

// frames in a sequence's animation, and its cycles per second at rate 1
export function sequenceRate(sk: Skeleton, seq: number): number {
	const a = sk.sequences[seq]?.anim;
	return a && a.frames > 1 ? a.fps / (a.frames - 1) : 0;
}

export function samplePose(sk: Skeleton, seq: number, cycle: number, out: Pose) {
	const ref = (sk.ref ??= referencePose(sk));
	out.pos.set(ref.pos);
	out.quat.set(ref.quat);
	const a = sk.sequences[seq]?.anim;
	if (!a || a.frames < 1) return;
	const f = Math.min(1, Math.max(0, cycle)) * (a.frames - 1);
	const f0 = Math.floor(f), f1 = Math.min(a.frames - 1, f0 + 1), t = f - f0;
	sampleFrame(a, f0, out.pos, out.quat);
	if (t <= 0.001 || f1 === f0) return;
	const next = (sk.scratch ??= referencePose(sk));
	next.pos.set(ref.pos);
	next.quat.set(ref.quat);
	sampleFrame(a, f1, next.pos, next.quat);
	for (let i = 0; i < sk.bones.length; i++) {
		for (let k = 0; k < 3; k++) out.pos[i * 3 + k] += (next.pos[i * 3 + k] - out.pos[i * 3 + k]) * t;
		slerp(out.quat, next.quat, i * 4, t);
	}
}

function slerp(a: Float32Array, b: Float32Array, o: number, t: number) {
	let bx = b[o], by = b[o + 1], bz = b[o + 2], bw = b[o + 3];
	let dot = a[o] * bx + a[o + 1] * by + a[o + 2] * bz + a[o + 3] * bw;
	if (dot < 0) {
		bx = -bx; by = -by; bz = -bz; bw = -bw;
		dot = -dot;
	}
	let s0 = 1 - t, s1 = t;
	if (dot < 0.9995) {
		const th = Math.acos(dot), sin = Math.sin(th);
		s0 = Math.sin((1 - t) * th) / sin;
		s1 = Math.sin(t * th) / sin;
	}
	a[o] = a[o] * s0 + bx * s1;
	a[o + 1] = a[o + 1] * s0 + by * s1;
	a[o + 2] = a[o + 2] * s0 + bz * s1;
	a[o + 3] = a[o + 3] * s0 + bw * s1;
	const l = Math.hypot(a[o], a[o + 1], a[o + 2], a[o + 3]) || 1;
	for (let k = 0; k < 4; k++) a[o + k] /= l;
}
