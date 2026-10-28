// Lining up runs of the same map, as the ghost race does: which of another
// run's segments goes with one of this run's, the other run's tick at a
// moment of this one (from where each run's timer started), and how far
// ahead or behind it is where its player passed the same spot
import type {Run, Segment} from '../core/model.ts';
import {viewAt, lastAtOrBefore} from './playback.ts';
import type {Located, Playback, SegmentTrack} from './playback.ts';

// a board demo's run (map_time_steamid_id): the same map and time, and an id
// the same or one apart, is the same co-op run's other player
export function boardRun(fileName: string): {map: string; time: string; id: number} | null {
	const m = /^(.+)_(\d{3,8})_\d{17}_(\d+)\.(dem|sarp)$/i.exec(fileName);
	return m && {map: m[1].toLowerCase(), time: m[2], id: Number(m[3])};
}
export function sameBoardRun(a: string | null, b: string | null) {
	const x = a ? boardRun(a) : null, y = b ? boardRun(b) : null;
	return !!x && !!y && x.map === y.map && x.time === y.time && Math.abs(x.id - y.id) <= 1;
}

// another run's segment for one of this run's: the one on the same map (the
// same one of them, where a run visits a map more than once)
export function trackOnSameMap(own: Playback, other: Playback, loc: Located): SegmentTrack | null {
	const map = loc.track.seg.map;
	const visit = own.tracks.slice(0, loc.index).filter(tr => tr.seg.map === map).length;
	return other.tracks.filter(tr => tr.seg.map === map)[visit] ?? null;
}

// the time a board demo's name gives (in hundredths), in ticks; for a run of
// one map, as the board's are
function namedTicks(run: Run, interval: number): number | null {
	const named = /_(\d{3,8})_\d{17}_\d+\.(dem|sarp)$/i.exec(run.fileName);
	return named && run.segments.length === 1 ? Math.round(Number(named[1]) / 100 / interval) : null;
}

// where a segment's run finishes (the challenge mode flags, as the board's
// runs record them) and how many ticks SAR's timer gave it, where known: in
// the demo, or else in a one-map run's file name as the board names its
// demos (map_time_steamid_id, the time in hundredths)
export function finishOf(seg: Segment, run: Run): {tick: number; ticks: number | null} | null {
	let tick: number | null = null, ticks: number | null = null;
	for (const e of seg.sar) {
		if (e.kind === 'cmFlags' && ticks === null) tick = e.tick;
		if (e.kind === 'speedrunTime') {
			tick = e.tick;
			ticks = e.splits.reduce((n, s) => n + s.segments.reduce((m, x) => m + x.ticks, 0), 0) || null;
		}
	}
	ticks ??= namedTicks(run, seg.intervalPerTick);
	return tick === null ? null : {tick, ticks};
}

// where another run's segment that records no finish (a demo from before
// the challenge mode flags) finishes: where its player first comes near
// where this run's finishes (as it keeps recording after), with its time
// from its file name where the board's
const FINISH_NEAR = 48;  // units
const finishesNear = new WeakMap<SegmentTrack, {tick: number; ticks: number | null} | null>();
export function finishNear(track: SegmentTrack, own: SegmentTrack, finish: {tick: number} | null, run: Run): {tick: number; ticks: number | null} | null {
	if (finishesNear.has(track)) return finishesNear.get(track)!;
	const at = finish && viewAt(own, finish.tick)?.origin;
	let found: {tick: number; ticks: number | null} | null = null;
	if (at) {
		const v = track.seg.views.find(v => (v.origin[0] - at[0]) ** 2 + (v.origin[1] - at[1]) ** 2 + (v.origin[2] - at[2]) ** 2 < FINISH_NEAR ** 2);
		if (v) found = {tick: v.tick, ticks: namedTicks(run, track.seg.intervalPerTick)};
	}
	finishesNear.set(track, found);
	return found;
}

// Another run's tick as many seconds into its run as this one is into its
// own: from where each run's timer started, the finish less its time (the
// other run's where one has none, so their finishes meet), as each player's
// demo of a co-op run starts recording at its own moment; else from where
// each segment starts
export function alignedTick(loc: Located, ownRun: Run | null, track: SegmentTrack, otherRun: Run | null): number {
	const a = ownRun && finishOf(loc.track.seg, ownRun);
	const b = otherRun && (finishOf(track.seg, otherRun) ?? finishNear(track, loc.track, a, otherRun));
	const startA = a && b ? a.tick - (a.ticks ?? b.ticks ?? 0) : loc.track.seg.firstTick;
	const startB = a && b ? b.tick - (b.ticks ?? a.ticks ?? 0) : track.seg.firstTick;
	const seconds = (loc.tick - startA) * loc.track.seg.intervalPerTick;
	return startB + seconds / track.seg.intervalPerTick;
}

// How far the other run is ahead (+) or behind (−), in seconds, at its tick
// `tick` (lined up as above): when its player was nearest `at` (where this
// run's is), within a few seconds of then, and how near that came (squared);
// or within the other run's ticks given (just after where it was matched
// last, so a route that comes back near itself isn't matched further on).
// Null where it came nowhere near: the routes went different ways
const GAP_WINDOW = 6;  // seconds either way
const GAP_NEAR = 256;  // units
export function gapAt(at: number[] | null, track: SegmentTrack, tick: number, within?: [number, number]): {delta: number; d2: number; tick: number} | null {
	if (!at) return null;
	const views = track.seg.views;
	const window = GAP_WINDOW / track.seg.intervalPerTick;
	const [from, to] = within ?? [tick - window, tick + window];
	let best = -1, bestD = Infinity;
	for (let i = Math.max(0, lastAtOrBefore(views, from)); i < views.length && views[i].tick <= to; i++) {
		const o = views[i].origin;
		const d = (o[0] - at[0]) ** 2 + (o[1] - at[1]) ** 2 + (o[2] - at[2]) ** 2;
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	if (best < 0 || bestD > GAP_NEAR ** 2) return null;
	return {delta: (tick - views[best].tick) * track.seg.intervalPerTick, d2: bestD, tick: views[best].tick};
}
