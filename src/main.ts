import {loadRun} from './core/load.ts';
import {Playback, viewAt, cmdAt} from './player/playback.ts';
import {PathView} from './ui/pathview.ts';
import {Timeline, SpeedGraph} from './ui/charts.ts';
import {Panels, InputDisplay, fmtTime} from './ui/panels.ts';

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

function showError(msg: string) {
	const el = $('error');
	el.textContent = msg;
	el.hidden = false;
	setTimeout(() => (el.hidden = true), 6000);
}

async function open(bytes: Uint8Array, name: string) {
	try {
		const run = await loadRun(bytes, name);
		if (!run.segments.some(s => s.views.length)) throw new Error('This file has no gameplay to show.');
		pb = new Playback(run);
		$('drop').hidden = true;
		$('viewer').hidden = false;
		panels.setRun(run, i => seekTo(pb!.tracks[i].start));
		timeline.pb = pb;
		currentSeg = -1;
		t = 0;
		setPlaying(false);
		document.title = `${name} · SAR Run Viewer`;
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
	}
	const view = viewAt(loc.track, loc.tick);
	const cmd = cmdAt(loc.track, loc.tick);
	pathView.draw(view, loc.tick, seg.sar);
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
	pathView.setMode(b.dataset.mode as 'top' | 'side');
	render();
};

document.addEventListener('keydown', e => {
	if (!pb || (e.target as HTMLElement).matches('input, select, textarea')) return;
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
	const f = (e.target as HTMLInputElement).files?.[0];
	if (f) open(new Uint8Array(await f.arrayBuffer()), f.name);
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
	const f = e.dataTransfer?.files[0];
	if (f) open(new Uint8Array(await f.arrayBuffer()), f.name);
});

// dev convenience: #load=fixtures/name.sarp opens a file served next to the page
const m = location.hash.match(/^#load=(.+)$/);
if (m) {
	fetch(m[1]).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
		.then(b => open(new Uint8Array(b), decodeURIComponent(m[1].split('/').pop()!)))
		.catch(e => showError(`Couldn't load ${m[1]}: ${e.message}`));
}
