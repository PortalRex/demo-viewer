import {groupRunFiles, loadRuns} from './core/load.ts';
import {Playback, viewAt, cmdAt, lastAtOrBefore} from './player/playback.ts';
import type {SegmentTrack, Located} from './player/playback.ts';
import type {Run, Segment} from './core/model.ts';
import {PathView} from './ui/pathview.ts';
import {Timeline, SpeedGraph} from './ui/charts.ts';
import {Panels, InputDisplay, fmtTime} from './ui/panels.ts';
import {View3D, QUALITY} from './ui/view3d.ts';
import type {CameraMode, CameraState, GhostSpec, NameTag} from './ui/view3d.ts';
import {decodeEntitySteps, keyAt} from './net/entities.ts';
import {background} from './ui/background.ts';
import type {EntityTimeline, EntityTrack} from './net/entities.ts';
import {loadBspOffThread} from './game/bsppool.ts';
import type {BspMap} from './game/bsp.ts';
import {devGameFS, pickGameFolder, mapPaths} from './game/gamefs.ts';
import {GameFiles} from './game/files.ts';
import {HudText} from './ui/hudtext.ts';
import {recordMp4, canExportVideo} from './ui/export.ts';
import {later, soon} from './core/later.ts';
import {installModelWorkers} from './game/mdlpool.ts';
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
type ViewMode = 'top' | 'side' | '3d';
let viewMode = 'top' as ViewMode;

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
	// (waits made of message yields, not timers or frame callbacks: a
	// background page throttles those to a minute or stops them)
	const yieldNow = () => new Promise<void>(r => {
		const c = new MessageChannel();
		c.port1.onmessage = () => r();
		c.port2.postMessage(0);
	});
	const sleep = async (ms: number) => {
		const end = performance.now() + ms;
		while (performance.now() < end) await yieldNow();
	};
	w.shootAt = async (path: string, tick: number, name: string, width = 640, height = 360, preroll = 300) => {
		if (!document.title.startsWith(path.split('/').pop()!)) {
			const prev = pb;
			await openPath(path);
			for (let i = 0; i < 80 && pb === prev; i++) await sleep(100);
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
			await sleep(250);
			if (view3d.debugPlayer() && performance.now() - quiet > 2000) break;
		}
		view3d.onLoaded = orig;
		for (let i = 0; i < 4; i++) {
			seekTo(tick);
			await sleep(250);
		}
		if (preroll > 0) {
			seekTo(Math.max(0, tick - preroll));
			await sleep(250);
			// (played through frame by frame)
			view3d.syncMeter = true;
			for (let t = Math.max(0, tick - preroll); t <= tick; t += 2) {
				seekTo(t);
				await yieldNow();
			}
			seekTo(tick);
			view3d.syncMeter = false;
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
// (models parse in workers, off the page's thread)
installModelWorkers();
const entityCache = new Map<number, Promise<EntityTimeline | null>>();
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
	later(redraw, 100);
};
let mapToken = 0;
// the segment the 3D view holds (-1: none): it's loaded as soon as a segment
// is shown, in any view, so switching to 3D finds it ready
let segIn3d = -1;
let segLoading = -1;  // the segment a load is under way for
let gameFilesReady: Promise<void> | null = null;
let cancelBackgroundLoad: (() => void) | undefined;

// A segment's entities, decoded in the background (a few hundred network
// records between frames: all at once stopped the page for a fifth of a
// second), once a segment
function entitiesFor(index: number): Promise<EntityTimeline | null> {
	if (!pb) return Promise.resolve(null);
	let p = entityCache.get(index);
	if (!p) {
		const seg = pb.run.segments[index];
		const tables = seg.dataTables ?? pb.run.dataTables;
		p = !tables ? Promise.resolve(null) : new Promise<EntityTimeline | null>(done => {
			const t = performance.now();
			let steps: Generator<void, EntityTimeline>;
			try {
				steps = decodeEntitySteps(seg, tables);
			} catch (e) {
				console.warn(`couldn't decode entities in ${seg.map}`, e);
				return done(null);
			}
			background(() => {
				try {
					const r = steps.next();
					if (!r.done) return true;
					timing('decodeEntities', t);
					if (r.value.errors.length) console.warn(`entities in ${seg.map}:`, r.value.errors);
					done(r.value);
				} catch (e) {
					console.warn(`couldn't decode entities in ${seg.map}`, e);
					done(null);
				}
				return false;
			}, true);
		});
		entityCache.set(index, p);
	}
	return p;
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
			segIn3d = segLoading = -1;
			load3dMap();
		}
	} catch (e) {
		if ((e as Error).name !== 'AbortError') message3d(`<h2>Couldn't open the folder</h2>${(e as Error).message}`);
	}
}

