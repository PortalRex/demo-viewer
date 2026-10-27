// The worker side of loading a map off the page's thread (see bsppool.ts):
// the BSP read and built here, its files read and its materials looked up by
// asking the page (which has the game's file index), the map sent back with
// its arrays handed over
import {loadBsp} from './bsp.ts';
import type {GameFS} from './gamefs.ts';
import type {MaterialInfo} from './materials.ts';
import {handOver} from './transfer.ts';
import {DataUtils} from 'three';

// a float array as half floats (millions of values: done here, not on the page)
const toHalf = (a: Float32Array) => {
	const out = new Uint16Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = DataUtils.toHalfFloat(a[i]);
	return out;
};

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

// questions to the page, by number, until it answers
let nextAsk = 0;
const asked = new Map<number, (value: unknown) => void>();
function ask<T>(question: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
	const rid = nextAsk++;
	return new Promise(done => {
		asked.set(rid, done as (value: unknown) => void);
		post({...question, rid}, transfer);
	});
}

self.onmessage = async (e: MessageEvent) => {
	const msg = e.data;
	if (msg.type === 'reply') {
		asked.get(msg.rid)?.(msg.value);
		asked.delete(msg.rid);
		return;
	}
	if (msg.type !== 'load') return;
	const {id, path, name} = msg;
	const fs: GameFS = {
		label: 'page',
		read: (p, offset, length) => ask({type: 'read', id, path: p, offset, length}),
		size: p => ask({type: 'size', id, path: p}),
	};
	try {
		const map = await loadBsp(fs, path, name, {
			materials: (names, pak) => {
				const copy = pak ? pak.slice() : null;
				return ask<Map<string, MaterialInfo>>({type: 'materials', id, names, pak: copy}, copy ? [copy.buffer] : []);
			},
		});
		if (map.lightmap) {
			map.lightmap.half = toHalf(map.lightmap.data);
			map.lightmap.bumpHalf = map.lightmap.bump.map(toHalf);
		}
		const out = handOver(map);
		post({type: 'done', id, map: out.value}, out.transfer);
	} catch (err) {
		post({type: 'error', id, message: (err as Error).message});
	}
};
