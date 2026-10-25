// Read access to the viewer's own Portal 2 install. Nothing is uploaded: the
// browser reads the files from the folder the user picks (File System Access
// API), or in development from the dev server's /__game/ route.

export interface GameFS {
	label: string;
	// a byte range of a file relative to the install folder, or null if missing
	read(path: string, offset?: number, length?: number): Promise<Uint8Array | null>;
	size(path: string): Promise<number | null>;
	// the loose files under a game folder's asset folders (LOOSE_DIRS),
	// lower-case and relative to it, when the source can list them
	list?(dir: string): Promise<Set<string> | null>;
}

// the folders loose asset files are looked for in (anything else is probed)
export const LOOSE_DIRS = ['materials', 'models', 'particles', 'scripts', 'maps'];

export class DirectoryFS implements GameFS {
	readonly root: FileSystemDirectoryHandle;
	label: string;

	constructor(root: FileSystemDirectoryHandle) {
		this.root = root;
		this.label = root.name;
	}

	// File objects by path (looking one up walks the folders: many reads hit
	// the same few archives)
	private files = new Map<string, Promise<File | null>>();

	private file(path: string): Promise<File | null> {
		let f = this.files.get(path);
		if (!f) {
			f = this.lookup(path);
			this.files.set(path, f);
		}
		return f;
	}

	private async lookup(path: string): Promise<File | null> {
		const parts = path.split('/').filter(Boolean);
		let dir = this.root;
		try {
			for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
			return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
		} catch {
			return null;
		}
	}

	async read(path: string, offset = 0, length?: number) {
		const f = await this.file(path);
		if (!f) return null;
		const blob = f.slice(offset, length === undefined ? undefined : offset + length);
		return new Uint8Array(await blob.arrayBuffer());
	}

	async size(path: string) {
		return (await this.file(path))?.size ?? null;
	}

	async list(dir: string) {
		const out = new Set<string>();
		const walk = async (h: FileSystemDirectoryHandle, prefix: string) => {
			for await (const [name, e] of (h as unknown as {entries(): AsyncIterable<[string, FileSystemHandle]>}).entries()) {
				const p = prefix + name.toLowerCase();
				if (e.kind === 'directory') await walk(e as FileSystemDirectoryHandle, p + '/');
				else out.add(p);
			}
		};
		try {
			const d = await this.root.getDirectoryHandle(dir);
			for (const sub of LOOSE_DIRS) {
				const s = await d.getDirectoryHandle(sub).catch(() => null);
				if (s) await walk(s, sub + '/');
			}
		} catch {
			return null;
		}
		return out;
	}
}

export class HttpFS implements GameFS {
	readonly base: string;
	label = 'dev server';

	constructor(base: string) {
		this.base = base;
	}

	// small ranges asked for together go out as one request
	private queue: {path: string; offset: number; length: number; done: (b: Uint8Array | null) => void; fail: (e: unknown) => void}[] = [];
	private flushing = false;

	read(path: string, offset = 0, length?: number): Promise<Uint8Array | null> {
		if (length === undefined || length > 4 << 20) return this.readOne(path, offset, length);
		return new Promise((done, fail) => {
			this.queue.push({path, offset, length, done, fail});
			if (!this.flushing) {
				this.flushing = true;
				setTimeout(() => this.flush(), 0);
			}
		});
	}

	private async flush() {
		this.flushing = false;
		const batch = this.queue.splice(0, this.queue.length);
		// (in requests of up to 32 MB)
		for (let i = 0; i < batch.length;) {
			let total = 0, j = i;
			while (j < batch.length && (j === i || total + batch[j].length < 32 << 20)) total += batch[j++].length;
			const part = batch.slice(i, j);
			i = j;
			fetch(`${this.base}__ranges`, {method: 'POST', body: JSON.stringify(part.map(q => [q.path, q.offset, q.length]))})
				.then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`ranges: ${r.status}`))))
				.then(buf => {
					const v = new DataView(buf);
					let o = 0;
					for (const q of part) {
						const n = v.getInt32(o, true);
						o += 4;
						if (n < 0) q.done(null);
						else {
							q.done(new Uint8Array(buf, o, n));
							o += n;
						}
					}
				})
				.catch(e => part.forEach(q => q.fail(e)));
		}
	}

	private async readOne(path: string, offset = 0, length?: number) {
		const headers: HeadersInit = offset || length !== undefined ? {Range: `bytes=${offset}-${length === undefined ? '' : offset + length - 1}`} : {};
		const r = await fetch(this.base + path.split('/').map(encodeURIComponent).join('/'), {headers});
		if (!r.ok || r.status === 204) return null;
		return new Uint8Array(await r.arrayBuffer());
	}

	async size(path: string) {
		const r = await fetch(this.base + path.split('/').map(encodeURIComponent).join('/'), {method: 'HEAD'});
		return r.ok && r.status !== 204 ? Number(r.headers.get('Content-Length')) : null;
	}

	async list(dir: string) {
		const r = await fetch(`${this.base}__list?dir=${encodeURIComponent(dir)}`);
		if (!r.ok || r.status === 204) return null;
		return new Set((await r.json() as string[]).map(p => p.toLowerCase()));
	}
}

// The folder to pick is "Portal 2" (the one with portal2.exe); accept the
// game folder inside it too.
export async function pickGameFolder(): Promise<GameFS | null> {
	const picker = (window as unknown as {showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle>}).showDirectoryPicker;
	if (!picker) throw new Error('This browser can\'t open folders. Use Chrome or Edge for the 3D view.');
	const dir = await picker({id: 'portal2', mode: 'read'});
	return new DirectoryFS(dir);
}

export async function devGameFS(): Promise<GameFS | null> {
	if (!import.meta.env?.DEV) return null;
	const fs = new HttpFS('/__game/');
	return (await fs.size('portal2/gameinfo.txt')) ? fs : null;
}

// Where a map's BSP can be: the run's game folder first, then Portal 2's,
// then maps/ directly (a folder picked one level down, like "portal2").
export function mapPaths(map: string, gameDir: string): string[] {
	const dirs = [...new Set([gameDir, 'portal2_dlc2', 'portal2_dlc1', 'update', 'portal2'].filter(Boolean))];
	return [...dirs.map(d => `${d}/maps/${map}.bsp`), `maps/${map}.bsp`];
}
