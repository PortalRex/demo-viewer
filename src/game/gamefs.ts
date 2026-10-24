// Read access to the viewer's own Portal 2 install. Nothing is uploaded: the
// browser reads the files from the folder the user picks (File System Access
// API), or in development from the dev server's /__game/ route.

export interface GameFS {
	label: string;
	// a byte range of a file relative to the install folder, or null if missing
	read(path: string, offset?: number, length?: number): Promise<Uint8Array | null>;
	size(path: string): Promise<number | null>;
}

export class DirectoryFS implements GameFS {
	readonly root: FileSystemDirectoryHandle;
	label: string;

	constructor(root: FileSystemDirectoryHandle) {
		this.root = root;
		this.label = root.name;
	}

	private async file(path: string): Promise<File | null> {
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
}

export class HttpFS implements GameFS {
	readonly base: string;
	label = 'dev server';

	constructor(base: string) {
		this.base = base;
	}

	async read(path: string, offset = 0, length?: number) {
		const headers: HeadersInit = offset || length !== undefined ? {Range: `bytes=${offset}-${length === undefined ? '' : offset + length - 1}`} : {};
		const r = await fetch(this.base + path.split('/').map(encodeURIComponent).join('/'), {headers});
		if (!r.ok) return null;
		return new Uint8Array(await r.arrayBuffer());
	}

	async size(path: string) {
		const r = await fetch(this.base + path.split('/').map(encodeURIComponent).join('/'), {method: 'HEAD'});
		return r.ok ? Number(r.headers.get('Content-Length')) : null;
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
