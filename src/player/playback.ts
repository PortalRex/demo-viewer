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
	// a co-op client's recording: when each view really was (see retime);
	// null for a host's, whose views are a tick apart as stamped
	times: Float64Array | null;
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
			const times = retime(seg, teleports);
			if (times) smoothSpeeds(seg, teleports, times, speeds);
			this.tracks.push({seg, start, length, speeds, teleports, times});
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

// A co-op client's recording writes a view each frame of its own game, stamped
// with the tick of the last snapshot it had: with ping, several frames share a
// tick and the next skips one, or frames stamped 3 ticks apart moved 12, 6,
// 12, 6 units. Played by the stamps, the player lurches between fast and slow.
// So a client's views get times of their own: the stamps evened out over the
// few views either side (frames come evenly, their stamps don't), never
// across a teleport; and their path is fitted through them rather than drawn
// through each (see clientViewAt). A host's views (a tick apart, as stamped)
// are left as they are
const RETIME_SPAN = 3;   // views either side
const CLIENT_GAPS = 0.03; // views other than a tick apart, at least this share of them: a client's (a host's are 0-2%)
function retime(seg: Segment, teleports: Uint8Array): Float64Array | null {
	const v = seg.views;
	if (v.length < 2 * RETIME_SPAN + 2) return null;
	let uneven = 0;
	for (let i = 1; i < v.length; i++) if (v[i].tick - v[i - 1].tick !== 1) uneven++;
	if (uneven < (v.length - 1) * CLIENT_GAPS) return null;
	const times = new Float64Array(v.length);
	// (a stretch between teleports at a time)
	for (let s = 0; s < v.length;) {
		let e = s;
		while (e + 1 < v.length && !teleports[e + 1]) e++;
		for (let i = s; i <= e; i++) {
			// (the same span either side, short of the stretch's ends: the
			// stamps' mean then stays the view's own time on steady footing)
			const k = Math.min(RETIME_SPAN, i - s, e - i);
			let sum = 0;
			for (let j = i - k; j <= i + k; j++) sum += v[j].tick;
			times[i] = sum / (2 * k + 1);
		}
		// (in order, and never two at once)
		for (let i = s + 1; i <= e; i++) times[i] = Math.max(times[i], times[i - 1] + 1e-3);
		s = e + 1;
	}
	return times;
}

// a client's speeds from its views' worked-out times, across the views
// either side (a view's own step is too short a time to tell)
function smoothSpeeds(seg: Segment, teleports: Uint8Array, times: Float64Array, speeds: Float32Array) {
	const v = seg.views;
	for (let i = 1; i < v.length - 1; i++) {
		if (teleports[i] || teleports[i + 1]) continue;
		const a = v[i - 1].origin, b = v[i + 1].origin;
		const dt = (times[i + 1] - times[i - 1]) * seg.intervalPerTick;
		if (dt > 0) speeds[i] = Math.hypot(b[0] - a[0], b[1] - a[1]) / dt;
	}
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
	if (track.times) return clientViewAt(track, track.times, tick);
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

// A client's view at a tick: where its path is there, fitted to the views
// around it by their worked-out times (see retime) as a straight line,
// weighted by how near in time each is (Gaussian, about a view's spacing
// wide), so the samples' unevenness averages out while steady motion keeps
// its speed with no lag; never across a teleport. Aimed as that tick's user
// command aims, which a client records every tick, exactly (the views' own
// aim where there's none)
const FIT_WIDTH = 1.2;   // the weights' width, in mean view spacings
function clientViewAt(track: SegmentTrack, times: Float64Array, tick: number): ViewState {
	const views = track.seg.views;
	let lo = 0, hi = views.length - 1, i = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= tick) {
			i = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	const at = Math.max(0, i);
	// (the stretch it's in: the views between teleports around it; a tick
	// past a teleport's view belongs to the stretch it starts)
	let s = at, e = at;
	while (s > 0 && !track.teleports[s]) s--;
	while (e + 1 < views.length && !track.teleports[e + 1]) e++;
	const n = e - s + 1;
	const spacing = n > 1 ? (times[e] - times[s]) / (n - 1) : 1;
	const width = Math.max(1, spacing * FIT_WIDTH);
	let sw = 0, st = 0;
	const sp = [0, 0, 0];
	for (let j = at; j >= s && tick - times[j] < 3 * width; j--) visit(j);
	for (let j = at + 1; j <= e && times[j] - tick < 3 * width; j++) visit(j);
	function visit(j: number) {
		const d = (times[j] - tick) / width, w = Math.exp(-0.5 * d * d);
		sw += w;
		st += w * times[j];
		for (let k = 0; k < 3; k++) sp[k] += w * views[j].origin[k];
	}
	let origin: Vec3 = views[at].origin;
	if (sw > 0) {
		const tm = st / sw;
		const pm = sp.map(x => x / sw);
		// (the slope from the same views; flat where there's only the one)
		let stt = 0;
		const stp = [0, 0, 0];
		for (let j = s; j <= e; j++) {
			const d = (times[j] - tick) / width;
			if (Math.abs(d) >= 3) continue;
			const w = Math.exp(-0.5 * d * d), dt = times[j] - tm;
			stt += w * dt * dt;
			for (let k = 0; k < 3; k++) stp[k] += w * dt * (views[j].origin[k] - pm[k]);
		}
		origin = [0, 1, 2].map(k => pm[k] + (stt > 1e-9 ? stp[k] / stt : 0) * (tick - tm)) as Vec3;
	}
	const a = views[at], b = views[at + 1];
	const f = b && at + 1 <= e ? Math.min(1, Math.max(0, (tick - times[at]) / (times[at + 1] - times[at]))) : 0;
	const own: Vec3 = b && at + 1 <= e ? [lerp(a.angles[0], b.angles[0], f), lerpAngle(a.angles[1], b.angles[1], f), lerp(a.angles[2], b.angles[2], f)] : a.angles;
	const aim = cmdAim(track.seg.userCmds, tick);
	return {
		origin,
		angles: aim ? [aim[0], aim[1], own[2]] : own,
		speed: b && at + 1 <= e ? lerp(track.speeds[at], track.speeds[at + 1], f) : track.speeds[at],
		viewIndex: at,
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