// A map's BSP, loaded once (in a worker) and kept while it's one of the last
// three asked for: the one before, the one shown and the one after. Its
// materials are looked up with its own pak (it may be the next map, loading
// while another is shown)
function bspFor(map: string, fs: GameFS, files: GameFiles): Promise<BspMap> {
	let promise = mapCache.get(map);
	if (promise) {
		// (most recent last)
		mapCache.delete(map);
		mapCache.set(map, promise);
		return promise;
	}
	promise = (async () => {
		for (const path of mapPaths(map, pb!.run.gameDir)) {
			if ((await fs.size(path)) !== null) {
				const t = performance.now();
				return timed(loadBspOffThread(fs, path, map, {
					materials: async (names, pak) => {
						const zip = pak ? new Zip(pak) : null;
						mapPaks.set(map, zip);
						const scoped = new Materials(files.withPak(zip));
						const out = new Map<string, MaterialInfo>();
						await Promise.all(names.map(async n => out.set(n, await scoped.get(n))));
						return out;
					},
				}), 'loadBsp', t);
			}
		}
		throw new Error(`${map}.bsp isn't in the game folder (${fs.label}).`);
	})();
	mapCache.set(map, promise);
	promise.catch(() => mapCache.delete(map));
	for (const key of [...mapCache.keys()].slice(0, -3)) {
		mapCache.delete(key);
		mapPaks.delete(key);
	}
	return promise;
}

// The next segment readied while this one plays: its map loaded, its
// entities decoded, its models and textures fetched, so the level change
// doesn't stop for them
function prepareNext(index: number) {
	const next = index + 1;
	if (!pb || !gameFS || !gameFiles || next >= pb.tracks.length) return;
	const seg = pb.tracks[next].seg;
	const bsp = bspFor(seg.map, gameFS, gameFiles);
	Promise.all([bsp, entitiesFor(next)]).then(([map, ents]) => {
		if (pb && gameFiles) view3d.prewarm(map, ents, gameFiles.withPak(mapPaks.get(seg.map) ?? null));
	}).catch(() => {});
}

async function load3dMap() {
	if (!pb || currentSeg < 0 || segIn3d === currentSeg || segLoading === currentSeg) return;  // render() calls back once a segment is shown
	const seg = pb.tracks[currentSeg].seg;
	// (out of the 3D view, only with a game folder that needs no asking for)
	const background = viewMode !== '3d';
	gameFS ??= await devGameFS();
	if (!gameFS) {
		if (background) return;
		message3d(`<h2>The 3D view uses your own copy of the game</h2>
			Pick your <b>Portal 2</b> folder (the one with portal2.exe, usually in steamapps/common).
			The map is read from it in this page; nothing is uploaded.
			<br><button class="primary" id="connect-game">Choose Portal 2 folder</button>`);
		$('connect-game').onclick = connectGame;
		return;
	}
	const token = ++mapToken;
	const fs = gameFS;
	segLoading = currentSeg;
	if (!gameFiles || gameFiles.fs !== fs) {
		const files = gameFiles = new GameFiles(fs);
		gameFilesReady = files.init(pb.run.gameDir).then(() => {
			materials = new Materials(files);
		});
	}
	message3d('Reading the game file index…');
	await gameFilesReady;
	if (token !== mapToken) return;
	const files = gameFiles;
	const mats = materials!;
	if (!mapCache.has(seg.map)) message3d(`Loading ${seg.map}…`);
	const promise = bspFor(seg.map, fs, files);
	try {
		const bsp = await promise;
		if (token !== mapToken) return;
		files.mapPak = mapPaks.get(seg.map) ?? null;
		let t = performance.now();
		view3d.setMap(bsp, files, mats);
		timing('setMap', t);
		const ents = await entitiesFor(currentSeg);
		if (token !== mapToken) return;
		t = performance.now();
		view3d.setSegment(pb.tracks[currentSeg], ents);
		timing('setSegment', t);
		segIn3d = currentSeg;
		segLoading = -1;
		prepareNext(currentSeg);
		if (viewMode === '3d') showViewAs();
		message3d(null);
		render();
	} catch (e) {
		if (token === mapToken) segLoading = -1;
		if (token === mapToken) message3d(`<h2>Couldn't load the map</h2>${(e as Error).message}<br><button class="primary" id="connect-game">Choose another folder</button>`);
		const b = document.getElementById('connect-game');
		if (b) b.onclick = connectGame;
	}
}


