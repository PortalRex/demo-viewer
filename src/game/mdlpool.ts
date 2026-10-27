// Model parsing in a few workers (so a map's models come in without the
// page's thread stopping for each): installed with installModelWorkers,
// after which loadModel parses there
import {setModelParser, type StudioModel} from './mdl.ts';

export function installModelWorkers() {
	if (typeof Worker === 'undefined') return;
	const count = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
	const workers = Array.from({length: count}, () => new Worker(new URL('./mdlworker.ts', import.meta.url), {type: 'module'}));
	const waiting = new Map<number, (m: StudioModel | null) => void>();
	for (const w of workers) w.onmessage = (e: MessageEvent) => {
		const {id, model} = e.data;
		waiting.get(id)?.(model);
		waiting.delete(id);
	};
	let next = 0;
	setModelParser((mdl, vvd, vtx, color, skin, body) => new Promise(done => {
		const id = next++;
		waiting.set(id, done);
		// (copies of just these files' bytes, handed over: a view into a
		// whole archive would send the archive)
		const own = [mdl, vvd, vtx].map(b => b.slice());
		workers[id % count].postMessage({id, mdl: own[0], vvd: own[1], vtx: own[2], color, skin, body}, own.map(b => b.buffer));
	}));
}
