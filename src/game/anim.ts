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
	// blend grid over up to two pose parameters (e.g. a run's move_x/move_y):
	// blends[j * groupSize[0] + i]
	blends: (AnimDesc | null)[];
	groupSize: [number, number];
	params: [string, string];          // pose parameter names ('' = none)
	paramRange: [[number, number], [number, number]];
	// a delta animation (added onto what's under it, as layers are); post:
	// added on the other side of the base rotation (STUDIO_POST)
	delta: boolean;
	post: boolean;
	weights: Float32Array | null;      // per (main model) bone; null = all 1
	autolayers: string[];              // sequences layered on top (by label)
}

interface SourceModel {
	bytes: Uint8Array;
	view: DataView;
	bones: Bone[];
	toMain: number[];           // source bone -> main model bone (-1 if none)
	animBlocks: {start: number; end: number}[];
	ani: Uint8Array | null;     // the .ani file, for anim blocks
}

// a named point on a bone that other entities can be attached to
export interface Attachment {
	name: string;
	bone: number;
	local: number[];  // 3x4, row major (attachment -> bone space)
}

export interface Skeleton {
	bones: Bone[];
	sequences: Sequence[];
	attachments: Attachment[];
	ref?: Pose;      // reference pose, made on first use
}

const STUDIO_LOOPING = 0x1;
const STUDIO_DELTA = 0x4;
const STUDIO_POST = 0x10;
const STUDIO_ALLZEROS = 0x20;
const STUDIO_FRAMEANIM = 0x40;  // stored frame by frame (per-bone flags) instead of RLE per bone
// frame-anim per-bone flags
const FRAME_CONST_POS = 0x01, FRAME_CONST_ROT = 0x02, FRAME_ANIM_POS = 0x04, FRAME_ANIM_ROT = 0x08;
const FRAME_ANIM_POS2 = 0x10, FRAME_CONST_POS2 = 0x20, FRAME_CONST_ROT2 = 0x40, FRAME_ANIM_ROT2 = 0x80;
const ANIM_RAWPOS = 0x1, ANIM_RAWROT = 0x2, ANIM_ANIMPOS = 0x4, ANIM_ANIMROT = 0x8, ANIM_DELTA = 0x10, ANIM_RAWROT2 = 0x20;

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
	// pose parameters (mstudioposeparamdesc_t, 20 bytes)
	const nPose = v.getInt32(300, true), poseOffset = v.getInt32(304, true);
	const poseName = (i: number) => (i >= 0 && i < nPose ? cstr(src.bytes, poseOffset + i * 20 + v.getInt32(poseOffset + i * 20, true)).toLowerCase() : '');
	const out: Sequence[] = [];
	for (let i = 0; i < nSeq; i++) {
		const o = seqOffset + i * 212;
		const animIndexIndex = v.getInt32(o + 60, true);
		const groupSize: [number, number] = [Math.max(1, v.getInt32(o + 68, true)), Math.max(1, v.getInt32(o + 72, true))];
		const blends: (AnimDesc | null)[] = [];
		for (let k = 0; k < groupSize[0] * groupSize[1] && k < 64; k++) blends.push(desc(v.getInt16(o + animIndexIndex + k * 2, true)));
		const flags = v.getInt32(o + 12, true);
		// auto-layers (mstudioautolayer_t, 24 bytes): sequences of this model
		const autolayers: string[] = [];
		const nLayers = v.getInt32(o + 148, true), layerOffset = v.getInt32(o + 152, true);
		for (let k = 0; k < nLayers && k < 8; k++) {
			const l = v.getInt16(o + layerOffset + k * 24, true);
			if (l >= 0 && l < nSeq) autolayers.push(cstr(src.bytes, seqOffset + l * 212 + v.getInt32(seqOffset + l * 212 + 4, true)).toLowerCase());
		}
		// per-bone weights, onto the main model's bones
		const weightOffset = v.getInt32(o + 156, true);
		let weights: Float32Array | null = null;
		if (weightOffset) {
			for (let b = 0; b < src.bones.length; b++) {
				const w = v.getFloat32(o + weightOffset + b * 4, true);
				const m = src.toMain[b];
				if (w === 1 || m < 0) continue;
				weights ??= new Float32Array(Math.max(...src.toMain) + 1).fill(1);
				weights[m] = w;
			}
		}
		out.push({
			label: cstr(src.bytes, o + v.getInt32(o + 4, true)).toLowerCase(),
			looping: (flags & STUDIO_LOOPING) !== 0,
			delta: (flags & STUDIO_DELTA) !== 0,
			post: (flags & STUDIO_POST) !== 0,
			weights, autolayers,
			anim: blends[0] ?? null,
			blends, groupSize,
			params: [poseName(v.getInt32(o + 76, true)), poseName(v.getInt32(o + 80, true))],
			paramRange: [[v.getFloat32(o + 84, true), v.getFloat32(o + 92, true)], [v.getFloat32(o + 88, true), v.getFloat32(o + 96, true)]],
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
	// attachments (mstudioattachment_t, 92 bytes)
	const attachments: Attachment[] = [];
	const nAtt = v.getInt32(240, true), attOffset = v.getInt32(244, true);
	for (let i = 0; i < nAtt; i++) {
		const o = attOffset + i * 92;
		attachments.push({
			name: cstr(mdl, o + v.getInt32(o, true)),
			bone: v.getInt32(o + 8, true),
			local: Array.from({length: 12}, (_, k) => v.getFloat32(o + 12 + k * 4, true)),
		});
	}
	return {bones: main.bones, sequences, attachments};
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
// Quaternion48: x, y in 16 bits, z in 15, w's sign in the top bit
function quat48(v: DataView, d: number, out: Float32Array, o: number) {
	const x = v.getUint16(d, true), y = v.getUint16(d + 2, true), zw = v.getUint16(d + 4, true);
	const qx = (x - 32768) / 32768, qy = (y - 32768) / 32768, qz = ((zw & 0x7fff) - 16384) / 16384;
	out[o] = qx;
	out[o + 1] = qy;
	out[o + 2] = qz;
	out[o + 3] = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz)) * (zw & 0x8000 ? -1 : 1);
}

// Quaternion48S: the three smallest components in 15 bits each, which one
// was dropped in two spare bits, the dropped one's sign in the third
function quat48s(v: DataView, d: number, out: Float32Array, o: number) {
	const w0 = v.getUint16(d, true), w1 = v.getUint16(d + 2, true), w2 = v.getUint16(d + 4, true);
	const a = w0 & 0x7fff, b = w1 & 0x7fff, c = w2 & 0x7fff;
	const ia = ((w1 >> 15) & 1) + ((w0 >> 15) & 1) * 2;
	const q = [0, 0, 0, 0];
	q[ia] = (a - 16384) / 23168;
	q[(ia + 1) % 4] = (b - 16384) / 23168;
	q[(ia + 2) % 4] = (c - 16384) / 23168;
	const id = (ia + 3) % 4;
	q[id] = Math.sqrt(Math.max(0, 1 - q[ia] * q[ia] - q[(ia + 1) % 4] ** 2 - q[(ia + 2) % 4] ** 2)) * (w2 & 0x8000 ? -1 : 1);
	out[o] = q[0];
	out[o + 1] = q[1];
	out[o + 2] = q[2];
	out[o + 3] = q[3];
}

// a frame of a frame-anim: a 24-byte header (constants offset, frame data
// offset, frame length), a flags byte per bone, then per bone the rotation
// and the position, each either in the shared constants or in the frame
function sampleFrameAnim(src: SourceModel, v: DataView, p: number, frame: number, pos: Float32Array, quat: Float32Array) {
	if (p + 24 > v.byteLength) return;
	let c = p + v.getInt32(p, true);
	let d = p + v.getInt32(p + 4, true) + frame * v.getInt32(p + 8, true);
	for (let srcBone = 0; srcBone < src.bones.length; srcBone++) {
		const flags = v.getUint8(p + 24 + srcBone);
		const bone = src.toMain[srcBone] ?? -1;
		const q = new Float32Array(4);
		let hasQ = true;
		if (flags & FRAME_ANIM_ROT) {
			quat48(v, d, q, 0);
			d += 6;
		} else if (flags & FRAME_ANIM_ROT2) {
			quat48s(v, d, q, 0);
			d += 6;
		} else if (flags & FRAME_CONST_ROT) {
			quat48(v, c, q, 0);
			c += 6;
		} else if (flags & FRAME_CONST_ROT2) {
			quat48s(v, c, q, 0);
			c += 6;
		} else hasQ = false;
		let pp: number[] | null = null;
		if (flags & FRAME_ANIM_POS) {
			pp = [half(v.getUint16(d, true)), half(v.getUint16(d + 2, true)), half(v.getUint16(d + 4, true))];
			d += 6;
		} else if (flags & FRAME_CONST_POS) {
			pp = [half(v.getUint16(c, true)), half(v.getUint16(c + 2, true)), half(v.getUint16(c + 4, true))];
			c += 6;
		} else if (flags & FRAME_ANIM_POS2) {
			pp = [v.getFloat32(d, true), v.getFloat32(d + 4, true), v.getFloat32(d + 8, true)];
			d += 12;
		} else if (flags & FRAME_CONST_POS2) {
			pp = [v.getFloat32(c, true), v.getFloat32(c + 4, true), v.getFloat32(c + 8, true)];
			c += 12;
		}
		if (bone < 0) continue;
		if (hasQ) quat.set(q, bone * 4);
		if (pp) pos.set(pp, bone * 3);
	}
}

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
	if (desc.flags & STUDIO_FRAMEANIM) {
		if (!(desc.flags & STUDIO_DELTA)) sampleFrameAnim(src, v, p, local, pos, quat);
		return;
	}
	for (let guard = 0; guard < 512 && p + 4 <= v.byteLength; guard++) {
		const srcBone = v.getUint8(p), flags = v.getUint8(p + 1), next = v.getInt16(p + 2, true);
		const bone = src.toMain[srcBone] ?? -1;
		const sb = src.bones[srcBone];
		if (bone >= 0 && sb) {
			// delta bones are stored without the bone's own rotation/position
			const base = flags & ANIM_DELTA ? 0 : 1;
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
					e[i] = sb.rot[i] * base + (off > 0 ? animValue(v, d + off, local) * sb.rotScale[i] : 0);
				}
				quatFromRadianEuler(e[0], e[1], e[2], quat, bone * 4);
				d += 6;
			}
			if (flags & ANIM_RAWPOS) {
				pos.set([half(v.getUint16(d, true)), half(v.getUint16(d + 2, true)), half(v.getUint16(d + 4, true))], bone * 3);
			} else if (flags & ANIM_ANIMPOS) {
				for (let i = 0; i < 3; i++) {
					const off = v.getInt16(d + i * 2, true);
					pos[bone * 3 + i] = sb.pos[i] * base + (off > 0 ? animValue(v, d + off, local) * sb.posScale[i] : 0);
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

// One animation at a cycle into `out`, from the reference pose (or for a
// delta animation, from no change)
function sampleDesc(sk: Skeleton, a: AnimDesc, cycle: number, out: Pose, next: Pose) {
	const ref = (sk.ref ??= referencePose(sk));
	const reset = (p: Pose) => {
		if (a.flags & STUDIO_DELTA) {
			p.pos.fill(0);
			for (let i = 0; i < sk.bones.length; i++) p.quat.set(IDENTITY_Q, i * 4);
		} else {
			p.pos.set(ref.pos);
			p.quat.set(ref.quat);
		}
	};
	reset(out);
	if (a.frames < 1) return;
	const f = Math.min(1, Math.max(0, cycle)) * (a.frames - 1);
	const f0 = Math.floor(f), f1 = Math.min(a.frames - 1, f0 + 1), t = f - f0;
	sampleFrame(a, f0, out.pos, out.quat);
	if (t <= 0.001 || f1 === f0) return;
	reset(next);
	sampleFrame(a, f1, next.pos, next.quat);
	blendPose(out, next, t, sk.bones.length);
}
const IDENTITY_Q = [0, 0, 0, 1];

function blendPose(a: Pose, b: Pose, t: number, n: number) {
	for (let i = 0; i < n; i++) {
		for (let k = 0; k < 3; k++) a.pos[i * 3 + k] += (b.pos[i * 3 + k] - a.pos[i * 3 + k]) * t;
		slerp(a.quat, b.quat, i * 4, t);
	}
}

// scratch poses, per skeleton (sampling isn't re-entrant)
function scratch(sk: Skeleton, i: number): Pose {
	const s = ((sk as Skeleton & {pool?: Pose[]}).pool ??= []);
	return (s[i] ??= referencePose(sk));
}

// A sequence's own pose (its blend grid interpolated at the pose
// parameters, as the engine's local pose parameters do) into `out`;
// scratch poses from `depth` up are used
function sampleSequence(sk: Skeleton, s: Sequence, cycle: number, out: Pose, params: Record<string, number> | undefined, depth: number) {
	const cell = (k: 0 | 1): [number, number] => {
		const n = s.groupSize[k], name = s.params[k];
		if (n < 2 || !name) return [0, 0];
		// (pose parameters not given are 0, as the engine starts them)
		const [lo, hi] = s.paramRange[k], value = params?.[name] ?? 0;
		const x = Math.min(1, Math.max(0, hi === lo ? 0 : (value - lo) / (hi - lo))) * (n - 1);
		const i = Math.min(n - 2, Math.floor(x));
		return [i, x - i];
	};
	const [i0, t0] = cell(0), [i1, t1] = cell(1);
	const at = (x: number, y: number) => s.blends[(i1 + y) * s.groupSize[0] + i0 + x] ?? s.anim;
	const next = scratch(sk, depth), b = scratch(sk, depth + 1), c = scratch(sk, depth + 2);
	const a00 = at(0, 0);
	if (!a00) return;
	sampleDesc(sk, a00, cycle, out, next);
	const n = sk.bones.length;
	if (t0 > 0.001) {
		const a10 = at(1, 0);
		if (a10) {
			sampleDesc(sk, a10, cycle, b, next);
			blendPose(out, b, t0, n);
		}
	}
	if (t1 > 0.001) {
		const a01 = at(0, 1);
		if (!a01) return;
		sampleDesc(sk, a01, cycle, b, next);
		if (t0 > 0.001) {
			const a11 = at(1, 1);
			if (a11) {
				sampleDesc(sk, a11, cycle, c, next);
				blendPose(b, c, t0, n);
			}
		}
		blendPose(out, b, t1, n);
	}
}

// A delta pose added onto `out` (Studio_SlerpBones for delta sequences):
// rotations multiplied in (after the base for STUDIO_POST, before it
// otherwise), positions added, each scaled by the bone's weight
function addDelta(out: Pose, d: Pose, s: Sequence, weight: number, n: number) {
	for (let i = 0; i < n; i++) {
		const w = weight * (s.weights?.[i] ?? 1);
		if (w <= 0) continue;
		const o = i * 4;
		const q = [d.quat[o], d.quat[o + 1], d.quat[o + 2], d.quat[o + 3]];
		if (w < 1) {
			// the rotation scaled (slerp from no rotation)
			const id = new Float32Array(IDENTITY_Q), qq = new Float32Array(q);
			slerp(id, qq, 0, w);
			q.splice(0, 4, id[0], id[1], id[2], id[3]);
		}
		const b = [out.quat[o], out.quat[o + 1], out.quat[o + 2], out.quat[o + 3]];
		const [p, r] = s.post ? [b, q] : [q, b];
		// p * r, with r flipped to p's hemisphere as the engine does
		if (p[0] * r[0] + p[1] * r[1] + p[2] * r[2] + p[3] * r[3] < 0) for (let k = 0; k < 4; k++) r[k] = -r[k];
		out.quat[o] = p[0] * r[3] + p[1] * r[2] - p[2] * r[1] + p[3] * r[0];
		out.quat[o + 1] = -p[0] * r[2] + p[1] * r[3] + p[2] * r[0] + p[3] * r[1];
		out.quat[o + 2] = p[0] * r[1] - p[1] * r[0] + p[2] * r[3] + p[3] * r[2];
		out.quat[o + 3] = -p[0] * r[0] - p[1] * r[1] - p[2] * r[2] + p[3] * r[3];
		for (let k = 0; k < 3; k++) out.pos[i * 3 + k] += d.pos[i * 3 + k] * w;
	}
}

// A sequence's pose with its auto-layers (e.g. an aim matrix over a run)
export function samplePose(sk: Skeleton, seq: number, cycle: number, out: Pose, params?: Record<string, number>) {
	const ref = (sk.ref ??= referencePose(sk));
	const s = sk.sequences[seq];
	if (!s) {
		out.pos.set(ref.pos);
		out.quat.set(ref.quat);
		return;
	}
	sampleSequence(sk, s, cycle, out, params, 0);
	if (!s.autolayers.length) return;
	const labels = ((sk as Skeleton & {labelIndex?: Map<string, number>}).labelIndex ??= new Map(sk.sequences.map((q, i) => [q.label, i])));
	const layer = scratch(sk, 3);
	for (const name of s.autolayers) {
		const l = sk.sequences[labels.get(name) ?? -1];
		if (!l || l === s) continue;
		sampleSequence(sk, l, cycle, layer, params, 4);
		if (l.delta) addDelta(out, layer, l, 1, sk.bones.length);
		else {
			// a full layer replaces what's under it, by bone weight
			for (let i = 0; i < sk.bones.length; i++) {
				const w = l.weights?.[i] ?? 1;
				if (w <= 0) continue;
				for (let k = 0; k < 3; k++) out.pos[i * 3 + k] += (layer.pos[i * 3 + k] - out.pos[i * 3 + k]) * w;
				slerp(out.quat, layer.quat, i * 4, w);
			}
		}
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
