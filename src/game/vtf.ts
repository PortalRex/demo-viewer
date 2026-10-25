// Valve texture files (.vtf, 7.0-7.5): one mip level of the first frame,
// either as raw DXT blocks (for GPUs that take them) or decoded to RGBA8.

export const VtfFormat = {
	RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, RGB565: 4, I8: 5, IA88: 6, A8: 8, RGB888_BLUESCREEN: 9,
	BGR888_BLUESCREEN: 10, ARGB8888: 11, BGRA8888: 12, DXT1: 13, DXT3: 14, DXT5: 15, BGRX8888: 16, BGR565: 17,
	BGRX5551: 18, BGRA4444: 19, DXT1_ONEBITALPHA: 20, BGRA5551: 21, UV88: 22, RGBA16161616F: 24, RGBA16161616: 25,
} as const;

export interface VtfImage {
	width: number;
	height: number;
	format: number;
	data: Uint8Array;  // the level's bytes in `format`
	hasAlpha: boolean;
}

function bytesFor(format: number, w: number, h: number): number {
	const F = VtfFormat;
	switch (format) {
	case F.DXT1: case F.DXT1_ONEBITALPHA: return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * 8;
	case F.DXT3: case F.DXT5: return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * 16;
	case F.RGBA8888: case F.ABGR8888: case F.ARGB8888: case F.BGRA8888: case F.BGRX8888: return w * h * 4;
	case F.RGB888: case F.BGR888: case F.RGB888_BLUESCREEN: case F.BGR888_BLUESCREEN: return w * h * 3;
	case F.RGB565: case F.BGR565: case F.IA88: case F.BGRX5551: case F.BGRA4444: case F.BGRA5551: case F.UV88: return w * h * 2;
	case F.I8: case F.A8: return w * h;
	case F.RGBA16161616F: case F.RGBA16161616: return w * h * 8;
	default: return -1;
	}
}

// `maxSize`: the largest level to take (smaller levels load and draw faster)
export function readVtf(bytes: Uint8Array, maxSize = 1024): VtfImage | null {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint32(0, true) !== 0x00465456) return null;  // "VTF\0"
	const minor = v.getUint32(8, true);
	const headerSize = v.getUint32(12, true);
	const width = v.getUint16(16, true), height = v.getUint16(18, true);
	const flags = v.getUint32(20, true);
	const frames = v.getUint16(24, true);
	const format = v.getInt32(52, true);
	const mipCount = v.getUint8(56);
	const lowFormat = v.getInt32(57, true);
	const lowW = v.getUint8(61), lowH = v.getUint8(62);
	const depth = minor >= 2 ? Math.max(1, v.getUint16(63, true)) : 1;
	const faces = flags & 0x4000 ? (minor < 5 ? 7 : 6) : 1;  // environment maps
	if (bytesFor(format, 1, 1) < 0) return null;

	let dataStart: number;
	if (minor >= 3) {
		const numResources = v.getUint32(68, true);
		dataStart = -1;
		for (let i = 0; i < numResources; i++) {
			const o = 80 + i * 8;
			const tag = v.getUint32(o, true) & 0xffffff;
			if (tag === 0x30) dataStart = v.getUint32(o + 4, true);
		}
		if (dataStart < 0) return null;
	} else {
		dataStart = headerSize + (lowFormat >= 0 ? bytesFor(lowFormat, lowW, lowH) : 0);
	}

	// levels are stored smallest first; each holds every frame, face and slice
	let level = 0;
	while (level < mipCount - 1 && Math.max(width >> level, height >> level) > maxSize) level++;
	let offset = dataStart;
	for (let m = mipCount - 1; m > level; m--) {
		offset += bytesFor(format, Math.max(1, width >> m), Math.max(1, height >> m)) * frames * faces * Math.max(1, depth >> m);
	}
	const w = Math.max(1, width >> level), h = Math.max(1, height >> level);
	const size = bytesFor(format, w, h);
	if (offset + size > bytes.length) return null;
	const F = VtfFormat;
	const hasAlpha = [F.DXT3, F.DXT5, F.DXT1_ONEBITALPHA, F.RGBA8888, F.ABGR8888, F.ARGB8888, F.BGRA8888, F.IA88, F.A8, F.BGRA4444, F.BGRA5551].includes(format as never)
		&& (flags & (0x1000 | 0x2000)) !== 0;  // ONEBITALPHA | EIGHTBITALPHA
	return {width: w, height: h, format, data: bytes.subarray(offset, offset + size), hasAlpha};
}

