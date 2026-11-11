// Read access to Portal 2's files: as the site hosts them (HostedFS), or in
// development the local install through the dev server's /__game/ route.

import {soon} from '../core/later.ts';

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
				soon(() => this.flush());
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

// What earlier versions kept in the browser, deleted: the game files read
// from a picked folder (IndexedDB "sar-game-cache"), the picked folder itself
// ("sar-viewer"), and the small cache under the viewer's old name
// ("sar-run-viewer": core/idbcache.ts keeps it as "demo-viewer" now)
export function forgetKeptGameFiles() {
	try {
		indexedDB.deleteDatabase('sar-game-cache');
		indexedDB.deleteDatabase('sar-viewer');
		indexedDB.deleteDatabase('sar-run-viewer');
	} catch {
		// no IndexedDB (a private window): nothing kept
	}
}

// The game's files as the boards site hosts them (tools/build-assets.ts): an
// index of every path the 3D view reads, each to the hash of its bytes, and
// the files under their hashes (sent gzipped; the browser undoes that). A
// file is fetched whole the first time it's read and kept while it's among
// the most recently read (a map's file is read a piece at a time), up to a
// limit; the browser's own cache keeps them between visits (they never change
// under a hash)
const HOSTED_KEPT = 256 * 2 ** 20;  // bytes of files kept in memory
export class HostedFS implements GameFS {
	readonly label = 'hosted game files';
	readonly base: string;
	private index: Map<string, [string, number]>;
	private kept = new Map<string, Promise<Uint8Array | null>>();
	private keptSizes = new Map<string, number>();
	private keptBytes = 0;

	private constructor(base: string, index: Map<string, [string, number]>) {
		this.base = base;
		this.index = index;
	}

	// the hosted files at `base` (e.g. /game/v1/), or null where there are none
	static async open(base: string): Promise<HostedFS | null> {
		try {
			const r = await fetch(`${base}index.json`);
			if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
			const {files} = await r.json() as {files: Record<string, [string, number]>};
			return new HostedFS(base, new Map(Object.entries(files)));
		} catch {
			return null;
		}
	}

	private file(hash: string, size: number): Promise<Uint8Array | null> {
		let p = this.kept.get(hash);
		if (p) {
			// (most recently read last)
			this.kept.delete(hash);
			this.kept.set(hash, p);
			return p;
		}
		p = fetch(`${this.base}files/${hash.slice(0, 2)}/${hash}`)
			.then(r => (r.ok ? r.arrayBuffer() : null))
			.then(b => (b ? new Uint8Array(b) : null))
			.catch(() => null);
		this.kept.set(hash, p);
		this.keptSizes.set(hash, size);
		this.keptBytes += size;
		// (the least recently read let go past the limit; the browser's cache
		// still has them)
		for (const [h] of this.kept) {
			if (this.keptBytes <= HOSTED_KEPT || h === hash) break;
			this.kept.delete(h);
			this.keptBytes -= this.keptSizes.get(h) ?? 0;
			this.keptSizes.delete(h);
		}
		return p;
	}

	private entry(path: string) {
		return this.index.get(path.toLowerCase().replace(/\\/g, '/'));
	}

	async read(path: string, offset = 0, length?: number): Promise<Uint8Array | null> {
		const entry = this.entry(path);
		if (!entry) return null;
		const bytes = await this.file(entry[0], entry[1]);
		if (!bytes) return null;
		return length === undefined && !offset ? bytes : bytes.subarray(offset, length === undefined ? undefined : offset + length);
	}

	async size(path: string): Promise<number | null> {
		return this.entry(path)?.[1] ?? null;
	}

	async list(dir: string): Promise<Set<string>> {
		const base = `${dir.toLowerCase()}/`;
		const out = new Set<string>();
		for (const p of this.index.keys()) {
			if (p.startsWith(base) && LOOSE_DIRS.some(d => p.startsWith(`${base}${d}/`))) out.add(p.slice(base.length));
		}
		return out;
	}
}

// The local install served at /__game/: by the dev server, or, built for the
// boards site (VITE_BOARDS_API), by that site's dev server where it passes
// /__game through to one (DEV_GAME_PROXY). A deployed site has nothing
// there (its pages answer /__game/ with the site): only a listing of the
// game folder's files counts. The desktop app (VITE_DESKTOP) serves the
// install it found there too
export async function devGameFS(): Promise<GameFS | null> {
	if (!import.meta.env?.DEV && !import.meta.env?.VITE_BOARDS_API && !import.meta.env?.VITE_DESKTOP) return null;
	const fs = new HttpFS('/__game/');
	const listed = await fs.list('portal2').catch(() => null);
	return listed?.size ? fs : null;
}

// Where a map's BSP can be: the run's game folder first, then Portal 2's
export function mapPaths(map: string, gameDir: string): string[] {
	const dirs = [...new Set([gameDir, 'portal2_dlc2', 'portal2_dlc1', 'update', 'portal2'].filter(Boolean))];
	return dirs.map(d => `${d}/maps/${map}.bsp`);
}
