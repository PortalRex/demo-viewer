import {loadRuns} from './core/load.ts';
import {Playback, viewAt, cmdAt} from './player/playback.ts';
import {PathView} from './ui/pathview.ts';
import {Timeline, SpeedGraph} from './ui/charts.ts';
import {Panels, InputDisplay, fmtTime} from './ui/panels.ts';
import {View3D} from './ui/view3d.ts';
import type {CameraMode} from './ui/view3d.ts';
import {decodeEntities, keyAt} from './net/entities.ts';
import type {EntityTimeline} from './net/entities.ts';
import {loadBsp} from './game/bsp.ts';
import type {BspMap} from './game/bsp.ts';
import {devGameFS, pickGameFolder, mapPaths} from './game/gamefs.ts';
import {GameFiles} from './game/files.ts';
import {HudText} from './ui/hudtext.ts';
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
if (import.meta.env.DEV) {
	// debugging: seek, look from a game position (eye origin + pitch/yaw), save the 3D view to fixtures/shots
	const w = window as unknown as Record<string, unknown>;
	w.seek = (t: number) => seekTo(t);
	// a shot from in front of a portal (network index), `dist` out and `side` across
	w.facePortal = (name: string, index: number, tick: number, dist = 120, side = 0) => {
		const t = pb && view3d.debugTrack(index, 'CProp_Portal');
		const k = t && keyAt(t, tick);
		if (!k) return Promise.resolve('no portal');
		const yaw = k.angles[1] * Math.PI / 180, pitch = k.angles[0] * Math.PI / 180;
		const fwd = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
		const left = [-Math.sin(yaw), Math.cos(yaw), 0];
		const eye = [0, 1, 2].map(i => k.origin[i] + fwd[i] * dist + left[i] * side);
		const d = [0, 1, 2].map(i => k.origin[i] - eye[i]);
		const len = Math.hypot(d[0], d[1], d[2]);
		return (w.shot as (n: string, e: number[], a: number[]) => Promise<string>)(name, eye, [-Math.asin(d[2] / len) * 180 / Math.PI, Math.atan2(d[1], d[0]) * 180 / Math.PI]);
	};
	// a shot of the recording player from `dist` away, `side` degrees round from where they face
	w.sideShot = (name: string, tick: number, dist = 110, side = 90) => {
		seekTo(tick);
		const p = view3d.debugPlayer();
		const k = p && keyAt(p, tick);
		if (!k) return Promise.resolve('no player');
		const yaw = (k.angles[1] + side) * Math.PI / 180;
		const eye = [k.origin[0] + Math.cos(yaw) * dist, k.origin[1] + Math.sin(yaw) * dist, k.origin[2] + 40];
		const d = [k.origin[0] - eye[0], k.origin[1] - eye[1], k.origin[2] + 36 - eye[2]];
		const len = Math.hypot(d[0], d[1], d[2]);
		return (w.shot as (n: string, e: number[], a: number[]) => Promise<string>)(name, eye, [-Math.asin(d[2] / len) * 180 / Math.PI, Math.atan2(d[1], d[0]) * 180 / Math.PI]);
	};
	// timing: opening the 3D view until loading goes quiet, then the CPU cost
	// of a frame (seek = update + render) in Eyes and Orbit at `tick`
	w.bench = async (tick = 1000) => {
		const t0 = performance.now();
		let last = t0;
		const orig = view3d.onLoaded;
		view3d.onLoaded = () => {
			last = performance.now();
			orig();
		};
		if (viewMode !== '3d') ($('view-3d') as HTMLButtonElement | null)?.click() ?? [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '3D')?.click();
		while (performance.now() - t0 < 60000) {
			await new Promise(r => setTimeout(r, 100));
			if (view3d.debugPlayer() && performance.now() - last > 1500) break;
		}
		view3d.onLoaded = orig;
		const out: Record<string, string | number> = {settled: ((last - t0) / 1000).toFixed(2)};
		for (const mode of ['eyes', 'orbit'] as const) {
			view3d.setMode(mode);
			for (let i = 0; i < 20; i++) seekTo(tick - 40 + i);
			const t = performance.now();
			for (let i = 0; i < 60; i++) seekTo(tick + i * 0.5);
			out[mode] = ((performance.now() - t) / 60).toFixed(2);
		}
		Object.assign(out, view3d.debugStats());
		return out;
	};
	// timing by stage: `n` seeks `step` ticks apart from `from` (negative
	// steps for scrubbing back), each stage's average CPU time per frame
	w.prof = (from: number, n = 60, step = 1) => {
		const v = view3d as unknown as Record<string, unknown>;
		const stages = ['update', 'render', 'renderScene', 'renderPortalViews', 'renderMonitorCamera', 'meterExposure', 'updateParticles',
			'updatePaintBlobs', 'updateTurretLasers', 'updateRopes', 'updateFlashlight', 'lightModels', 'updateSprites', 'updateViewModel', 'placeAttached'];
		const times: Record<string, number> = {};
		const originals = new Map<string, unknown>();
		for (const name of stages) {
			const fn = v[name];
			if (typeof fn !== 'function') continue;
			originals.set(name, fn);
			times[name] = 0;
			v[name] = function (this: unknown, ...args: unknown[]) {
				const start = performance.now();
				try {
					return (fn as (...a: unknown[]) => unknown).apply(this, args);
				} finally {
					times[name] += performance.now() - start;
				}
			};
		}
		try {
			seekTo(from - step * 3);
			seekTo(from - step * 2);
			for (const k in times) times[k] = 0;
			const start = performance.now();
			for (let i = 0; i < n; i++) seekTo(from + i * step);
			const out: Record<string, string> = {total: ((performance.now() - start) / n).toFixed(2)};
			for (const k of Object.keys(times).sort((a, b) => times[b] - times[a])) if (times[k] / n >= 0.05) out[k] = (times[k] / n).toFixed(2);
			return out;
		} finally {
			for (const [name, fn] of originals) v[name] = fn;
		}
	};
	// a small shot of every segment (at `frac` through it) into
	// fixtures/shots/<name>/<index>_<map>.jpg, each once loading goes quiet
	w.bloom = (scale: number | null) => {
		view3d.bloomOverride = scale;
		view3d.render();
	};
	w.tour = async (name: string, frac = 0.5, first = 0, last = Infinity, width = 480, height = 270) => {
		if (!pb) return 'no run';
		if (viewMode !== '3d') [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '3D')?.click();
		const done: string[] = [];
		for (let i = first; i < Math.min(pb.tracks.length, last + 1); i++) {
			const tr = pb.tracks[i];
			let quiet = performance.now();
			const orig = view3d.onLoaded;
			view3d.onLoaded = () => {
				quiet = performance.now();
				orig();
			};
			const t = tr.start + Math.floor(tr.length * frac);
			const t0 = performance.now();
			while (performance.now() - t0 < 30000) {
				seekTo(t);
				await new Promise(r => setTimeout(r, 250));
				if (view3d.debugPlayer() && performance.now() - quiet > 1500) break;
			}
			view3d.onLoaded = orig;
			seekTo(t);
			const url = view3d.snapshot(width, height, undefined, undefined, 'image/jpeg');
			const file = `${name}/${String(i).padStart(3, '0')}_${tr.seg.map}`;
			await fetch(`/__shot?name=${file}&ext=jpg`, {method: 'POST', body: url});
			done.push(file);
		}
		return done.length;
	};
	// open a fixture (unless it's open), wait for the 3D view to finish
	// loading at `tick`, and save a shot as fixtures/shots/<name>.jpg; played
	// into from `preroll` ticks before, so the exposure has adapted as the
	// game's would have (it eases in over a second or so)
	w.shootAt = async (path: string, tick: number, name: string, width = 640, height = 360, preroll = 300) => {
		if (!document.title.startsWith(path.split('/').pop()!)) {
			const prev = pb;
			await openPath(path);
			for (let i = 0; i < 80 && pb === prev; i++) await new Promise(r => setTimeout(r, 100));
		}
		if (viewMode !== '3d') [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '3D')?.click();
		let quiet = performance.now();
		const orig = view3d.onLoaded;
		view3d.onLoaded = () => {
			quiet = performance.now();
			orig();
		};
		const t0 = performance.now();
		while (performance.now() - t0 < 40000) {
			seekTo(tick);
			await new Promise(r => setTimeout(r, 250));
			if (view3d.debugPlayer() && performance.now() - quiet > 2000) break;
		}
		view3d.onLoaded = orig;
		for (let i = 0; i < 4; i++) {
			seekTo(tick);
			await new Promise(r => setTimeout(r, 250));
		}
		if (preroll > 0) {
			seekTo(Math.max(0, tick - preroll));
			await new Promise(r => setTimeout(r, 250));
			for (let t = Math.max(0, tick - preroll); t <= tick; t += 2) {
				seekTo(t);
				await new Promise(r => requestAnimationFrame(r));
			}
			seekTo(tick);
		}
		const url = view3d.snapshot(width, height, undefined, undefined, 'image/jpeg');
		await fetch(`/__shot?name=${name}&ext=jpg`, {method: 'POST', body: url});
		return name;
	};
	// frames of a tick range into fixtures/shots/<name>/ (as JPEGs), for videos
	w.record = async (name: string, from: number, to: number, step = 2, width = 960, height = 540) => {
		let n = 0;
		for (let t = from; t <= to; t += step) {
			seekTo(t);
			const url = view3d.snapshot(width, height, undefined, undefined, 'image/jpeg');
			await fetch(`/__shot?name=${name}/${String(n++).padStart(4, '0')}&ext=jpg`, {method: 'POST', body: url});
		}
		return n;
	};
	w.shot = (name: string, eye?: number[], ang?: number[]) => {
		const url = view3d.snapshot(1600, 900, eye, ang);
		return fetch(`/__shot?name=${name}`, {method: 'POST', body: url}).then(r => r.text());
	};
}
// dev: how long the 3D view's loading steps take (window.timings)
const timings: [string, number, number][] = [];
function timing(name: string, start: number) {
	if (!import.meta.env.DEV) return;
	timings.push([name, Math.round(start), Math.round(performance.now() - start)]);
	if (timings.length > 100) timings.splice(0, timings.length - 100);
}
function timed<T>(p: Promise<T>, name: string, start: number): Promise<T> {
	return p.then(v => (timing(name, start), v));
}
if (import.meta.env.DEV) (window as unknown as {timings: typeof timings}).timings = timings;
const entityCache = new Map<number, EntityTimeline | null>();
const mapCache = new Map<string, Promise<BspMap>>();
let gameFS: GameFS | null = null;
let gameFiles: GameFiles | null = null;
let materials: Materials | null = null;
const mapPaks = new Map<string, Zip | null>();
// textures and models arrive in bursts: one redraw a frame for all of them
// (or after a moment, where frames don't come: a hidden tab)
let loadedPending = false;
view3d.onLoaded = () => {
	if (playing || loadedPending) return;
	loadedPending = true;
	const redraw = () => {
		if (!loadedPending) return;
		loadedPending = false;
		if (!playing) render();
	};
	requestAnimationFrame(redraw);
	setTimeout(redraw, 100);
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
				const t = performance.now();
				tl = decodeEntities(seg, tables);
				timing('decodeEntities', t);
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
					const t = performance.now();
					return timed(loadBsp(fs, path, seg.map, {
						materials: async (names, pak) => {
							const zip = pak ? new Zip(pak) : null;
							mapPaks.set(seg.map, zip);
							files.mapPak = zip;
							const out = new Map<string, MaterialInfo>();
							await Promise.all(names.map(async n => out.set(n, await mats.get(n))));
							return out;
						},
					}), 'loadBsp', t);
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
		let t = performance.now();
		view3d.setMap(bsp, files, mats);
		timing('setMap', t);
		const ents = entitiesFor(currentSeg);
		t = performance.now();
		view3d.setSegment(pb.tracks[currentSeg], ents);
		timing('setSegment', t);
		showViewAs();
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

// the challenge mode HUD (Eyes view of a challenge mode recording), as the
// game draws it; its toggle shows with it and is remembered per browser
let cmShown = true;
try {
	cmShown = localStorage.getItem('cmHud') !== 'off';
} catch {}
$('cm-toggle').classList.toggle('on', cmShown);
$('cm-toggle').onclick = () => {
	cmShown = !cmShown;
	try {
		localStorage.setItem('cmHud', cmShown ? 'on' : 'off');
	} catch {}
	$('cm-toggle').classList.toggle('on', cmShown);
	render();
};
// the game's on-screen text (chapter titles) over the Eyes view; its toggle
// shows when the recording has any and is remembered per browser
let titlesShown = true;
try {
	titlesShown = localStorage.getItem('hudTitles') !== 'off';
} catch {}
$('titles-toggle').classList.toggle('on', titlesShown);
$('titles-toggle').onclick = () => {
	titlesShown = !titlesShown;
	try {
		localStorage.setItem('hudTitles', titlesShown ? 'on' : 'off');
	} catch {}
	$('titles-toggle').classList.toggle('on', titlesShown);
	render();
};
let hudText: HudText | null = null;
function showHudText(tick: number) {
	const hud = viewMode === '3d' ? view3d.hudMessages() : null;
	$('titles-toggle').hidden = !hud;
	if (gameFiles && hudText?.files !== gameFiles) {
		hudText = new HudText(gameFiles, $('hud-text') as HTMLCanvasElement);
		hudText.onLoaded = () => render();
	}
	hudText?.draw(hud && titlesShown ? hud.messages : null, tick * (hud?.interval ?? 0), hud?.interval ?? 0);
}

// brightening for dark maps, as autorender renders them (its maps'
// auto_fullbright flag: mat_ambient_light 0.05), on by default where it
// does; the choice is remembered per map
const AUTO_BRIGHT = new Set(['sp_a2_bts3']);
const BRIGHT_AMBIENT = 0.05;
let brightMaps: Record<string, boolean> = {};
try {
	brightMaps = JSON.parse(localStorage.getItem('brightMaps') ?? '{}');
} catch {}
const brightOn = (map: string) => brightMaps[map] ?? AUTO_BRIGHT.has(map);
function showBright(map: string | null) {
	$('bright-toggle').hidden = !map;
	if (!map) return;
	const on = brightOn(map);
	$('bright-toggle').classList.toggle('on', on);
	view3d.extraAmbient = on ? BRIGHT_AMBIENT : 0;
}
$('bright-toggle').onclick = () => {
	const map = pb?.locate(t).track.seg.map;
	if (!map) return;
	brightMaps[map] = !brightOn(map);
	try {
		localStorage.setItem('brightMaps', JSON.stringify(brightMaps));
	} catch {}
	render();
};

function showCmHud(stats: {portals: number; seconds: number} | null) {
	$('cm-toggle').hidden = !stats;
	$('cm-hud').hidden = !stats || !cmShown;
	if (!stats || !cmShown) return;
	const cs = Math.floor(stats.seconds * 100 + 1e-6);
	const pad = (n: number) => String(n).padStart(2, '0');
	$('cm-portals').textContent = String(stats.portals);
	$('cm-time').textContent = `${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
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
	showBright(viewMode === '3d' ? seg.map : null);
	if (viewMode === '3d') view3d.update(view, loc.tick);
	else pathView.draw(view, loc.tick, seg.sar);
	showCmHud(viewMode === '3d' && view3d.mode === 'eyes' ? view3d.cmStats(loc.tick) : null);
	showHudText(loc.tick);
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
// the path in the 3D view, remembered per browser
let pathShown = true;
try {
	pathShown = localStorage.getItem('pathLine') !== 'off';
} catch {}
const showPath = () => {
	$('path-line').classList.toggle('on', pathShown);
	view3d.setPathShown(pathShown);
};
showPath();
$('path-line').onclick = () => {
	pathShown = !pathShown;
	try {
		localStorage.setItem('pathLine', pathShown ? 'on' : 'off');
	} catch {}
	showPath();
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
	if (!is3d) $('view-as').hidden = true;
	$('follow').hidden = is3d;
	$('fit').hidden = is3d;
	$('path-line').hidden = !is3d;
	if (is3d) load3dMap();
	else pathView.setMode(viewMode as 'top' | 'side');
	render();
};
// co-op: which player the camera follows
function showViewAs() {
	const box = $('view-as');
	const players = view3d.players();
	box.hidden = players.length < 2;
	box.innerHTML = '';
	for (const p of players) {
		const b = document.createElement('button');
		b.textContent = p.name;
		b.title = p.recording ? `${p.name} (recorded this demo)` : `${p.name} (from the demo's network data)`;
		b.classList.toggle('on', p.recording);
		b.onclick = () => {
			for (const x of box.querySelectorAll('button')) x.classList.toggle('on', x === b);
			view3d.follow(p.recording ? null : p.index);
			render();
		};
		box.appendChild(b);
	}
}

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
const openPath = (path: string) => fetch(path).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
	.then(b => open([{bytes: new Uint8Array(b), name: decodeURIComponent(path.split('/').pop()!)}]))
	.catch(e => showError(`Couldn't load ${path}: ${e.message}`));
const m = location.hash.match(/^#load=(.+)$/);
if (m) openPath(m[1]);
if (import.meta.env.DEV) (window as unknown as {openFixture: typeof openPath}).openFixture = openPath;
