// The game's file system as Source searches it: the current map's pak file,
// then for each game folder (update, DLCs, portal2, or the run's mod) its
// loose files and its VPK.
import {LOOSE_DIRS, type GameFS} from './gamefs.ts';
import {Vpk} from './vpk.ts';
import type {Zip} from './zip.ts';
import {cacheGet, cacheSet} from '../core/idbcache.ts';

export class GameFiles {
	readonly fs: GameFS;
	private dirs: string[] = [];
	private vpks = new Map<string, Vpk | null>();
	private missing = new Set<string>();
	// each folder's loose files, where the file source can list them (no
	// request per lookup then)
	private loose = new Map<string, Set<string> | null>();
	mapPak: Zip | null = null;

	// these files as a map with this pak sees them (everything else, the
	// indexes and what's been found missing, shared)
	withPak(pak: Zip | null): GameFiles {
		const view = Object.create(this) as GameFiles;
		view.mapPak = pak;
		return view;
	}

	constructor(fs: GameFS) {
		this.fs = fs;
	}

	// search order for a run in `gameDir` (portal2, or a mod like portal_stories)
	async init(gameDir: string) {
		// Portal 2's own order (gameinfo.txt); a mod searches its folder first
		const base = ['update', 'portal2_dlc2', 'portal2_dlc1', 'portal2'];
		const dirs = [...new Set([...(gameDir && !base.includes(gameDir) ? [gameDir] : []), ...base])];
		this.dirs = dirs;
		await Promise.all(dirs.map(async d => {
			if (!this.vpks.has(d)) this.vpks.set(d, await Vpk.open(this.fs, `${d}/pak01_dir.vpk`).catch(() => null));
			if (!this.loose.has(d)) this.loose.set(d, await this.listLoose(d));
		}));
	}

	// A game folder's loose files: as listed on an earlier visit, where there
	// was one (walking the folders took the better part of a second), and
	// listed again in the background, the list kept up to date with that
	private async listLoose(dir: string): Promise<Set<string> | null> {
		const fs = this.fs;
		if (!fs.list) return null;
		const key = `loose|${fs.label}|${dir}`;
		const fresh = () => fs.list!(dir).catch(() => null);
		const kept = await cacheGet<string[]>(key);
		if (!kept) {
			const listed = await fresh();
			if (listed) void cacheSet(key, [...listed]);
			return listed;
		}
		void fresh().then(listed => {
			if (!listed) return;
			this.loose.set(dir, listed);
			for (const p of listed) this.missing.delete(`${dir}/${p}`);
			void cacheSet(key, [...listed]);
		});
		return new Set(kept);
	}

	async read(path: string): Promise<Uint8Array | null> {
		path = path.toLowerCase().replace(/\\/g, '/');
		if (this.mapPak?.has(path)) return this.mapPak.read(path);
		for (const d of this.dirs) {
			const vpk = this.vpks.get(d);
			// loose files are only looked for when this folder's VPK doesn't have
			// the file: a request per file otherwise, and loose copies
			// overriding the VPK are rare
			const loose = `${d}/${path}`;
			const listed = this.loose.get(d);
			const known = listed && LOOSE_DIRS.includes(path.split('/')[0]);
			if (known ? listed.has(path) : !this.missing.has(loose) && !vpk?.has(path)) {
				const b = await this.fs.read(loose);
				if (b) return b;
				this.missing.add(loose);
			}
			if (vpk?.has(path)) return vpk.read(path);
		}
		return null;
	}

	// part of a file, found as read() finds it
	async readRange(path: string, start: number, length: number): Promise<Uint8Array | null> {
		path = path.toLowerCase().replace(/\\/g, '/');
		if (this.mapPak?.has(path)) return (await this.mapPak.read(path))?.subarray(start, start + length) ?? null;
		for (const d of this.dirs) {
			const vpk = this.vpks.get(d);
			const loose = `${d}/${path}`;
			const listed = this.loose.get(d);
			const known = listed && LOOSE_DIRS.includes(path.split('/')[0]);
			if (known ? listed.has(path) : !this.missing.has(loose) && !vpk?.has(path)) {
				const b = await this.fs.read(loose, start, length);
				if (b) return b;
				this.missing.add(loose);
			}
			if (vpk?.has(path)) return vpk.readRange(path, start, length);
		}
		return null;
	}

	async text(path: string): Promise<string | null> {
		const b = await this.read(path);
		return b ? new TextDecoder('utf-8').decode(b) : null;
	}
}
