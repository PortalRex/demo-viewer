// The game's files kept in the browser (IndexedDB), so a visitor picks their
// Portal 2 folder once rather than on every visit. Browsers can't remember a
// folder under Program Files (Steam's default library: Chromium refuses it),
// and a folder upload (Brave, Firefox) is never remembered. So what the 3D
// view reads from a picked folder is kept, by file and byte range, and later
// visits read it back: a map once seen opens with no folder, and a new one
// asks for it once. Or everything challenge mode needs is kept at once
// (keepEverything). Nothing leaves the visitor's machine.
import {LOOSE_DIRS, type GameFS} from './gamefs.ts';
import {Vpk} from './vpk.ts';

const DB = 'sar-game-cache';
const DATA = 'data';    // `${path}\0${offset}\0${length}` (-1: the whole file) -> bytes
const META = 'meta';    // size:<path>, list:<dir>, map:<name>
const WHOLE = -1;

interface Range { offset: number; length: number; key: string }

const keyOf = (path: string, offset: number, length: number) => `${path}\0${offset}\0${length}`;
const norm = (path: string) => path.toLowerCase().replace(/\\/g, '/');

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((done, fail) => {
		req.onsuccess = () => done(req.result);
		req.onerror = () => fail(req.error);
	});
}

export class GameCache {
	private db: IDBDatabase;
	// what's kept, by file: byte ranges by offset, and the files kept whole
	private ranges = new Map<string, Range[]>();
	// (the longest range kept of each file: how far back a lookup looks)
	private longest = new Map<string, number>();
	private wholes = new Set<string>();
	private maps = new Set<string>();
	// writes go out together (a transaction a few hundred milliseconds)
	private pending: [string, string, unknown][] = [];
	private flushing: Promise<void> | null = null;

	private constructor(db: IDBDatabase) {
		this.db = db;
	}

	private static opening: Promise<GameCache | null> | null = null;
	// the cache (null where there's no IndexedDB: a private window)
	static open(): Promise<GameCache | null> {
		this.opening ??= (async () => {
			try {
				const req = indexedDB.open(DB, 1);
				req.onupgradeneeded = () => {
					req.result.createObjectStore(DATA);
					req.result.createObjectStore(META);
				};
				const cache = new GameCache(await request(req));
				await cache.loadIndex();
				return cache;
			} catch {
				return null;
			}
		})();
		return this.opening;
	}

	private async loadIndex() {
		const tx = this.db.transaction([DATA, META]);
		const [keys, metaKeys] = await Promise.all([
			request(tx.objectStore(DATA).getAllKeys()),
			request(tx.objectStore(META).getAllKeys()),
		]);
		for (const k of keys as string[]) this.index(k);
		for (const r of this.ranges.values()) r.sort((a, b) => a.offset - b.offset);
		for (const k of metaKeys as string[]) if (k.startsWith('map:')) this.maps.add(k.slice(4));
	}

	private index(key: string) {
		const [path, offset, length] = key.split('\0');
		if (Number(length) === WHOLE) this.wholes.add(path);
		else {
			let list = this.ranges.get(path);
			if (!list) this.ranges.set(path, list = []);
			list.push({offset: Number(offset), length: Number(length), key});
			this.longest.set(path, Math.max(this.longest.get(path) ?? 0, Number(length)));
		}
	}

	// anything kept at all (a visit can start with no folder)
	get empty() {
		return !this.wholes.size && !this.ranges.size;
	}

	hasMap(map: string) {
		return this.maps.has(map.toLowerCase());
	}

	markMap(map: string) {
		// (the first kept: the browser asked not to let it go when the disk
		// runs low, as it may with a site's storage otherwise)
		if (!this.maps.size) void navigator.storage?.persist?.().catch(() => false);
		this.maps.add(map.toLowerCase());
		this.queue(META, `map:${map.toLowerCase()}`, true);
	}

