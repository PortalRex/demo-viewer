// The swarm: a board's top runs (a hundred, say) as dots moving together
// through the map, each where its player is at this moment of the shown run.
// Kept light: each run only as its views (no network data, commands or
// console), and each one's tick a straight line from the shown run's,
// worked out once a segment
import type {Run, Vec3} from '../core/model.ts';
import {Playback, viewAt} from './playback.ts';
import type {Located, SegmentTrack} from './playback.ts';
import {alignedTick, trackOnSameMap} from './race.ts';

export interface SwarmRun {
	pb: Playback;
	rank: number;
}

// a run as just what the swarm needs of it
export function swarmRun(run: Run, rank: number): SwarmRun {
	for (const seg of run.segments) {
		seg.net = [];
		seg.userCmds = [];
		seg.consoleCmds = [];
		seg.dataTables = undefined;
	}
	run.dataTables = undefined;
	return {pb: new Playback(run), rank};
}

// (the other run's tick as a + b × this run's, for one of this run's segments)
const lines = new WeakMap<SegmentTrack, Map<SegmentTrack, {a: number; b: number}>>();
function line(loc: Located, own: Run, track: SegmentTrack, other: Run) {
	let byOwn = lines.get(track);
	if (!byOwn) lines.set(track, byOwn = new Map());
	let l = byOwn.get(loc.track);
	if (!l) {
		const at0 = alignedTick({...loc, tick: 0}, own, track, other), at1 = alignedTick({...loc, tick: 1000}, own, track, other);
		l = {a: at0, b: (at1 - at0) / 1000};
		byOwn.set(loc.track, l);
	}
	return l;
}

// where each swarm run's player is at a moment of the shown run (null: not
// on this map now, or finished)
export function swarmAt(swarm: SwarmRun[], own: Playback, loc: Located): (Vec3 | null)[] {
	return swarm.map(s => {
		const track = trackOnSameMap(own, s.pb, loc);
		if (!track) return null;
		const l = line(loc, own.run, track, s.pb.run);
		const tick = l.a + l.b * loc.tick;
		if (tick > track.seg.lastTick || tick < track.seg.firstTick) return null;
		return viewAt(track, tick)?.origin ?? null;
	});
}

// a rank's colour: gold at the top, through green to blue at the back
export function rankColor(rank: number, of: number): [number, number, number] {
	const f = of > 1 ? (rank - 1) / (of - 1) : 0;
	const hue = 48 + f * 165, s = 0.9, v = 1;
	// (HSV to RGB, 0..1)
	const c = v * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = v - c;
	const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : [0, x, c];
	return [r + m, g + m, b + m];
}