// an environment map's six faces (right, left, back, front, up, down: +x
// -x +y -y +z -z in the world) at the largest level up to `maxSize`
export function readVtfCube(bytes: Uint8Array, maxSize = 256): VtfImage[] | null {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint32(0, true) !== 0x00465456) return null;
	const minor = v.getUint32(8, true);
	const headerSize = v.getUint32(12, true);
	const width = v.getUint16(16, true), height = v.getUint16(18, true);
	const flags = v.getUint32(20, true);
	const frames = v.getUint16(24, true);
	const format = v.getInt32(52, true);
	const mipCount = v.getUint8(56);
	const lowFormat = v.getInt32(57, true);
	const lowW = v.getUint8(61), lowH = v.getUint8(62);
	if (!(flags & 0x4000) || bytesFor(format, 1, 1) < 0) return null;
	const faces = minor < 5 ? 7 : 6;
	let dataStart = -1;
	if (minor >= 3) {
		const numResources = v.getUint32(68, true);
		for (let i = 0; i < numResources; i++) {
			const o = 80 + i * 8;
			if ((v.getUint32(o, true) & 0xffffff) === 0x30) dataStart = v.getUint32(o + 4, true);
		}
		if (dataStart < 0) return null;
	} else {
		dataStart = headerSize + (lowFormat >= 0 ? bytesFor(lowFormat, lowW, lowH) : 0);
	}
	let level = 0;
	while (level < mipCount - 1 && Math.max(width >> level, height >> level) > maxSize) level++;
	let offset = dataStart;
	for (let m = mipCount - 1; m > level; m--) offset += bytesFor(format, Math.max(1, width >> m), Math.max(1, height >> m)) * frames * faces;
	const w = Math.max(1, width >> level), h = Math.max(1, height >> level);
	const size = bytesFor(format, w, h);
	if (offset + size * 6 > bytes.length) return null;
	return [0, 1, 2, 3, 4, 5].map(f => ({width: w, height: h, format, data: bytes.subarray(offset + f * size, offset + (f + 1) * size), hasAlpha: false}));
}

// ---- decoding to RGBA8 ----