// (what a link wants shown, once a run's open: see links)
let afterOpen = () => {};

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
		segIn3d = segLoading = -1;
		entityCache.clear();
		t = 0;
		setPlaying(false);
		document.title = `${run.fileName} · SAR Run Viewer`;
		requestAnimationFrame(() => render());
		afterOpen();
		// (and now, where frames don't come, a hidden tab: the first render
		// starts the 3D view loading in the background)
		soon(() => currentSeg < 0 && render());
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
// the co-op partner's view in the corner of the Eyes view (autorender's
// renders show it); remembered per browser
let pipShown = true;
try {
	pipShown = localStorage.getItem('pip') !== 'off';
} catch {}
view3d.pipEnabled = pipShown;
$('pip-toggle').classList.toggle('on', pipShown);
$('pip-toggle').onclick = () => {
	pipShown = !pipShown;
	try {
		localStorage.setItem('pip', pipShown ? 'on' : 'off');
	} catch {}
	$('pip-toggle').classList.toggle('on', pipShown);
	view3d.pipEnabled = pipShown;
	render();
};
let hudText: HudText | null = null;
// players' names over their heads (remembered per browser)
let namesShown = true;
try {
	namesShown = localStorage.getItem('nameTags') !== 'off';
} catch {}
$('names-toggle').classList.toggle('on', namesShown);
$('names-toggle').onclick = () => {
	namesShown = !namesShown;
	try {
		localStorage.setItem('nameTags', namesShown ? 'on' : 'off');
	} catch {}
	$('names-toggle').classList.toggle('on', namesShown);
	render();
};
// each tag a small dark box with the name, in the raced player's colour
// (this run's in white), fainter where the world's in front of it; tags
// that would overlap stacked upwards; `s` scales it (with a video's height)
function drawNameTags(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, tags: NameTag[], w: number, h: number, s: number) {
	g.font = `700 ${12 * s}px Arial, Helvetica, sans-serif`;
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	const placed: {x: number; y: number; w: number}[] = [];
	const bh = 17 * s, gap = 2 * s;
	// (the lowest on screen first: the others go up past them)
	for (const t of [...tags].sort((a, b) => b.y - a.y)) {
		const x = Math.round(t.x * w);
		let y = Math.round(t.y * h);
		const bw = g.measureText(t.name).width + 10 * s;
		for (let moved = true; moved;) {
			moved = false;
			for (const p of placed) {
				if (Math.abs(p.x - x) < (p.w + bw) / 2 && y > p.y - bh - gap && y - bh < p.y + gap) {
					y = p.y - bh - gap;
					moved = true;
				}
			}
		}
		placed.push({x, y, w: bw});
		g.globalAlpha = t.hidden ? 0.45 : 1;
		g.fillStyle = 'rgba(0, 0, 0, 0.55)';
		g.beginPath();
		g.roundRect(x - bw / 2, y - bh, bw, bh, 3 * s);
		g.fill();
		g.fillStyle = t.color ?? '#fff';
		g.fillText(t.name, x, y - bh / 2 + 0.5 * s);
	}
	g.globalAlpha = 1;
}
function showNameTags() {
	const c = $<HTMLCanvasElement>('name-tags');
	const is3d = viewMode === '3d';
	$('names-toggle').hidden = !is3d;
	const dpr = window.devicePixelRatio || 1;
	const w = c.clientWidth, h = c.clientHeight;
	if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
		c.width = Math.round(w * dpr);
		c.height = Math.round(h * dpr);
	}
	const g = c.getContext('2d')!;
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, w, h);
	if (is3d && namesShown) drawNameTags(g, view3d.nameTags(), w, h, 1);
}

