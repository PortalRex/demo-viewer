// Loading a map in a worker (bspworker.ts), so building its geometry,
// lightmaps and visibility doesn't stop the page: the worker asks the page
// for file reads and material lookups; the map comes back with its arrays
// handed over, its visibility and lighting given back their classes
import {loadBsp, type BspMap, type BspOptions} from './bsp.ts';
import type {GameFS} from './gamefs.ts';
import {Visibility} from './vis.ts';
import {AmbientLighting} from './ambient.ts';
import {handOver} from './transfer.ts';

let worker: Worker | null = null;
let nextLoad = 0;
const loading = new Map<number, {fs: GameFS; options: BspOptions; done: (m: BspMap) => void; fail: (e: Error) => void}>();

function start(): Worker {
	const w = new Worker(new URL('./bspworker.ts', import.meta.url), {type: 'module'});
	w.onmessage = async (e: MessageEvent) => {
		const msg = e.data;
		const load = loading.get(msg.id);
		if (!load) return;
		// (file bytes handed over: they're read fresh; material lookups copied,
		// as the page's material cache keeps them)
		const reply = (value: unknown, hand = false) => {
			const out = hand ? handOver(value) : {value, transfer: []};
			w.postMessage({type: 'reply', rid: msg.rid, value: out.value}, out.transfer);
		};
		switch (msg.type) {
		case 'read':
			reply(await load.fs.read(msg.path, msg.offset, msg.length).catch(() => null), true);
			break;
		case 'size':
			reply(await load.fs.size(msg.path).catch(() => null));
			break;
		case 'materials':
			reply(await load.options.materials!(msg.names, msg.pak));
			break;
		case 'done': {
			loading.delete(msg.id);
			const map = msg.map as BspMap;
			// (structured copies lose their classes: their fields are all there)
			if (map.vis) Object.setPrototypeOf(map.vis, Visibility.prototype);
			if (map.ambient) Object.setPrototypeOf(map.ambient, AmbientLighting.prototype);
			load.done(map);
			break;
		}
		case 'error':
			loading.delete(msg.id);
			load.fail(new Error(msg.message));
			break;
		}
	};
	return w;
}

// a map loaded in the worker where there are workers, else here
export function loadBspOffThread(fs: GameFS, path: string, name: string, options: BspOptions = {}): Promise<BspMap> {
	if (typeof Worker === 'undefined') return loadBsp(fs, path, name, options);
	worker ??= start();
	const id = nextLoad++;
	return new Promise((done, fail) => {
		loading.set(id, {fs, options, done, fail});
		worker!.postMessage({type: 'load', id, path, name});
	});
}
