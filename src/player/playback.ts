// The run as one timeline: segments laid end to end, looked up by a global
// tick. Views come every packet (usually every other tick), so positions
// and angles are interpolated between them.
import type {Run, Segment, UserCmd, Vec3, ViewFrame} from '../core/model.ts';

export interface SegmentTrack {
	seg: Segment;
	start: number;   // global tick of the segment's first tick
	length: number;  // ticks
	speeds: Float32Array;     // horizontal speed (units/s) at each view
	teleports: Uint8Array;    // 1 where the view jumped (portal, teleport, load)
}

const MAX_SPEED = 3500;  // faster than this between two views is a teleport

export interface Located {
	track: SegmentTrack;
	index: number;  // segment index in the run
	tick: number;   // segment-local tick (fractional)
}

export class Playback {
	readonly run: Run;
	readonly tracks: SegmentTrack[] = [];
	readonly total: number;

	constructor(run: Run) {
		this.run = run;
		let start = 0;
		for (const seg of run.segments) {
			const length = Math.max(1, seg.lastTick - seg.firstTick);
			const {speeds, teleports} = computeSpeeds(seg);
			this.tracks.push({seg, start, length, speeds, teleports});
			start += length;
		}
		this.total = start;
	}

	locate(t: number): Located {
		t = Math.max(0, Math.min(this.total, t));
		let i = this.tracks.length - 1;
		while (i > 0 && this.tracks[i].start > t) i--;
		const track = this.tracks[i];
		return {track, index: i, tick: track.seg.firstTick + (t - track.start)};
	}

	globalTick(segIndex: number, tick: number) {
		const track = this.tracks[segIndex];
		return track.start + (tick - track.seg.firstTick);
	}
}

function computeSpeeds(seg: Segment) {
	const v = seg.views;
	const speeds = new Float32Array(v.length);
	const teleports = new Uint8Array(v.length);
	for (let i = 1; i < v.length; i++) {
		const dt = (v[i].tick - v[i - 1].tick) * seg.intervalPerTick;
		if (dt <= 0) {
			speeds[i] = speeds[i - 1];
			continue;
		}
		const dx = v[i].origin[0] - v[i - 1].origin[0];
		const dy = v[i].origin[1] - v[i - 1].origin[1];
		const dz = v[i].origin[2] - v[i - 1].origin[2];
		const s = Math.hypot(dx, dy) / dt;
		if (s > MAX_SPEED || Math.abs(dz) / dt > MAX_SPEED) {
			teleports[i] = 1;
			speeds[i] = speeds[i - 1];
		} else {
			speeds[i] = s;
		}
	}
	if (v.length > 1) speeds[0] = speeds[1];
	return {speeds, teleports};
}