view3d.onDrawn = showNameTags;

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
		view3d.setMap(null);
		segIn3d = segLoading = -1;
		// (out of the 3D view, once the segment stays: not for each one
		// scrubbed past)
		cancelBackgroundLoad?.();
		if (viewMode === '3d') load3dMap();
		else cancelBackgroundLoad = later(load3dMap, 500);
	}
	const view = viewAt(loc.track, loc.tick);
	const cmd = cmdAt(loc.track, loc.tick);
	showBright(viewMode === '3d' ? seg.map : null);
	showRacers(loc, view);
	if (viewMode === '3d') view3d.update(view, loc.tick);
	else pathView.draw(view, loc.tick, seg.sar);
	showCmHud(viewMode === '3d' && view3d.mode === 'eyes' ? view3d.cmStats(loc.tick) : null);
	showHudText(loc.tick);
	if (viewMode !== '3d') showNameTags();
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
// the 3D view's quality, remembered per browser
let quality = 'high';
try {
	quality = localStorage.getItem('quality') ?? 'high';
} catch {}
if (!QUALITY[quality]) quality = 'high';
$<HTMLSelectElement>('quality').value = quality;
view3d.setQuality(QUALITY[quality]);
$<HTMLSelectElement>('quality').onchange = e => {
	quality = (e.target as HTMLSelectElement).value;
	try {
		localStorage.setItem('quality', quality);
	} catch {}
	view3d.setQuality(QUALITY[quality]);
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
	if (!is3d) $('view-as').hidden = $('pip-toggle').hidden = true;
	$('follow').hidden = is3d;
	$('fit').hidden = is3d;
	$('path-line').hidden = !is3d;
	$('quality').hidden = !is3d;
	$('export').hidden = !is3d || !canExportVideo();
	if (is3d) {
		if (segIn3d === currentSeg) showViewAs();
		load3dMap();
	} else pathView.setMode(viewMode as 'top' | 'side');
	render();
};
// co-op: which player the camera follows
function showViewAs() {
	const box = $('view-as');
	const players = view3d.players();
	box.hidden = $('pip-toggle').hidden = players.length < 2;
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

// ---- ghost race ----
// Other runs of the same maps, played alongside: each one's players drawn as
// ghosts in its own colour from the moment each run's segment starts (its
// path too, where asked), and the difference between it and this run, from
// when it was where this run's player is now. Each can be hidden, have its
// path shown, or be taken off. A co-op run's two demos (the board names them
// with the same time and ids one apart) race as one run
interface RacerPlayer {
	pb: Playback;
	name: string;
}
interface Racer {
	players: RacerPlayer[];
	key: string | null;  // its first demo's name, where the board's (map_time_steamid_id)
	color: string;
	shown: boolean;  // its players drawn
	path: boolean;   // their paths drawn
	row: HTMLElement;
}
const RACER_COLORS = ['#ff8c26', '#4cb8ff', '#d45cff', '#3fd6c8', '#ffd84a', '#ff5c7a', '#9be34a', '#ff9ad5'];
let racers: Racer[] = [];
// (the first of these not taken; then hues spread around the wheel, each
// as far from the ones before it as it can be)
function racerColor(): string {
	const free = RACER_COLORS.find(c => !racers.some(r => r.color === c));
	if (free) return free;
	for (let i = 0; ; i++) {
		const c = `hsl(${Math.round((i * 137.508 + 20) % 360)}, ${i % 2 ? 70 : 90}%, ${i % 3 ? 62 : 70}%)`;
		if (!racers.some(r => r.color === c)) return c;
	}
}
// a board demo's run (map_time_steamid_id): the same map and time, and an id
// the same or one apart, is the same co-op run's other player
function boardRun(fileName: string): {map: string; time: string; id: number} | null {
	const m = /^(.+)_(\d{3,8})_\d{17}_(\d+)\.(dem|sarp)$/i.exec(fileName);
	return m && {map: m[1].toLowerCase(), time: m[2], id: Number(m[3])};
}
function sameBoardRun(a: string | null, b: string | null) {
	const x = a ? boardRun(a) : null, y = b ? boardRun(b) : null;
	return !!x && !!y && x.map === y.map && x.time === y.time && Math.abs(x.id - y.id) <= 1;
}
// a racer's segment for one of this run's: the one on the same map (the
// same one of them, where a run visits a map more than once)
function racerTrack(p: RacerPlayer, loc: Located): SegmentTrack | null {
	if (!pb) return null;
	const map = loc.track.seg.map;
	const visit = pb.tracks.slice(0, loc.index).filter(tr => tr.seg.map === map).length;
	return p.pb.tracks.filter(tr => tr.seg.map === map)[visit] ?? null;
}
// where a segment's run finishes (the challenge mode flags, as the board's
// runs record them) and how many ticks SAR's timer gave it, where known: in
// the demo, or else in a one-map run's file name as the board names its
// demos (map_time_steamid_id, the time in hundredths)
function finishOf(seg: Segment, run: Run): {tick: number; ticks: number | null} | null {
	let tick: number | null = null, ticks: number | null = null;
	for (const e of seg.sar) {
		if (e.kind === 'cmFlags' && ticks === null) tick = e.tick;
		if (e.kind === 'speedrunTime') {
			tick = e.tick;
			ticks = e.splits.reduce((n, s) => n + s.segments.reduce((m, x) => m + x.ticks, 0), 0) || null;
		}
	}
	const named = /_(\d{3,8})_\d{17}_\d+\.(dem|sarp)$/i.exec(run.fileName);
	if (ticks === null && named && run.segments.length === 1) ticks = Math.round(Number(named[1]) / 100 / seg.intervalPerTick);
	return tick === null ? null : {tick, ticks};
}
// where a racer's segment that records no finish (a demo from before the
// challenge mode flags) finishes: where its player first comes near where
// this run's finishes (as it keeps recording after), with its time from its
// file name where the board's
const finishesNear = new WeakMap<SegmentTrack, {tick: number; ticks: number | null} | null>();
function finishNear(track: SegmentTrack, own: SegmentTrack, finish: {tick: number} | null, run: Run): {tick: number; ticks: number | null} | null {
	if (finishesNear.has(track)) return finishesNear.get(track)!;
	const at = finish && viewAt(own, finish.tick)?.origin;
	let found: {tick: number; ticks: number | null} | null = null;
	if (at) {
		const v = track.seg.views.find(v => (v.origin[0] - at[0]) ** 2 + (v.origin[1] - at[1]) ** 2 + (v.origin[2] - at[2]) ** 2 < 48 ** 2);
		if (v) found = {tick: v.tick, ticks: null};
		const named = /_(\d{3,8})_\d{17}_\d+\.(dem|sarp)$/i.exec(run.fileName);
		if (found && named && run.segments.length === 1) found.ticks = Math.round(Number(named[1]) / 100 / track.seg.intervalPerTick);
	}
	finishesNear.set(track, found);
	return found;
}
// (a racer's tick as many seconds into its run as this one is into its own:
// from where each run's timer started, the finish less its time (the other
// run's where one has none, so their finishes meet), as each player's demo
// of a co-op run starts recording at its own moment; else from where each
// segment starts)
function racerTick(loc: Located, track: SegmentTrack) {
	const other = racers.flatMap(r => r.players).find(p => p.pb.tracks.includes(track));
	const a = pb && finishOf(loc.track.seg, pb.run), b = other && (finishOf(track.seg, other.pb.run) ?? finishNear(track, loc.track, a, other.pb.run));
	const startA = a && b ? a.tick - (a.ticks ?? b.ticks ?? 0) : loc.track.seg.firstTick;
	const startB = a && b ? b.tick - (b.ticks ?? a.ticks ?? 0) : track.seg.firstTick;
	const seconds = (loc.tick - startA) * loc.track.seg.intervalPerTick;
	return startB + seconds / track.seg.intervalPerTick;
}
function racerAt(loc: Located, track: SegmentTrack): {origin: [number, number, number]; angles: [number, number, number]} | null {
	const tick = racerTick(loc, track);
	// (gone once its segment's over: finished, or loaded out)
	if (tick > track.seg.lastTick) return null;
	const v = viewAt(track, tick);
	return v && {origin: v.origin, angles: v.angles};
}
// seconds behind the racer (negative: ahead): when it was closest to where
// this run's player is, within a few seconds of the same time; and how
// close that came (squared)
function racerDelta(loc: Located, at: number[] | null, track: SegmentTrack): {delta: number; d2: number} | null {
	if (!at) return null;
	const views = track.seg.views;
	const tick = racerTick(loc, track);
	const window = 6 / track.seg.intervalPerTick;
	let i = Math.max(0, lastAtOrBefore(views, tick - window));
	let best = -1, bestD = Infinity;
	for (; i < views.length && views[i].tick <= tick + window; i++) {
		const o = views[i].origin;
		const d = (o[0] - at[0]) ** 2 + (o[1] - at[1]) ** 2 + (o[2] - at[2]) ** 2;
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	// (nowhere near: the routes went different ways)
	if (best < 0 || bestD > 256 ** 2) return null;
	return {delta: (tick - views[best].tick) * track.seg.intervalPerTick, d2: bestD};
}
// a racer's segment's player (its model and animation), decoded once it's
// raced (only that kept, so many racers don't hold every entity of their
// demos); null until then
const racerEntities = new WeakMap<SegmentTrack, EntityTrack | null>();
function racerPlayerTrack(p: RacerPlayer, track: SegmentTrack): EntityTrack | null {
	if (racerEntities.has(track)) return racerEntities.get(track)!;
	racerEntities.set(track, null);
	const tables = track.seg.dataTables ?? p.pb.run.dataTables;
	if (!tables) return null;
	let steps: Generator<void, EntityTimeline>;
	try {
		steps = decodeEntitySteps(track.seg, tables);
	} catch (e) {
		console.warn(`couldn't decode entities in ${p.name}'s ${track.seg.map}`, e);
		return null;
	}
	// (in slices of a few milliseconds between tasks, not behind the map's
	// own loading in the background queue)
	const slice = () => {
		const end = performance.now() + 8;
		try {
			while (performance.now() < end) {
				const step = steps.next();
				if (!step.done) continue;
				racerEntities.set(track, step.value.player ?? null);
				if (!playing) render();
				return;
			}
		} catch (e) {
			console.warn(`couldn't decode entities in ${p.name}'s ${track.seg.map}`, e);
			return;
		}
		soon(slice);
	};
	soon(slice);
	return null;
}
// (past this many, each row on one line, so a whole board's top fits)
const COMPACT_RACERS = 6;
// what the views draw of them, and each one's row (with its difference)
function showRacers(loc: Located, view: {origin: number[]} | null) {
	$('ghost-hud').hidden = !racers.length;
	$('ghost-hud').classList.toggle('compact', racers.length > COMPACT_RACERS);
	const marks: GhostSpec[] = [];
	const others = racers.length ? view3d.otherPlayers(loc.tick) : [];
	for (const r of racers) {
		let best: {delta: number; d2: number} | null = null, here = false;
		for (const p of r.players) {
			const track = racerTrack(p, loc);
			if (!track) continue;
			here = true;
			// (its players as their robots in the 3D view)
			const player = viewMode === '3d' && r.shown ? racerPlayerTrack(p, track) : null;
			const body = player ? {track: player, tick: racerTick(loc, track)} : null;
			marks.push({view: r.shown ? racerAt(loc, track) : null, color: r.color, path: r.path ? track : null, body, name: p.name});
			// (in co-op, the nearest of its players to whichever of this
			// run's players it's nearest: the recording one or their partner)
			for (const at of [view?.origin ?? null, ...others]) {
				const d = racerDelta(loc, at, track);
				if (d && (!best || d.d2 < best.d2)) best = d;
			}
		}
		r.row.classList.toggle('away', !here);
		const d = best?.delta ?? null;
		const el = r.row.querySelector('.ghost-delta') as HTMLElement;
		el.textContent = d === null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(2)}`;
		el.classList.toggle('behind', d !== null && d > 0.005);
		el.classList.toggle('ahead', d !== null && d < -0.005);
	}
	view3d.ghosts = marks;
	pathView.racers = marks;
}
const racerName = (r: Racer) => r.players.map(p => p.name).join(' & ');
// a racer's row: its name in its colour, its difference, and its toggles
function racerRow(r: Racer): HTMLElement {
	const row = document.createElement('div');
	row.className = 'ghost-row';
	row.style.setProperty('--ghost', r.color);
	const name = document.createElement('div');
	name.className = 'ghost-name';
	const delta = document.createElement('div');
	delta.className = 'ghost-delta';
	const toggle = (label: string, title: string, get: () => boolean, set: (on: boolean) => void) => {
		const b = document.createElement('button');
		b.className = 'toggle';
		b.textContent = label;
		b.title = title;
		b.classList.toggle('on', get());
		b.onclick = () => {
			set(!get());
			b.classList.toggle('on', get());
			render();
		};
		return b;
	};
	const remove = document.createElement('button');
	remove.textContent = '×';
	remove.title = 'Take this run off';
	remove.onclick = () => {
		racers = racers.filter(x => x !== r);
		row.remove();
		$('ghost').classList.toggle('on', racers.length > 0);
		render();
	};
	const buttons = document.createElement('div');
	buttons.className = 'ghost-buttons';
	buttons.append(
		toggle('Ghost', 'Show its players', () => r.shown, on => (r.shown = on)),
		toggle('Path', 'Draw its path through the map', () => r.path, on => (r.path = on)),
		remove);
	row.append(name, delta, buttons);
	return row;
}
function nameRacerRow(r: Racer) {
	r.row.querySelector('.ghost-name')!.textContent = racerName(r);
	r.row.title = `${racerName(r)} (${r.players.map(p => p.pb.run.fileName).join(', ')}): how far ahead (−) or behind (+) this run is, where it was at this spot`;
}
// a run to race: with its co-op partner's demo where that's raced already
// (none where it's this run's own partner's), else a run of its own
function addRacer(run: Run) {
	const maps = new Set(pb?.run.segments.map(s => s.map));
	if (!run.segments.some(s => maps.has(s.map) && s.views.length)) throw new Error('it has none of the maps this run plays.');
	if (pb && sameBoardRun(run.fileName, pb.run.fileName)) return;
	// (named after its player, as the demo records them)
	const player: RacerPlayer = {pb: new Playback(run), name: run.player || run.fileName.replace(/\.[^.]+$/, '')};
	const team = racers.find(r => sameBoardRun(r.key, run.fileName));
	if (team) {
		team.players.push(player);
		nameRacerRow(team);
		return;
	}
	const r: Racer = {players: [player], key: boardRun(run.fileName) ? run.fileName : null, color: racerColor(), shown: true, path: false, row: null!};
	r.row = racerRow(r);
	nameRacerRow(r);
	racers.push(r);
	$('ghost-list').append(r.row);
}
$('ghost').onclick = () => ($('ghost-input') as HTMLInputElement).click();
// (each file a run of its own, but for a demo's numbered continuations)
$<HTMLInputElement>('ghost-input').onchange = async e => {
	const input = e.target as HTMLInputElement;
	const list = [...(input.files ?? [])];
	input.value = '';
	for (const files of groupRunFiles(list)) {
		try {
			addRacer(await loadRuns(await Promise.all(files.map(async x => ({bytes: new Uint8Array(await x.arrayBuffer()), name: x.name})))));
		} catch (err) {
			showError(`Couldn't race ${files.length === 1 ? files[0].name : `${files.length} files`}: ${(err as Error).message}`);
		}
	}
	$('ghost').classList.toggle('on', racers.length > 0);
	render();
};

