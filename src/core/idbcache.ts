// A small key-value store kept between visits (IndexedDB), for what's slow
// to work out again on every page load. Everything here is best effort: no
// storage (a private window, storage blocked) just means nothing's kept.

const DB = 'sar-run-viewer';
const STORE = 'cache';

let opening: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
	opening ??= new Promise(done => {
		try {
			const req = indexedDB.open(DB, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(STORE);
			req.onsuccess = () => done(req.result);
			req.onerror = () => done(null);
			req.onblocked = () => done(null);
		} catch {
			done(null);
		}
	});
	return opening;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
	const d = await db();
	if (!d) return undefined;
	return new Promise(done => {
		try {
			const req = d.transaction(STORE).objectStore(STORE).get(key);
			req.onsuccess = () => done(req.result as T | undefined);
			req.onerror = () => done(undefined);
		} catch {
			done(undefined);
		}
	});
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
	const d = await db();
	if (!d) return;
	await new Promise<void>(done => {
		try {
			const tx = d.transaction(STORE, 'readwrite');
			tx.objectStore(STORE).put(value, key);
			tx.oncomplete = tx.onerror = tx.onabort = () => done();
		} catch {
			done();
		}
	});
}