	// the bytes kept for this read (a range kept is cut from a larger one, or
	// from the whole file); undefined where they aren't kept
	async get(path: string, offset: number, length?: number): Promise<Uint8Array | undefined> {
		path = norm(path);
		if (this.wholes.has(path)) {
			const all = await this.load(keyOf(path, 0, WHOLE));
			if (all) return length === undefined ? all.subarray(offset) : all.subarray(offset, offset + length);
		}
		if (length === undefined) return undefined;
		const list = this.ranges.get(path);
		if (!list) return undefined;
		// (the last kept range starting at or before the offset, then back from
		// it: ranges overlap, a part read on its own and the whole VPK entry
		// it's in both kept, so the nearest may not cover it where one before
		// does; none further back than the longest kept could reach)
		let lo = 0, hi = list.length - 1, at = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid].offset <= offset) {
				at = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		const longest = this.longest.get(path) ?? 0;
		for (let i = at; i >= 0 && list[i].offset + longest >= offset + length; i--) {
			const r = list[i];
			if (offset + length > r.offset + r.length) continue;
			const bytes = await this.load(r.key);
			if (bytes) return bytes.subarray(offset - r.offset, offset - r.offset + length);
		}
		return undefined;
	}

	private async load(key: string): Promise<Uint8Array | undefined> {
		const queued = this.pending.find(([store, k]) => store === DATA && k === key);
		if (queued) return new Uint8Array(queued[2] as ArrayBuffer);
		try {
			const v = await request(this.db.transaction(DATA).objectStore(DATA).get(key));
			return v ? new Uint8Array(v as ArrayBuffer) : undefined;
		} catch {
			return undefined;
		}
	}

	put(path: string, offset: number, length: number | undefined, bytes: Uint8Array) {
		path = norm(path);
		const key = keyOf(path, offset, length === undefined ? WHOLE : length);
		if (length === undefined) {
			if (offset) return;  // (the rest of a file from an offset: not kept)
			this.wholes.add(path);
		} else {
			if (this.ranges.get(path)?.some(r => r.key === key)) return;
			const list = this.ranges.get(path) ?? [];
			const i = list.findIndex(r => r.offset > offset);
			list.splice(i < 0 ? list.length : i, 0, {offset, length, key});
			this.longest.set(path, Math.max(this.longest.get(path) ?? 0, length));
			this.ranges.set(path, list);
		}
		// (a copy: a view's whole buffer would be stored otherwise)
		this.queue(DATA, key, bytes.slice().buffer);
	}

	async meta<T>(key: string): Promise<T | undefined> {
		const queued = this.pending.find(([store, k]) => store === META && k === key);
		if (queued) return queued[2] as T;
		try {
			return await request(this.db.transaction(META).objectStore(META).get(key)) as T | undefined;
		} catch {
			return undefined;
		}
	}

	setMeta(key: string, value: unknown) {
		this.queue(META, key, value);
	}

	private queue(store: string, key: string, value: unknown) {
		this.pending.push([store, key, value]);
		this.flushing ??= new Promise<void>(r => setTimeout(r, 300)).then(() => this.flush());
	}

	// everything queued written (the keep-everything job waits on it, so its
	// memory doesn't grow with the whole copy)
	async flush() {
		const batch = this.pending;
		this.pending = [];
		this.flushing = null;
		if (!batch.length) return;
		const tx = this.db.transaction([DATA, META], 'readwrite');
		for (const [store, key, value] of batch) tx.objectStore(store).put(value, key);
		await new Promise<void>((done, fail) => {
			tx.oncomplete = () => done();
			tx.onerror = () => fail(tx.error);
			tx.onabort = () => fail(tx.error ?? new Error('the browser stopped keeping the files (out of space?)'));
		});
	}

	// everything kept let go of
	async clear() {
		this.pending = [];
		this.ranges.clear();
		this.longest.clear();
		this.wholes.clear();
		this.maps.clear();
		const tx = this.db.transaction([DATA, META], 'readwrite');
		tx.objectStore(DATA).clear();
		tx.objectStore(META).clear();
		await new Promise<void>(done => (tx.oncomplete = () => done()));
	}
}

// The game's files as kept, with a picked folder behind them (whatever's read
// from it kept too), or with none (what isn't kept reads as missing)
export class CachedFS implements GameFS {
	readonly label = 'kept game files';
	readonly cache: GameCache;
	readonly source: GameFS | null;

	constructor(cache: GameCache, source: GameFS | null) {
		this.cache = cache;
		this.source = source;
	}

