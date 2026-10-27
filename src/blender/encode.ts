// Image files for the Blender bundle, written in the page: PNG (8-bit
// colour), OpenEXR (half floats: light maps, HDR cubemaps and skies) and DDS
// (DXT textures passed through as the game stores them). Cubemaps become
// equirectangular images, the projection Blender's environment textures take.
import * as THREE from 'three';

// zlib (RFC 1950) through the browser's own compressor
async function zlib(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(parts: Uint8Array[]): number {
	let c = 0xffffffff;
	for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// RGBA8, rows top first, as stored (no premultiplying: masks live in alpha)
export async function encodePng(width: number, height: number, rgba: Uint8Array, alpha = true): Promise<Uint8Array> {
	const channels = alpha ? 4 : 3;
	const stride = width * channels + 1;
	const raw = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		raw[y * stride] = 0;  // (no filter)
		const row = y * stride + 1;
		for (let x = 0; x < width; x++) {
			const s = (y * width + x) * 4, d = row + x * channels;
			raw[d] = rgba[s];
			raw[d + 1] = rgba[s + 1];
			raw[d + 2] = rgba[s + 2];
			if (alpha) raw[d + 3] = rgba[s + 3];
		}
	}
	const chunk = (type: string, body: Uint8Array) => {
		const out = new Uint8Array(12 + body.length);
		const v = new DataView(out.buffer);
		v.setUint32(0, body.length);
		const name = new TextEncoder().encode(type);
		out.set(name, 4);
		out.set(body, 8);
		v.setUint32(8 + body.length, crc32([name, body]));
		return out;
	};
	const ihdr = new Uint8Array(13);
	const hv = new DataView(ihdr.buffer);
	hv.setUint32(0, width);
	hv.setUint32(4, height);
	ihdr[8] = 8;
	ihdr[9] = alpha ? 6 : 2;
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', await zlib(raw)),
		chunk('IEND', new Uint8Array(0)),
	];
	return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

// OpenEXR, half floats, ZIP compression (16 scanlines a block), RGB or RGBA.
// `half`: width x height x 4 half floats (RGBA), rows top first.
export async function encodeExr(width: number, height: number, half: Uint16Array, alpha = false): Promise<Uint8Array> {
	const names = alpha ? ['A', 'B', 'G', 'R'] : ['B', 'G', 'R'];  // (stored in name order)
	const offsetOf: Record<string, number> = {R: 0, G: 1, B: 2, A: 3};
	const enc = new TextEncoder();
	const header: number[] = [];
	const bytes = (b: ArrayLike<number>) => {
		for (let i = 0; i < b.length; i++) header.push(b[i]);
	};
	const u32 = (n: number) => bytes(new Uint8Array(new Uint32Array([n]).buffer));
	const i32 = (n: number) => bytes(new Uint8Array(new Int32Array([n]).buffer));
	const f32 = (n: number) => bytes(new Uint8Array(new Float32Array([n]).buffer));
	const str = (s: string) => {
		bytes(enc.encode(s));
		header.push(0);
	};
	const attr = (name: string, type: string, size: number, write: () => void) => {
		str(name);
		str(type);
		u32(size);
		write();
	};
	u32(20000630);
	u32(2);
	attr('channels', 'chlist', names.length * 18 + 1, () => {
		for (const n of names) {
			str(n);
			i32(1);  // HALF
			bytes([0, 0, 0, 0]);
			i32(1);
			i32(1);
		}
		header.push(0);
	});
	attr('compression', 'compression', 1, () => header.push(3));  // ZIP_COMPRESSION
	attr('dataWindow', 'box2i', 16, () => [0, 0, width - 1, height - 1].forEach(i32));
	attr('displayWindow', 'box2i', 16, () => [0, 0, width - 1, height - 1].forEach(i32));
	attr('lineOrder', 'lineOrder', 1, () => header.push(0));
	attr('pixelAspectRatio', 'float', 4, () => f32(1));
	attr('screenWindowCenter', 'v2f', 8, () => {
		f32(0);
		f32(0);
	});
	attr('screenWindowWidth', 'float', 4, () => f32(1));
	header.push(0);

	const LINES = 16;
	const blocks: Uint8Array[] = [];
	const lineBytes = width * names.length * 2;
	for (let y0 = 0; y0 < height; y0 += LINES) {
		const lines = Math.min(LINES, height - y0);
		const raw = new Uint8Array(lineBytes * lines);
		const rv = new DataView(raw.buffer);
		let o = 0;
		for (let y = y0; y < y0 + lines; y++) {
			for (const n of names) {
				const c = offsetOf[n];
				for (let x = 0; x < width; x++) {
					rv.setUint16(o, half[(y * width + x) * 4 + c], true);
					o += 2;
				}
			}
		}
		// (the format's predictor: bytes split into even and odd halves, then
		// each stored as the difference from the one before)
		const t = new Uint8Array(raw.length);
		const halfLen = (raw.length + 1) >> 1;
		for (let i = 0, a = 0, b = halfLen; i < raw.length; i += 2) {
			t[a++] = raw[i];
			if (i + 1 < raw.length) t[b++] = raw[i + 1];
		}
		let p = t[0];
		for (let i = 1; i < t.length; i++) {
			const d = (t[i] - p + 128 + 256) & 255;
			p = t[i];
			t[i] = d;
		}
		const packed = await zlib(t);
		const data = packed.length < raw.length ? packed : raw;
		const block = new Uint8Array(8 + data.length);
		const bv = new DataView(block.buffer);
		bv.setInt32(0, y0, true);
		bv.setInt32(4, data.length, true);
		block.set(data, 8);
		blocks.push(block);
	}
	const head = new Uint8Array(header);
	const table = new Uint8Array(blocks.length * 8);
	const tv = new DataView(table.buffer);
	let at = head.length + table.length;
	blocks.forEach((b, i) => {
		tv.setBigUint64(i * 8, BigInt(at), true);
		at += b.length;
	});
	return concat([head, table, ...blocks]);
}

export const DXT = {DXT1: 'DXT1', DXT3: 'DXT3', DXT5: 'DXT5'} as const;

// A DDS file around DXT blocks: `levels` largest first (each the next mip)
export function encodeDds(width: number, height: number, fourCC: keyof typeof DXT, levels: Uint8Array[]): Uint8Array {
	const head = new Uint8Array(128);
	const v = new DataView(head.buffer);
	head.set([0x44, 0x44, 0x53, 0x20]);  // "DDS "
	v.setUint32(4, 124, true);
	// caps | height | width | pixelformat | linearsize | mipmapcount
	v.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000 | (levels.length > 1 ? 0x20000 : 0), true);
	v.setUint32(12, height, true);
	v.setUint32(16, width, true);
	v.setUint32(20, levels[0].length, true);
	v.setUint32(28, levels.length, true);
	v.setUint32(76, 32, true);  // pixel format size
	v.setUint32(80, 0x4, true);  // DDPF_FOURCC
	head.set(new TextEncoder().encode(fourCC), 84);
	v.setUint32(108, 0x1000 | (levels.length > 1 ? 0x400008 : 0), true);  // texture (| complex | mipmap)
	return concat([head, ...levels]);
}

