// Just enough zip to read a BSP's pak file lump (stored or deflated entries).

export class Zip {
	private files = new Map<string, {method: number; offset: number; size: number}>();
	private bytes: Uint8Array;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		// end of central directory: scan back for its signature
		let eocd = -1;
		for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
			if (v.getUint32(i, true) === 0x06054b50) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) return;
		const count = v.getUint16(eocd + 10, true);
		let p = v.getUint32(eocd + 16, true);
		for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
			if (v.getUint32(p, true) !== 0x02014b50) break;
			const method = v.getUint16(p + 10, true);
			const size = v.getUint32(p + 20, true);
			const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
			const local = v.getUint32(p + 42, true);
			const name = String.fromCharCode(...bytes.subarray(p + 46, p + 46 + nameLen)).toLowerCase().replace(/\\/g, '/');
			// data starts after the local header, whose extra field can differ
			const lNameLen = v.getUint16(local + 26, true), lExtraLen = v.getUint16(local + 28, true);
			this.files.set(name, {method, offset: local + 30 + lNameLen + lExtraLen, size});
			p += 46 + nameLen + extraLen + commentLen;
		}
	}

	has(path: string) {
		return this.files.has(path.toLowerCase());
	}

	async read(path: string): Promise<Uint8Array | null> {
		const f = this.files.get(path.toLowerCase());
		if (!f) return null;
		const data = this.bytes.subarray(f.offset, f.offset + f.size);
		if (f.method === 0) return data;
		if (f.method === 8) {
			const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		}
		return null;  // LZMA (method 14) isn't supported
	}
}
