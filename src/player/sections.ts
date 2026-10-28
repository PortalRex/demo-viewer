// Comparing raced runs section by section, and grouping them by route.
// Sections run between gates: points along the shown run's path that every
// run passes near, spread over the run; each run's time at a gate is when it
// came nearest it after the gate before. Routes: runs whose paths stay near
// each other the whole way are one route
import type {Vec3} from '../core/model.ts';
import type {SegmentTrack} from './playback.ts';

// a run's player through a segment, from its timer's start to its finish
// (ticks of its own segment)
export interface RunPath {
	track: SegmentTrack;
	start: number;
	end: number;
}
export interface Gate {
	tick: number;  // the shown run's (the first path's)
	pos: Vec3;
}
export interface Sections {
	gates: Gate[];          // the last one the finish
	arrivals: number[][];   // per path, seconds from its start at each gate (NaN: never came near)
}

const GATE_NEAR = 96;     // units: passing this near a gate is passing it
const SAMPLE = 0.2;       // seconds between the shown run's points tried as gates
const MIN_SECTION = 1;    // seconds, at least, between gates
const MAX_SECTIONS = 12;
// and this far apart, where the shown run's player is moving (not where it
// waited: the others pass a gate there and the next at once)
const GATE_APART = 384;   // units
const GATE_MOVING = 150;  // units a second

const dist2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// the views of a path between its start and end
function between(p: RunPath) {
	return p.track.seg.views.filter(v => v.tick >= p.start && v.tick <= p.end);
}

// Points of a path in a grid of cells, to find those near a point quickly
class PointGrid {
	private cells = new Map<string, Vec3[]>();
	private cell: number;
	constructor(points: Vec3[], cell: number) {
		this.cell = cell;
		for (const p of points) {
			const k = this.key(p);
			const list = this.cells.get(k);
			if (list) list.push(p);
			else this.cells.set(k, [p]);
		}
	}
	private key(p: Vec3, dx = 0, dy = 0, dz = 0) {
		return `${Math.floor(p[0] / this.cell) + dx},${Math.floor(p[1] / this.cell) + dy},${Math.floor(p[2] / this.cell) + dz}`;
	}
	// the squared distance to the nearest point within a cell of it (Infinity: none)
	nearest2(p: Vec3): number {
		let best = Infinity;
		for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
			for (const q of this.cells.get(this.key(p, dx, dy, dz)) ?? []) best = Math.min(best, dist2(p, q));
		}
		return best;
	}
}

export function sections(paths: RunPath[]): Sections | null {
	const [own] = paths;
	if (!own) return null;
	const interval = own.track.seg.intervalPerTick;
	const ownViews = between(own);
	if (ownViews.length < 2) return null;
	const grids = paths.slice(1).map(p => new PointGrid(between(p).map(v => v.origin), GATE_NEAR));
	// (the shown run's points every run passes near)
	const candidates: Gate[] = [];
	const step = Math.max(1, Math.round(SAMPLE / interval));
	for (let i = step; i < ownViews.length - step; i += step) {
		const v = ownViews[i], a = ownViews[i - step], b = ownViews[i + step];
		const speed = Math.sqrt(dist2(a.origin, b.origin)) / ((b.tick - a.tick) * interval);
		if (speed >= GATE_MOVING && speed < 3500 && grids.every(g => g.nearest2(v.origin) <= GATE_NEAR ** 2)) candidates.push({tick: v.tick, pos: v.origin});
	}
	// (spread over the run, a section at least MIN_SECTION long; the finish last)
	const duration = (own.end - own.start) * interval;
	const spacing = Math.max(MIN_SECTION, duration / MAX_SECTIONS) / interval;
	const gates: Gate[] = [];
	let last = own.start;
	let lastPos = ownViews[0].origin;
	for (const c of candidates) {
		if (c.tick - last < spacing || own.end - c.tick < spacing / 2 || dist2(c.pos, lastPos) < GATE_APART ** 2) continue;
		gates.push(c);
		last = c.tick;
		lastPos = c.pos;
	}
	const finish = ownViews[ownViews.length - 1];
	gates.push({tick: own.end, pos: finish.origin});
	return {gates, arrivals: paths.map((p, i) => arrivals(p, gates, i === 0))};
}

