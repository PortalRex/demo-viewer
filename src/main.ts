import {loadRuns} from './core/load.ts';
import {Playback, viewAt, cmdAt} from './player/playback.ts';
import {PathView} from './ui/pathview.ts';
import {Timeline, SpeedGraph} from './ui/charts.ts';
import {Panels, InputDisplay, fmtTime} from './ui/panels.ts';
import {View3D} from './ui/view3d.ts';
import type {CameraMode} from './ui/view3d.ts';
import {decodeEntities} from './net/entities.ts';
import type {EntityTimeline} from './net/entities.ts';
import {loadBsp} from './game/bsp.ts';
import type {BspMap} from './game/bsp.ts';
import {devGameFS, pickGameFolder, mapPaths} from './game/gamefs.ts';
import {GameFiles} from './game/files.ts';
import {Materials} from './game/materials.ts';
import type {MaterialInfo} from './game/materials.ts';
import {Zip} from './game/zip.ts';
import type {GameFS} from './game/gamefs.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const pathView = new PathView($<HTMLCanvasElement>('path'));
const inputs = new InputDisplay($('inputs'));
const panels = new Panels((seg, tick) => seekTo(pb!.globalTick(seg, tick)));

let pb: Playback | null = null;
const timeline = new Timeline($<HTMLCanvasElement>('timeline'), seekTo);
const speedGraph = new SpeedGraph($<HTMLCanvasElement>('speed'), f => {
	const tr = pb?.tracks[currentSeg];
	if (tr) seekTo(tr.start + f * tr.length);
});
let t = 0;           // global tick
let playing = false;
let rate = 1;
let currentSeg = -1;
let lastFrame = 0;
let viewMode: 'top' | 'side' | '3d' = 'top';

// ---- entities and the 3D map ----

const view3d = new View3D($('view3d'));
if (import.meta.env.DEV) (window as unknown as {view3d: View3D}).view3d = view3d;  // for debugging in the console
const entityCache = new Map<number, EntityTimeline | null>();
const mapCache = new Map<string, Promise<BspMap>>();
let gameFS: GameFS | null = null;
let gameFiles: GameFiles | null = null;
let materials: Materials | null = null;
const mapPaks = new Map<string, Zip | null>();
view3d.onLoaded = () => {
	if (!playing) render();
};
let mapToken = 0;

function entitiesFor(index: number): EntityTimeline | null {
	if (!pb) return null;
	if (!entityCache.has(index)) {
		const seg = pb.run.segments[index];
		const tables = seg.dataTables ?? pb.run.dataTables;
		let tl: EntityTimeline | null = null;
		if (tables) {
			try {
				tl = decodeEntities(seg, tables);
				if (tl.errors.length) console.warn(`entities in ${seg.map}:`, tl.errors);
			} catch (e) {
				console.warn(`couldn't decode entities in ${seg.map}`, e);
			}
		}
		entityCache.set(index, tl);
	}
	return entityCache.get(index)!;
}

function message3d(html: string | null) {
	const el = $('view3d-msg');
	el.hidden = html === null;
	if (html !== null) el.innerHTML = `<div class="box">${html}</div>`;
}

async function connectGame() {
	try {
		const fs = await pickGameFolder();
		if (fs) {
			gameFS = fs;
			gameFiles = null;
			mapCache.clear();
			load3dMap();
		}
	} catch (e) {
		if ((e as Error).name !== 'AbortError') message3d(`<h2>Couldn't open the folder</h2>${(e as Error).message}`);
	}
}