	async read(path: string, offset = 0, length?: number): Promise<Uint8Array | null> {
		const kept = await this.cache.get(path, offset, length);
		if (kept) return kept;
		if (!this.source) return null;
		const bytes = await this.source.read(path, offset, length);
		if (bytes) this.cache.put(path, offset, length, bytes);
		return bytes;
	}

	async size(path: string): Promise<number | null> {
		const key = `size:${norm(path)}`;
		const kept = await this.cache.meta<number>(key);
		if (kept !== undefined) return kept < 0 ? null : kept;
		if (!this.source) return null;
		const size = await this.source.size(path);
		this.cache.setMeta(key, size ?? -1);
		return size;
	}

	async list(dir: string): Promise<Set<string> | null> {
		const key = `list:${norm(dir)}`;
		const kept = await this.cache.meta<string[]>(key);
		if (kept) return new Set(kept);
		const listed = await this.source?.list?.(dir) ?? null;
		if (listed) this.cache.setMeta(key, [...listed]);
		return listed;
	}
}

// The game folders the viewer searches, and what in their VPKs it reads (no
// sounds, no movies)
const GAME_DIRS = ['update', 'portal2_dlc2', 'portal2_dlc1', 'portal2'];
const KEPT_FOLDERS = new Set(['materials', 'models', 'particles', 'scripts', 'resource']);
// files read straight from the game folder: the HUD's and signs' fonts, the
// movie decoder's tables
const EXTRA_FILES = ['platform/vgui/fonts/univercb.vfont', 'bin/binkw32.dll'];

export interface KeepPlan {
	bytes: number;
	run: (progress: (done: number) => void, cancelled: () => boolean) => Promise<void>;
}

// Everything challenge mode needs kept at once from a picked folder: its
// maps whole, the VPKs' textures, models, particles and scripts, the loose
// asset files and fonts. Planned first, so its size can be shown
export async function planKeepEverything(fs: CachedFS, maps: string[], mapPath: (map: string) => Promise<string | null>): Promise<KeepPlan> {
	const reads: {path: string; offset: number; length: number | undefined; size: number}[] = [];
	for (const dir of GAME_DIRS) {
		const vpk = await Vpk.open(fs, `${dir}/pak01_dir.vpk`).catch(() => null);
		if (vpk) {
			for (const [path, e] of vpk.entries) {
				if (!e.length || !KEPT_FOLDERS.has(path.split('/')[0])) continue;
				const archive = e.archive === 0x7fff ? null : vpk.dirPath.replace(/_dir\.vpk$/, `_${String(e.archive).padStart(3, '0')}.vpk`);
				// (entries in the directory file itself come with it: it's kept whole)
				if (archive) reads.push({path: archive, offset: e.offset, length: e.length, size: e.length});
			}
		}
		// (loose maps left out: workshop maps and the rest; the challenge mode
		// ones come below)
		for (const p of await fs.list(dir) ?? []) {
			const top = p.split('/')[0];
			if (top === 'maps' || !LOOSE_DIRS.includes(top)) continue;
			const size = await fs.size(`${dir}/${p}`);
			if (size) reads.push({path: `${dir}/${p}`, offset: 0, length: undefined, size});
		}
	}
	for (const map of maps) {
		const path = await mapPath(map);
		const size = path && await fs.size(path);
		if (path && size) reads.push({path, offset: 0, length: undefined, size});
	}
	for (const path of EXTRA_FILES) {
		const size = await fs.size(path);
		if (size) reads.push({path, offset: 0, length: undefined, size});
	}
	return {
		bytes: reads.reduce((n, r) => n + r.size, 0),
		run: async (progress, cancelled) => {
			const persisted = navigator.storage?.persist?.().catch(() => false);
			let done = 0, sinceFlush = 0;
			for (const r of reads) {
				if (cancelled()) break;
				await fs.read(r.path, r.offset, r.length);
				done += r.size;
				sinceFlush += r.size;
				// (written every 64 MB, so what's waiting stays small)
				if (sinceFlush > 64 << 20) {
					await fs.cache.flush();
					sinceFlush = 0;
				}
				progress(done);
			}
			await fs.cache.flush();
			if (!cancelled()) for (const map of maps) fs.cache.markMap(map);
			await fs.cache.flush();
			await persisted;
		},
	};
}