// ---- video export ----
// Part of the run drawn frame by frame at a video's size (each frame waits
// for what it shows; a level change, for the next map), with the on-screen
// text and the challenge mode HUD drawn over it, saved as an MP4
let exportCancelled = false;
let exporting = false;
const exportDialog = $('export-dialog') as HTMLDialogElement;
$('export').onclick = () => {
	if (!pb || exporting) return;
	($('export-range').querySelector('option[value="run"]') as HTMLOptionElement).hidden = pb.tracks.length < 2;
	$('export-progress').hidden = true;
	($('export-go') as HTMLButtonElement).disabled = false;
	exportDialog.showModal();
};
$('export-cancel').onclick = () => {
	if (exporting) exportCancelled = true;
	else exportDialog.close();
};
exportDialog.addEventListener('cancel', e => {
	// (Escape cancels an export running, rather than hiding it)
	if (exporting) {
		e.preventDefault();
		exportCancelled = true;
	}
});
// (until the 3D view has its map and has gone a moment without anything
// arriving)
async function exportSettle(tick: number) {
	let quiet = performance.now();
	const orig = view3d.onLoaded;
	view3d.onLoaded = () => {
		quiet = performance.now();
		orig();
	};
	const start = performance.now();
	try {
		while (performance.now() - start < 30000 && !exportCancelled) {
			seekTo(tick);
			await new Promise(r => setTimeout(r, 100));
			if (segIn3d === currentSeg && performance.now() - quiet > 1500) break;
		}
	} finally {
		view3d.onLoaded = orig;
	}
	seekTo(tick);
}
function drawCmHud(g: OffscreenCanvasRenderingContext2D, stats: {portals: number; seconds: number}, w: number, h: number) {
	// (as the page's HUD box, scaled with the video's height)
	const s = h / 540;
	const cs = Math.floor(stats.seconds * 100 + 1e-6);
	const pad = (n: number) => String(n).padStart(2, '0');
	const rows = [['Portals:', String(stats.portals)], ['Time:', `${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`]];
	const bw = 150 * s, line = 13 * 1.35 * s, bh = line * 2 + 10 * s;
	const x = w - 16 * s - bw, y = h - 16 * s - bh;
	g.fillStyle = 'rgba(0, 0, 0, 0.55)';
	g.fillRect(x, y, bw, bh);
	g.fillStyle = '#fff';
	g.font = `700 ${13 * s}px Arial, Helvetica, sans-serif`;
	g.textBaseline = 'middle';
	rows.forEach(([label, value], i) => {
		const ty = y + 5 * s + line * (i + 0.5);
		g.textAlign = 'left';
		g.fillText(label, x + 9 * s, ty);
		g.textAlign = 'right';
		g.fillText(value, x + bw - 9 * s, ty);
	});
}
// the raced runs' rows, as the page shows them (each one's name in its
// colour and how far ahead or behind this run is), top right
function drawRacers(g: OffscreenCanvasRenderingContext2D, w: number, h: number) {
	const s = h / 540;
	// (past a few, a line each, as the page shows them)
	const compact = racers.length > COMPACT_RACERS;
	const bw = (compact ? 230 : 190) * s, bh = (compact ? 20 : 46) * s, gap = (compact ? 3 : 6) * s, x = w - 16 * s - bw;
	let y = 16 * s;
	for (const row of document.querySelectorAll<HTMLElement>('#ghost-list .ghost-row')) {
		if (row.classList.contains('away') || y + bh > h - 16 * s) continue;
		const name = row.querySelector('.ghost-name')!.textContent ?? '';
		const deltaEl = row.querySelector('.ghost-delta')!;
		const deltaColor = deltaEl.classList.contains('ahead') ? '#47c17b' : deltaEl.classList.contains('behind') ? '#ff5d5d' : '#fff';
		g.fillStyle = 'rgba(0, 0, 0, 0.55)';
		g.fillRect(x, y, bw, bh);
		g.fillStyle = row.style.getPropertyValue('--ghost');
		g.fillRect(x + bw - 3 * s, y, 3 * s, bh);
		g.textAlign = 'right';
		g.textBaseline = 'alphabetic';
		if (compact) {
			g.font = `700 ${14 * s}px Arial, Helvetica, sans-serif`;
			g.fillText(name, x + bw - 70 * s, y + 15 * s, bw - 80 * s);
			g.fillStyle = deltaColor;
			g.fillText(deltaEl.textContent ?? '', x + bw - 11 * s, y + 15 * s);
		} else {
			g.font = `400 ${13 * s}px Arial, Helvetica, sans-serif`;
			g.fillText(name, x + bw - 13 * s, y + 17 * s, bw - 20 * s);
			g.fillStyle = deltaColor;
			g.font = `700 ${20 * s}px Arial, Helvetica, sans-serif`;
			g.fillText(deltaEl.textContent ?? '', x + bw - 13 * s, y + 39 * s);
		}
		y += bh + gap;
	}
}
$('export-go').onclick = async () => {
	if (!pb || exporting) return;
	const range = ($('export-range') as HTMLSelectElement).value;
	const [width, height] = ($('export-size') as HTMLSelectElement).value.split('x').map(Number);
	const fps = Number(($('export-fps') as HTMLSelectElement).value);
	const track = pb.tracks[currentSeg];
	const from = range === 'run' ? 0 : range === 'here' ? t : track.start;
	const to = range === 'run' ? pb.total : track.start + track.length;
	const step = 1 / fps / track.seg.intervalPerTick;
	const frames = Math.max(1, Math.floor((to - from) / step) + 1);
	const progress = $('export-progress') as HTMLProgressElement;
	const note = $('export-note');
	const noteText = note.textContent;
	progress.hidden = false;
	progress.value = 0;
	($('export-go') as HTMLButtonElement).disabled = true;
	exporting = true;
	exportCancelled = false;
	setPlaying(false);
	const out = new OffscreenCanvas(width, height);
	const g = out.getContext('2d')!;
	const hud = gameFiles ? new HudText(gameFiles, document.createElement('canvas')) : null;
	const name = `${pb.run.fileName.replace(/\.[^.]+$/, '')}_${Math.round(from)}-${Math.round(to)}.mp4`;
	const started = performance.now();
	try {
		await hud?.load();
		note.textContent = 'Getting the first frame ready…';
		view3d.setCaptureSize([width, height]);
		await exportSettle(from);
		const video = await recordMp4({
			width, height, fps, frames,
			frame: async i => {
				const tick = Math.min(to, from + i * step);
				seekTo(tick);
				if (segIn3d !== currentSeg) await exportSettle(tick);
				// (copied straight after it's drawn: the canvas isn't kept)
				g.drawImage(view3d.canvas!, 0, 0, width, height);
				const loc = pb!.locate(tick);
				const messages = view3d.hudMessages();
				if (hud && messages && titlesShown) {
					hud.draw(messages.messages, loc.tick * messages.interval, messages.interval, [width, height]);
					g.drawImage(hud.canvas, 0, 0);
				}
				const stats = view3d.mode === 'eyes' && cmShown ? view3d.cmStats(loc.tick) : null;
				if (stats) drawCmHud(g, stats, width, height);
				if (namesShown) drawNameTags(g, view3d.nameTags(), width, height, height / 540);
				if (racers.length) drawRacers(g, width, height);
				return out;
			},
			progress: done => {
				progress.value = done / frames;
				const left = (performance.now() - started) / done * (frames - done) / 1000;
				note.textContent = `Frame ${done} of ${frames}, about ${Math.ceil(left)} s left`;
			},
			cancelled: () => exportCancelled,
		});
		if (video) {
			const a = document.createElement('a');
			a.href = URL.createObjectURL(video);
			a.download = name;
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 10000);
		}
		exportDialog.close();
	} catch (e) {
		showError(`Couldn't export the video: ${(e as Error).message}`);
		exportDialog.close();
	} finally {
		exporting = false;
		view3d.setCaptureSize(null);
		note.textContent = noteText;
		render();
	}
};