async function load3dMap() {
	if (!pb || viewMode !== '3d' || currentSeg < 0) return;  // render() calls back once a segment is shown
	const seg = pb.tracks[currentSeg].seg;
	gameFS ??= await devGameFS();
	if (!gameFS) {
		message3d(`<h2>The 3D view uses your own copy of the game</h2>
			Pick your <b>Portal 2</b> folder (the one with portal2.exe, usually in steamapps/common).
			The map is read from it in this page; nothing is uploaded.
			<br><button class="primary" id="connect-game">Choose Portal 2 folder</button>`);
		$('connect-game').onclick = connectGame;
		return;
	}
	const token = ++mapToken;
	const fs = gameFS;
	if (!gameFiles || gameFiles.fs !== fs) {
		message3d('Reading the game file index…');
		gameFiles = new GameFiles(fs);
		await gameFiles.init(pb.run.gameDir);
		materials = new Materials(gameFiles);
	}
	const files = gameFiles;
	const mats = materials!;
	let promise = mapCache.get(seg.map);
	if (!promise) {
		message3d(`Loading ${seg.map}…`);
		promise = (async () => {
			for (const path of mapPaths(seg.map, pb!.run.gameDir)) {
				if ((await fs.size(path)) !== null) {
					return loadBsp(fs, path, seg.map, {
						materials: async (names, pak) => {
							const zip = pak ? new Zip(pak) : null;
							mapPaks.set(seg.map, zip);
							files.mapPak = zip;
							const out = new Map<string, MaterialInfo>();
							await Promise.all(names.map(async n => out.set(n, await mats.get(n))));
							return out;
						},
					});
				}
			}
			throw new Error(`${seg.map}.bsp isn't in the game folder (${fs.label}).`);
		})();
		mapCache.set(seg.map, promise);
		promise.catch(() => mapCache.delete(seg.map));
	}
	try {
		const bsp = await promise;
		if (token !== mapToken) return;
		files.mapPak = mapPaks.get(seg.map) ?? null;
		view3d.setMap(bsp, files, mats);
		view3d.setSegment(pb.tracks[currentSeg], entitiesFor(currentSeg));
		message3d(null);
		render();
	} catch (e) {
		if (token === mapToken) message3d(`<h2>Couldn't load the map</h2>${(e as Error).message}<br><button class="primary" id="connect-game">Choose another folder</button>`);
		const b = document.getElementById('connect-game');
		if (b) b.onclick = connectGame;
	}
}


function showError(msg: string) {
	const el = $('error');
	el.textContent = msg;
	el.hidden = false;
	setTimeout(() => (el.hidden = true), 6000);
}

async function open(files: {bytes: Uint8Array; name: string}[]) {
	const name = files.length === 1 ? files[0].name : `${files.length} files`;
	try {
		const run = await loadRuns(files);
		if (!run.segments.some(s => s.views.length)) throw new Error('This file has no gameplay to show.');
		pb = new Playback(run);
		$('drop').hidden = true;
		$('viewer').hidden = false;
		panels.setRun(run, i => seekTo(pb!.tracks[i].start));
		timeline.pb = pb;
		currentSeg = -1;
		entityCache.clear();
		t = 0;
		setPlaying(false);
		document.title = `${run.fileName} · SAR Run Viewer`;
		requestAnimationFrame(() => render());
	} catch (e) {
		showError(`Couldn't open ${name}: ${(e as Error).message}`);
	}
}

function seekTo(tick: number) {
	if (!pb) return;
	t = Math.max(0, Math.min(pb.total, tick));
	render();
}

function setPlaying(p: boolean) {
	playing = p && !!pb;
	$('play').textContent = playing ? '❚❚' : '▶';
	if (playing) {
		if (pb && t >= pb.total) t = 0;
		lastFrame = performance.now();
		requestAnimationFrame(loop);
	}
}

function loop(now: number) {
	if (!playing || !pb) return;
	const loc = pb.locate(t);
	t += ((now - lastFrame) / 1000) * rate / loc.track.seg.intervalPerTick;
	lastFrame = now;
	if (t >= pb.total) {
		t = pb.total;
		setPlaying(false);
	}
	render();
	if (playing) requestAnimationFrame(loop);
}

function render() {
	if (!pb) return;
	const loc = pb.locate(t);
	const seg = loc.track.seg;
	if (loc.index !== currentSeg) {
		currentSeg = loc.index;
		pathView.setTrack(loc.track);
		speedGraph.setTrack(loc.track);
		panels.setSegment(loc.index, seg);
		if (viewMode === '3d') {
			view3d.setMap(null);
			load3dMap();
		}
	}
	const view = viewAt(loc.track, loc.tick);
	const cmd = cmdAt(loc.track, loc.tick);
	if (viewMode === '3d') view3d.update(view, loc.tick);
	else pathView.draw(view, loc.tick, seg.sar);
	timeline.draw(t, loc.index);
	speedGraph.draw(loc.tick);
	inputs.show(cmd);
	panels.update(loc.tick);

	const segTime = (loc.tick - seg.firstTick) * seg.intervalPerTick;
	const before = pb.tracks.slice(0, loc.index).reduce((n, tr) => n + tr.length * tr.seg.intervalPerTick, 0);
	const totalTime = pb.tracks.reduce((n, tr) => n + tr.length * tr.seg.intervalPerTick, 0);
	$('clock').textContent = `${loc.index + 1}/${pb.tracks.length} ${seg.map}   ${fmtTime(segTime)} / ${fmtTime(loc.track.length * seg.intervalPerTick)}   run ${fmtTime(before + segTime)} / ${fmtTime(totalTime)}   tick ${Math.floor(loc.tick)}`;
	if (view) {
		$('speed-now').textContent = `${Math.round(view.speed)} u/s`;
		$('readout').textContent = `pos ${view.origin.map(v => v.toFixed(1).padStart(8)).join(' ')}\nang ${view.angles.map(v => v.toFixed(1).padStart(8)).join(' ')}`;
	}
}