function rgb565(c: number): [number, number, number] {
	return [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
}

function decodeDxt(img: VtfImage, out: Uint8Array) {
	const {width: w, height: h, data, format} = img;
	const dxt1 = format === VtfFormat.DXT1 || format === VtfFormat.DXT1_ONEBITALPHA;
	const blockSize = dxt1 ? 8 : 16;
	const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
	const palette = new Uint8Array(16);
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++) {
			const b = (by * bw + bx) * blockSize;
			const colorOff = dxt1 ? b : b + 8;
			const c0 = data[colorOff] | (data[colorOff + 1] << 8), c1 = data[colorOff + 2] | (data[colorOff + 3] << 8);
			const p0 = rgb565(c0), p1 = rgb565(c1);
			const four = !dxt1 || c0 > c1;
			for (let i = 0; i < 3; i++) {
				palette[i] = p0[i];
				palette[4 + i] = p1[i];
				palette[8 + i] = four ? (2 * p0[i] + p1[i]) / 3 : (p0[i] + p1[i]) / 2;
				palette[12 + i] = four ? (p0[i] + 2 * p1[i]) / 3 : 0;
			}
			palette[3] = palette[7] = palette[11] = 255;
			palette[15] = four ? 255 : 0;
			// DXT5 alpha palette
			const a = new Uint8Array(8);
			if (format === VtfFormat.DXT5) {
				a[0] = data[b];
				a[1] = data[b + 1];
				for (let i = 2; i < 8; i++) a[i] = a[0] > a[1] ? ((8 - i) * a[0] + (i - 1) * a[1]) / 7 : i < 6 ? ((6 - i) * a[0] + (i - 1) * a[1]) / 5 : i === 6 ? 0 : 255;
			}
			const bits = data[colorOff + 4] | (data[colorOff + 5] << 8) | (data[colorOff + 6] << 16) | (data[colorOff + 7] << 24);
			for (let py = 0; py < 4; py++) {
				for (let px = 0; px < 4; px++) {
					const x = bx * 4 + px, y = by * 4 + py;
					if (x >= w || y >= h) continue;
					const i = py * 4 + px;
					const ci = (bits >>> (i * 2)) & 3;
					const o = (y * w + x) * 4;
					out[o] = palette[ci * 4];
					out[o + 1] = palette[ci * 4 + 1];
					out[o + 2] = palette[ci * 4 + 2];
					let alpha = palette[ci * 4 + 3];
					if (format === VtfFormat.DXT3) {
						alpha = ((data[b + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
					} else if (format === VtfFormat.DXT5) {
						const bit = i * 3;
						let idx = 0;
						for (let k = 0; k < 3; k++) idx |= ((data[b + 2 + ((bit + k) >> 3)] >> ((bit + k) & 7)) & 1) << k;
						alpha = a[idx];
					}
					out[o + 3] = alpha;
				}
			}
		}
	}
}

const half = (h: number) => {
	const e = (h >> 10) & 31, f = h & 1023;
	const v = e === 0 ? f / 1024 * 2 ** -14 : e === 31 ? 65504 : (1 + f / 1024) * 2 ** (e - 15);
	return h & 0x8000 ? -v : v;
};

export function decodeVtf(img: VtfImage): Uint8Array {
	const {width: w, height: h, data, format} = img;
	const out = new Uint8Array(w * h * 4);
	const F = VtfFormat;
	const n = w * h;
	switch (format) {
	case F.DXT1: case F.DXT1_ONEBITALPHA: case F.DXT3: case F.DXT5:
		decodeDxt(img, out);
		break;
	case F.RGBA8888:
		out.set(data.subarray(0, n * 4));
		break;
	case F.BGRA8888: case F.BGRX8888:
		for (let i = 0; i < n; i++) {
			out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1]; out[i * 4 + 2] = data[i * 4];
			out[i * 4 + 3] = format === F.BGRX8888 ? 255 : data[i * 4 + 3];
		}
		break;
	case F.ABGR8888:
		for (let i = 0; i < n; i++) {
			out[i * 4] = data[i * 4 + 3]; out[i * 4 + 1] = data[i * 4 + 2]; out[i * 4 + 2] = data[i * 4 + 1]; out[i * 4 + 3] = data[i * 4];
		}
		break;
	case F.ARGB8888:
		for (let i = 0; i < n; i++) {
			out[i * 4] = data[i * 4 + 1]; out[i * 4 + 1] = data[i * 4 + 2]; out[i * 4 + 2] = data[i * 4 + 3]; out[i * 4 + 3] = data[i * 4];
		}
		break;
	case F.RGB888: case F.RGB888_BLUESCREEN:
		for (let i = 0; i < n; i++) {
			out[i * 4] = data[i * 3]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3 + 2]; out[i * 4 + 3] = 255;
		}
		break;
	case F.BGR888: case F.BGR888_BLUESCREEN:
		for (let i = 0; i < n; i++) {
			out[i * 4] = data[i * 3 + 2]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3]; out[i * 4 + 3] = 255;
		}
		break;
	case F.RGB565: case F.BGR565:
		for (let i = 0; i < n; i++) {
			const [r, g, b] = rgb565(data[i * 2] | (data[i * 2 + 1] << 8));
			out[i * 4] = format === F.BGR565 ? b : r; out[i * 4 + 1] = g; out[i * 4 + 2] = format === F.BGR565 ? r : b; out[i * 4 + 3] = 255;
		}
		break;
	case F.I8:
		for (let i = 0; i < n; i++) {
			out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i]; out[i * 4 + 3] = 255;
		}
		break;
	case F.IA88:
		for (let i = 0; i < n; i++) {
			out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i * 2]; out[i * 4 + 3] = data[i * 2 + 1];
		}
		break;
	case F.A8:
		for (let i = 0; i < n; i++) {
			out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255; out[i * 4 + 3] = data[i];
		}
		break;
	case F.BGRA4444:
		for (let i = 0; i < n; i++) {
			const lo = data[i * 2], hi = data[i * 2 + 1];
			out[i * 4 + 2] = (lo & 15) * 17; out[i * 4 + 1] = (lo >> 4) * 17; out[i * 4] = (hi & 15) * 17; out[i * 4 + 3] = (hi >> 4) * 17;
		}
		break;
	case F.BGRX5551: case F.BGRA5551:
		for (let i = 0; i < n; i++) {
			const c = data[i * 2] | (data[i * 2 + 1] << 8);
			out[i * 4 + 2] = (c & 31) * 255 / 31; out[i * 4 + 1] = ((c >> 5) & 31) * 255 / 31; out[i * 4] = ((c >> 10) & 31) * 255 / 31;
			out[i * 4 + 3] = format === F.BGRA5551 && !(c & 0x8000) ? 0 : 255;
		}
		break;
	case F.RGBA16161616F: {
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const srgb = (x: number) => Math.round(255 * Math.min(1, Math.pow(Math.max(0, x), 1 / 2.2)));
		for (let i = 0; i < n; i++) {
			for (let c = 0; c < 3; c++) out[i * 4 + c] = srgb(half(dv.getUint16(i * 8 + c * 2, true)));
			out[i * 4 + 3] = 255;
		}
		break;
	}
	default:
		out.fill(255);
	}
	return out;
}