// #load=<url> opens a recording from a URL (one served next to the page,
// or anywhere that allows it)
let openedFrom: string | null = null;
const openPath = (path: string) => fetch(path).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
	.then(async b => {
		await open([{bytes: new Uint8Array(b), name: decodeURIComponent(path.split('/').pop()!)}]);
		openedFrom = path;
	})
	.catch(e => showError(`Couldn't load ${path}: ${e.message}`));

// ---- links ----
// A link to a moment of a run: the recording's URL (where it was opened from
// one; otherwise its file name, for whoever has the file to drop in), the
// tick, the view, and the 3D camera:
//   #load=<url>&t=<tick>&view=3d&cam=free&pos=x,y,z&ang=pitch,yaw
interface Moment {
	tick: number;
	view: ViewMode;
	camera?: CameraState;
	file?: string;
}
function momentLink(): string {
	const q = new URLSearchParams();
	if (openedFrom) q.set('load', openedFrom);
	else if (pb) q.set('file', pb.run.fileName);
	q.set('t', String(Math.round(t)));
	q.set('view', viewMode);
	if (viewMode === '3d') {
		const c = view3d.cameraState();
		q.set('cam', c.mode);
		if (c.pos) q.set('pos', c.pos.join(','));
		if (c.ang) q.set('ang', c.ang.join(','));
		if (c.offset) q.set('off', c.offset.join(','));
	}
	// (the URL's own characters kept readable)
	return `${location.origin}${location.pathname}#${q.toString().replace(/%2F/g, '/').replace(/%2C/g, ',').replace(/%3A/g, ':')}`;
}
function parseMoment(hash: string): {load: string | null; moment: Moment | null} {
	const q = new URLSearchParams(hash.replace(/^#/, ''));
	const nums = (k: string) => q.get(k)?.split(',').map(Number).filter(Number.isFinite);
	const load = q.get('load');
	if (!q.has('t')) return {load, moment: null};
	const view = q.get('view');
	const cam = q.get('cam');
	return {
		load,
		moment: {
			tick: Number(q.get('t')) || 0,
			view: view === '3d' || view === 'side' ? view : 'top',
			camera: cam === 'eyes' || cam === 'orbit' || cam === 'free' || cam === 'chase' ? {mode: cam, pos: nums('pos'), ang: nums('ang'), offset: nums('off')} : undefined,
			file: q.get('file') ?? undefined,
		},
	};
}
// a link's moment shown once its run is open
let pendingMoment: Moment | null = null;
function showMoment(m: Moment) {
	if (!pb) return;
	if (m.view !== viewMode) $('view-mode').querySelector<HTMLButtonElement>(`button[data-mode="${m.view}"]`)?.click();
	if (m.view === '3d' && m.camera) {
		for (const x of $('cam-mode').querySelectorAll<HTMLElement>('button')) x.classList.toggle('on', x.dataset.cam === m.camera.mode);
		view3d.setCameraState(m.camera);
	}
	seekTo(m.tick);
}
afterOpen = () => {
	const m = pendingMoment;
	pendingMoment = null;
	if (m) showMoment(m);
};
$('share').onclick = async () => {
	const b = $('share');
	try {
		await navigator.clipboard.writeText(momentLink());
		b.textContent = 'Copied';
	} catch {
		// (no clipboard: the link put in the address bar to copy from there)
		history.replaceState(null, '', momentLink());
		b.textContent = 'In address bar';
	}
	setTimeout(() => (b.textContent = 'Link'), 1500);
};
{
	const {load, moment} = parseMoment(location.hash);
	pendingMoment = moment;
	if (load) openPath(load);
	else if (moment?.file) $('drop-file').textContent = `This link shows ${moment.file} at tick ${moment.tick}: drop that file here to watch it.`;
}
if (import.meta.env.DEV) (window as unknown as {openFixture: typeof openPath}).openFixture = openPath;