// last index whose tick is <= t (or -1)
export function lastAtOrBefore<T extends {tick: number}>(arr: T[], t: number): number {
	let lo = 0, hi = arr.length - 1, ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (arr[mid].tick <= t) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerpAngle = (a: number, b: number, f: number) => {
	let d = ((b - a + 540) % 360) - 180;
	return a + d * f;
};

export interface ViewState {
	origin: Vec3;
	angles: Vec3;
	speed: number;
	viewIndex: number;
}

export function viewAt(track: SegmentTrack, tick: number): ViewState | null {
	const views = track.seg.views;
	if (!views.length) return null;
	const i = lastAtOrBefore(views, tick);
	if (i < 0) return {origin: views[0].origin, angles: views[0].angles, speed: track.speeds[0], viewIndex: 0};
	const a: ViewFrame = views[i];
	const b: ViewFrame | undefined = views[i + 1];
	if (!b || b.tick === a.tick || track.teleports[i + 1]) {
		return {origin: a.origin, angles: a.angles, speed: track.speeds[i], viewIndex: i};
	}
	const f = Math.min(1, (tick - a.tick) / (b.tick - a.tick));
	const angles: Vec3 = [lerp(a.angles[0], b.angles[0], f), lerpAngle(a.angles[1], b.angles[1], f), lerp(a.angles[2], b.angles[2], f)];
	// Where views are ticks apart (a co-op client's recording, P-body's
	// usually, writes one per snapshot), the aim between them is each tick's
	// user command's, which carries it exactly (it matches the views where
	// they meet); the roll, which commands don't have, stays the views'
	if (b.tick - a.tick > 1) {
		const aim = cmdAim(track.seg.userCmds, tick);
		if (aim) [angles[0], angles[1]] = aim;
	}
	return {
		origin: b.tick - a.tick > 1 ? curveAt(track, i, f) : [lerp(a.origin[0], b.origin[0], f), lerp(a.origin[1], b.origin[1], f), lerp(a.origin[2], b.origin[2], f)],
		angles,
		speed: lerp(track.speeds[i], track.speeds[i + 1], f),
		viewIndex: i,
	};
}

// Where views come every few ticks (a co-op client's), where the view is
// between views i and i+1 (f of the way in time): along a curve through them
// (cubic Hermite, each view's velocity from its neighbours'), so the speed
// changes smoothly rather than in steps at each view. A teleport either side
// ends the curve there (a velocity from the one side). Measured on Buttons'
// co-op clients' demos, how unevenly the view moves frame to frame: about
// 40% less than straight between views (a curve through the views as they
// are overshoots, and is worse than straight)
function curveAt(track: SegmentTrack, i: number, f: number): Vec3 {
	const views = track.seg.views;
	const joined = (j: number) => j > 0 && j < views.length && !track.teleports[j];  // views j-1 and j
	// (eased towards its neighbours, 1:2:1: views stamped evenly though they
	// come unevenly lurch between fast and slow)
	const point = (j: number): Vec3 => {
		const p = views[j].origin;
		if (!joined(j) || !joined(j + 1) || views[j].tick - views[j - 1].tick < 2 || views[j + 1].tick - views[j].tick < 2) return p;
		const a = views[j - 1].origin, c = views[j + 1].origin;
		return [(a[0] + 2 * p[0] + c[0]) / 4, (a[1] + 2 * p[1] + c[1]) / 4, (a[2] + 2 * p[2] + c[2]) / 4];
	};
	const velocity = (j: number): Vec3 => {
		const a = joined(j) ? j - 1 : j, b = joined(j + 1) ? j + 1 : j;
		if (a === b) return [0, 0, 0];
		const pa = point(a), pb = point(b), dt = views[b].tick - views[a].tick;
		return [(pb[0] - pa[0]) / dt, (pb[1] - pa[1]) / dt, (pb[2] - pa[2]) / dt];
	};
	const h = views[i + 1].tick - views[i].tick;
	const p0 = point(i), p1 = point(i + 1), v0 = velocity(i), v1 = velocity(i + 1);
	const f2 = f * f, f3 = f2 * f;
	const c0 = 2 * f3 - 3 * f2 + 1, c1 = (f3 - 2 * f2 + f) * h, c2 = -2 * f3 + 3 * f2, c3 = (f3 - f2) * h;
	return [0, 1, 2].map(k => p0[k] * c0 + v0[k] * c1 + p1[k] * c2 + v1[k] * c3) as Vec3;
}

// the pitch and yaw the user commands aimed at a (fractional) tick, from the
// commands either side of it a tick apart (none where they aren't)
function cmdAim(cmds: UserCmd[], tick: number): [number, number] | null {
	const i = lastAtOrBefore(cmds, Math.floor(tick));
	const c = cmds[i], n = cmds[i + 1];
	if (!c || c.tick !== Math.floor(tick)) return null;
	if (!n || n.tick !== c.tick + 1) return tick === c.tick ? [c.viewAngles[0], c.viewAngles[1]] : null;
	const f = tick - c.tick;
	return [lerp(c.viewAngles[0], n.viewAngles[0], f), lerpAngle(c.viewAngles[1], n.viewAngles[1], f)];
}

export function cmdAt(track: SegmentTrack, tick: number): UserCmd | null {
	const cmds = track.seg.userCmds;
	const i = lastAtOrBefore(cmds, Math.floor(tick));
	return i < 0 ? null : cmds[i];
}