// ---- sprite sheets (the "sheet" resource particle textures carry) ----

export interface SheetFrame {
	duration: number;
	uv: [number, number, number, number];  // left, top, right, bottom
}

export interface SheetSequence {
	frames: SheetFrame[];
	total: number;   // seconds
	clamp: boolean;  // hold the last frame instead of looping
}

// a texture's sheet: sequences of frames, each a sub-rectangle of the image
export function readVtfSheet(bytes: Uint8Array): SheetSequence[] | null {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint32(0, true) !== 0x00465456 || v.getUint32(8, true) < 3) return null;
	const numResources = v.getUint32(68, true);
	for (let i = 0; i < numResources; i++) {
		const o = 80 + i * 8;
		if ((v.getUint32(o, true) & 0xffffff) !== 0x10) continue;
		let p = v.getUint32(o + 4, true) + 4;  // past the chunk's size
		const version = v.getInt32(p, true);
		const perFrame = version ? 4 : 1;
		const count = v.getInt32(p + 4, true);
		p += 8;
		const out: SheetSequence[] = [];
		for (let s = 0; s < count && p + 16 <= v.byteLength; s++) {
			const index = v.getInt32(p, true), flags = v.getInt32(p + 4, true), frames = v.getInt32(p + 8, true);
			const total = v.getFloat32(p + 12, true);
			p += 16;
			const seq: SheetSequence = {frames: [], total, clamp: (flags & 1) !== 0};
			for (let f = 0; f < frames && p + 4 <= v.byteLength; f++) {
				const duration = v.getFloat32(p, true);
				p += 4;
				const uv: [number, number, number, number] = [v.getFloat32(p, true), v.getFloat32(p + 4, true), v.getFloat32(p + 8, true), v.getFloat32(p + 12, true)];
				p += 16 * perFrame;
				seq.frames.push({duration, uv});
			}
			out[index] = seq;
		}
		return out;
	}
	return null;
}