// when a path last came near each gate before going on to the next (its
// nearest there; seconds from its start), worked back from its finish: a run
// that passes a gate's spot early, does something elsewhere and comes back
// by it is timed from when it came back
function arrivals(p: RunPath, gates: Gate[], own: boolean): number[] {
	const views = between(p), interval = p.track.seg.intervalPerTick;
	const out = gates.map(() => NaN);
	out[gates.length - 1] = (p.end - p.start) * interval;
	let upto = views.length - 1;
	for (let gi = gates.length - 2; gi >= 0; gi--) {
		const g = gates[gi];
		// (the shown run is at its own gates when it set them)
		if (own) {
			out[gi] = (g.tick - p.start) * interval;
			continue;
		}
		let best = -1, bestD = GATE_NEAR ** 2;
		for (let i = upto; i >= 0; i--) {
			const d = dist2(views[i].origin, g.pos);
			if (d <= bestD) {
				bestD = d;
				best = i;
			} else if (best >= 0 && d > GATE_NEAR ** 2) break;  // (gone out of reach again, back in time: that visit's over)
		}
		if (best < 0) break;  // (never there: nor, before it, at the gates before)
		upto = best;
		out[gi] = (views[best].tick - p.start) * interval;
	}
	return out;
}

// each section's time for each path, and the best of each (the sum of
// those the best run its sections could make): of the paths given (those of
// one route: another's sections may be done in another order, and don't add
// up with its), else of all of them
export function sectionTimes(s: Sections, among?: (i: number) => boolean): {times: number[][]; best: number[]; sumOfBest: number} {
	const times = s.arrivals.map(a => a.map((t, i) => t - (i ? a[i - 1] : 0)));
	const counted = times.filter((_, i) => !among || among(i));
	const best = s.gates.map((_, i) => Math.min(...counted.map(t => t[i]).filter(Number.isFinite)));
	return {times, best, sumOfBest: best.reduce((n, t) => n + (Number.isFinite(t) ? t : 0), 0)};
}

// Which route each path took: paths that stay near each other nearly all
// the way (either way round) are one route; one that goes another way for
// part of it (a variant on one stretch) is another. Each route is led by
// the first path to take it (the paths best first: its fastest), and a path
// joins the first route whose leader it matches (not chained through
// others, each a little off the one before). Routes numbered by how many
// took them, most first
const ROUTE_STEP = 32;      // units between a path's points compared
const ROUTE_POINTS = 400;   // at most, per path
const ROUTE_FAR = 128;      // units from the other path: off it
const ROUTE_SHARE = 0.08;   // more of a path than this off the other: another route
export function routes(paths: RunPath[]): number[] {
	const points = paths.map(p => resample(between(p).map(v => v.origin)));
	const grids = points.map(pts => new PointGrid(pts, ROUTE_FAR));
	// (how much of a's path is off b's)
	const apart = (a: number, b: number) => points[a].filter(p => grids[b].nearest2(p) > ROUTE_FAR ** 2).length / Math.max(1, points[a].length);
	const leaders: number[] = [];
	const leader = paths.map((_, i) => {
		const l = leaders.find(l => Math.max(apart(i, l), apart(l, i)) <= ROUTE_SHARE);
		if (l !== undefined) return l;
		leaders.push(i);
		return i;
	});
	const sizes = new Map<number, number>();
	for (const l of leader) sizes.set(l, (sizes.get(l) ?? 0) + 1);
	const order = [...sizes.keys()].sort((x, y) => sizes.get(y)! - sizes.get(x)! || x - y);
	return leader.map(l => order.indexOf(l));
}

// a path's points every ROUTE_STEP along it (further apart on a long one)
function resample(path: Vec3[]): Vec3[] {
	let length = 0;
	for (let i = 1; i < path.length; i++) length += Math.sqrt(dist2(path[i - 1], path[i]));
	const stepLen = Math.max(ROUTE_STEP, length / ROUTE_POINTS);
	const out: Vec3[] = path.length ? [path[0]] : [];
	let since = 0;
	for (let i = 1; i < path.length; i++) {
		const d = Math.sqrt(dist2(path[i - 1], path[i]));
		// (a teleport's jump isn't walked along)
		if (d > 512) {
			out.push(path[i]);
			since = 0;
			continue;
		}
		since += d;
		if (since >= stepLen) {
			out.push(path[i]);
			since = 0;
		}
	}
	return out;
}
