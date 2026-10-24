// Valve pak (VPK) directories, version 1 and 2: an index of files stored in
// numbered archives (pak01_000.vpk, ...) or in the directory file itself.
import type {GameFS} from './gamefs.ts';

export interface VpkEntry {
	archive: number;   // 0x7fff = in the directory file
	offset: number;
	length: number;
	preload: Uint8Array;
}

export class Vpk {
	readonly entries = new Map<string, VpkEntry>();
	readonly fs: GameFS;
	readonly dirPath: string;   // e.g. portal2/pak01_dir.vpk
	private dataStart = 0;      // where in-directory data starts

	constructor(fs: GameFS, dirPath: string) {
		this.fs = fs;
		this.dirPath = dirPath;
	}

	static async open(fs: GameFS, dirPath: string): Promise<Vpk | null> {
		const bytes = await fs.read(dirPath);
		if (!bytes || bytes.length < 12) return null;
		const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (v.getUint32(0, true) !== 0x55aa1234) return null;
		const version = v.getUint32(4, true);
		const treeSize = v.getUint32(8, true);
		const headerSize = version === 2 ? 28 : version === 1 ? 12 : -1;
		if (headerSize < 0) return null;
		const vpk = new Vpk(fs, dirPath);
		vpk.dataStart = headerSize + treeSize;

		let p = headerSize;
		const str = () => {
			let end = p;
			while (bytes[end] !== 0) end++;
			const s = String.fromCharCode(...bytes.subarray(p, end));
			p = end + 1;
			return s;
		};
		const end = headerSize + treeSize;
		while (p < end) {
			const ext = str();
			if (!ext) break;
			for (;;) {
				const dir = str();
				if (!dir) break;
				for (;;) {
					const name = str();
					if (!name) break;
					p += 4;  // crc
					const preloadBytes = v.getUint16(p, true);
					const archive = v.getUint16(p + 2, true);
					const offset = v.getUint32(p + 4, true);
					const length = v.getUint32(p + 8, true);
					p += 14;  // ..., terminator
					const preload = bytes.slice(p, p + preloadBytes);
					p += preloadBytes;
					const path = `${dir === ' ' ? '' : dir + '/'}${name}.${ext}`.toLowerCase();
					vpk.entries.set(path, {archive, offset, length, preload});
				}
			}
		}
		return vpk;
	}

	has(path: string) {
		return this.entries.has(path.toLowerCase());
	}

	async read(path: string): Promise<Uint8Array | null> {
		const e = this.entries.get(path.toLowerCase());
		if (!e) return null;
		if (!e.length) return e.preload;
		const data = e.archive === 0x7fff
			? await this.fs.read(this.dirPath, this.dataStart + e.offset, e.length)
			: await this.fs.read(this.dirPath.replace(/_dir\.vpk$/, `_${String(e.archive).padStart(3, '0')}.vpk`), e.offset, e.length);
		if (!data) return null;
		if (!e.preload.length) return data;
		const out = new Uint8Array(e.preload.length + data.length);
		out.set(e.preload);
		out.set(data, e.preload.length);
		return out;
	}
}