// ---- controls ----

$('play').onclick = () => setPlaying(!playing);
$('back').onclick = () => seekTo(t - 60);
$('fwd').onclick = () => seekTo(t + 60);
$<HTMLSelectElement>('rate').onchange = e => (rate = Number((e.target as HTMLSelectElement).value));
$('fit').onclick = () => {
	pathView.fit();
	render();
};
$('follow').onclick = () => {
	pathView.follow = !pathView.follow;
	render();
};
pathView.onUserMove = () => {
	$('follow').classList.toggle('on', pathView.follow);
	if (!playing) render();
};
$('view-mode').onclick = e => {
	const b = (e.target as HTMLElement).closest('button');
	if (!b) return;
	for (const x of $('view-mode').querySelectorAll('button')) x.classList.toggle('on', x === b);
	viewMode = b.dataset.mode as typeof viewMode;
	const is3d = viewMode === '3d';
	$('path').hidden = is3d;
	$('view3d').hidden = !is3d;
	$('cam-mode').hidden = !is3d;
	$('follow').hidden = is3d;
	$('fit').hidden = is3d;
	if (is3d) load3dMap();
	else pathView.setMode(viewMode as 'top' | 'side');
	render();
};
$('cam-mode').onclick = e => {
	const b = (e.target as HTMLElement).closest('button');
	if (!b) return;
	for (const x of $('cam-mode').querySelectorAll('button')) x.classList.toggle('on', x === b);
	view3d.setMode(b.dataset.cam as CameraMode);
	render();
};

document.addEventListener('keydown', e => {
	if (!pb || (e.target instanceof Element && e.target.matches('input, select, textarea'))) return;
	const step = e.shiftKey ? 60 : 1;
	if (e.code === 'Space') {
		e.preventDefault();
		setPlaying(!playing);
	} else if (e.code === 'ArrowRight') {
		seekTo(Math.floor(t) + step);
	} else if (e.code === 'ArrowLeft') {
		seekTo(Math.ceil(t) - step);
	} else if (e.code === 'Home') {
		seekTo(pb.tracks[currentSeg].start);
	}
});

window.addEventListener('resize', () => render());

// ---- opening files ----

$<HTMLInputElement>('file-input').onchange = async e => {
	const list = [...((e.target as HTMLInputElement).files ?? [])];
	if (list.length) open(await Promise.all(list.map(async x => ({bytes: new Uint8Array(await x.arrayBuffer()), name: x.name}))));
};

const drop = $('drop');
window.addEventListener('dragover', e => {
	e.preventDefault();
	drop.classList.add('over');
});
window.addEventListener('dragleave', () => drop.classList.remove('over'));
window.addEventListener('drop', async e => {
	e.preventDefault();
	drop.classList.remove('over');
	const list = [...(e.dataTransfer?.files ?? [])].filter(x => /\.(sarp|dem)$/i.test(x.name));
	if (list.length) open(await Promise.all(list.map(async x => ({bytes: new Uint8Array(await x.arrayBuffer()), name: x.name}))));
});

// dev convenience: #load=fixtures/name.sarp opens a file served next to the page
const m = location.hash.match(/^#load=(.+)$/);
if (m) {
	fetch(m[1]).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
		.then(b => open([{bytes: new Uint8Array(b), name: decodeURIComponent(m[1].split('/').pop()!)}]))
		.catch(e => showError(`Couldn't load ${m[1]}: ${e.message}`));
}