// A cubemap's faces (+x -x +y -y +z -z, WebGL's order and orientation, each
// RGBA, as half floats or bytes) resampled to an equirectangular RGBA half
// image `width` x width/2, rows top first, laid out as Blender's environment
// texture reads it: u = 0.5 - atan2(y, x) / 2pi, v = 0.5 + asin(z) / pi
export function cubeToEquirect(faces: {width: number; height: number; data: Uint16Array | Uint8Array; scale?: number}[], width: number): Uint16Array {
	const height = width >> 1;
	const out = new Uint16Array(width * height * 4);
	const toFloat = THREE.DataUtils.fromHalfFloat, toHalf = THREE.DataUtils.toHalfFloat;
	const texel = (f: number, s: number, t: number, c: number, out4: number[]) => {
		const face = faces[f];
		// (bilinear, clamped to the face)
		const x = Math.min(face.width - 1, Math.max(0, s * face.width - 0.5)), y = Math.min(face.height - 1, Math.max(0, t * face.height - 0.5));
		const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(face.width - 1, x0 + 1), y1 = Math.min(face.height - 1, y0 + 1);
		const fx = x - x0, fy = y - y0;
		const half = face.data instanceof Uint16Array;
		const read = (xx: number, yy: number) => {
			const v = face.data[(yy * face.width + xx) * 4 + c];
			// (the viewer draws cubes as stored: bytes are linear too)
			return half ? toFloat(v) : v / 255;
		};
		out4[c] = ((read(x0, y0) * (1 - fx) + read(x1, y0) * fx) * (1 - fy) + (read(x0, y1) * (1 - fx) + read(x1, y1) * fx) * fy) * (face.scale ?? 1);
	};
	const px = [0, 0, 0, 0];
	for (let row = 0; row < height; row++) {
		const v = 1 - (row + 0.5) / height;
		const elev = (v - 0.5) * Math.PI;
		for (let col = 0; col < width; col++) {
			const u = (col + 0.5) / width;
			const az = (0.5 - u) * 2 * Math.PI;
			const dx = Math.cos(elev) * Math.cos(az), dy = Math.cos(elev) * Math.sin(az), dz = Math.sin(elev);
			// GL's cube face selection (sc, tc by face, as the spec's table)
			const ax = Math.abs(dx), ay = Math.abs(dy), az2 = Math.abs(dz);
			let f: number, sc: number, tc: number, ma: number;
			if (ax >= ay && ax >= az2) {
				ma = ax;
				if (dx > 0) [f, sc, tc] = [0, -dz, -dy];
				else [f, sc, tc] = [1, dz, -dy];
			} else if (ay >= az2) {
				ma = ay;
				if (dy > 0) [f, sc, tc] = [2, dx, dz];
				else [f, sc, tc] = [3, dx, -dz];
			} else {
				ma = az2;
				if (dz > 0) [f, sc, tc] = [4, dx, -dy];
				else [f, sc, tc] = [5, -dx, -dy];
			}
			const s = (sc / ma + 1) / 2, t = (tc / ma + 1) / 2;
			for (let c = 0; c < 4; c++) texel(f, s, t, c, px);
			const o = (row * width + col) * 4;
			out[o] = toHalf(px[0]);
			out[o + 1] = toHalf(px[1]);
			out[o + 2] = toHalf(px[2]);
			out[o + 3] = toHalf(1);
		}
	}
	return out;
}
