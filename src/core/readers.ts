// Little-endian byte and bit readers for demo and proof data.

const utf8 = new TextDecoder('utf-8');

export class ByteReader {
	readonly bytes: Uint8Array;
	readonly view: DataView;
	pos: number;

	constructor(bytes: Uint8Array, pos = 0) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.pos = pos;
	}

	get remaining() {
		return this.bytes.length - this.pos;
	}

	u8() {
		return this.bytes[this.pos++];
	}
	i32() {
		const v = this.view.getInt32(this.pos, true);
		this.pos += 4;
		return v;
	}
	u32() {
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}
	u16() {
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return v;
	}
	f32() {
		const v = this.view.getFloat32(this.pos, true);
		this.pos += 4;
		return v;
	}
	u64() {
		const v = this.view.getBigUint64(this.pos, true);
		this.pos += 8;
		return v;
	}
	bytesN(n: number) {
		const v = this.bytes.subarray(this.pos, this.pos + n);
		this.pos += n;
		return v;
	}
	// LEB128
	varint() {
		let v = 0, shift = 0, c: number;
		do {
			c = this.bytes[this.pos++];
			v += (c & 0x7f) * 2 ** shift;
			shift += 7;
		} while (c & 0x80);
		return v;
	}
	// varint length + bytes
	blob() {
		return this.bytesN(this.varint());
	}
	string() {
		return utf8.decode(this.blob());
	}
	// NUL-terminated
	cstring() {
		let end = this.pos;
		while (end < this.bytes.length && this.bytes[end] !== 0) end++;
		const s = utf8.decode(this.bytes.subarray(this.pos, end));
		this.pos = Math.min(end + 1, this.bytes.length);
		return s;
	}
	// fixed-size, NUL-padded
	fixedString(n: number) {
		const raw = this.bytesN(n);
		const end = raw.indexOf(0);
		return utf8.decode(end < 0 ? raw : raw.subarray(0, end));
	}
}

// Source's bf_read: bits are read from the lowest bit of each byte up.
export class BitReader {
	readonly bytes: Uint8Array;
	readonly end: number;
	pos = 0;

	constructor(bytes: Uint8Array, bitCount = bytes.length * 8) {
		this.bytes = bytes;
		this.end = bitCount;
	}

	get remaining() {
		return this.end - this.pos;
	}

	bit() {
		if (this.pos >= this.end) throw new RangeError('read past the end of the bit buffer');
		const b = (this.bytes[this.pos >> 3] >> (this.pos & 7)) & 1;
		this.pos++;
		return b;
	}

	// up to 32 bits, unsigned
	u(n: number) {
		if (this.pos + n > this.end) throw new RangeError('read past the end of the bit buffer');
		let v = 0;
		for (let i = 0; i < n; i++) {
			v += ((this.bytes[(this.pos + i) >> 3] >> ((this.pos + i) & 7)) & 1) * 2 ** i;
		}
		this.pos += n;
		return v;
	}

	s(n: number) {
		const v = this.u(n);
		return v >= 2 ** (n - 1) ? v - 2 ** n : v;
	}

	f32() {
		const buf = new DataView(new ArrayBuffer(4));
		buf.setUint32(0, this.u(32), true);
		return buf.getFloat32(0, true);
	}
}
