// How well a run air strafes: at each tick in the air, the speed its inputs
// gained against the most the best strafe (any direction, full input) could
// have gained from the same speed. Portal 2's air movement as SAR's TAS
// strafer models it: a wish direction from the movement keys and yaw
// (forward tilted away past 30° of pitch), acceleration of
// sv_paintairacceleration (5) × wish speed (175) a second, adding speed only
// up to 60 along the wish direction; over 300 u/s, nothing against the way
// it's going on an axis it's moving 150 u/s along (the air control limit);
// ducked, a quarter the wish speed (measured on board demos). The command at
// a tick moves the player from the view before to the view at it.
//
// Ticks are counted only where the model explains the motion (within a few
// u/s): a wall, a cube or a button's push isn't the strafing's doing. A view
// is needed every tick (a host's recording; a co-op client's, every few
// ticks, can't be told).
import type {SegmentTrack} from './playback.ts';
import type {Movement} from './movement.ts';
import {GROUND, DUCKED, FUNNEL, PORTAL, stateAt} from './movement.ts';
import type {UserCmd} from '../core/model.ts';

const MOVE_SPEED = 175;     // cl_forwardspeed / cl_sidespeed, and the player's max speed
const AIR_ACCEL = 5;        // sv_paintairacceleration
const AIR_CAP = 60;         // wish speed in the air, at most
const AIR_LOCK = 300;       // faster than this: the air control limit
const DUCK_WISH = 0.25;     // ducked, of the wish speed
const PITCH_TILT = 30;      // degrees of pitch past which forward tilts
const EXPLAINED = 3;        // units/s: the model within this of the motion
const SEARCH = 120;         // directions tried for the best strafe (then refined)

export interface Strafe {
	first: number;          // the segment's first tick (index 0)
	gained: Float32Array;   // per tick, u/s of horizontal speed gained (NaN: not counted)
	ideal: Float32Array;    // and the most the best strafe could have
	keys: Uint8Array;       // 1 where a strafe key (left or right) was held
}

type V2 = [number, number];

// the horizontal velocity after one tick of air acceleration towards `wish`
// (a vector of length up to 1, the keys' share of full speed)
export function accelerate(v: V2, wish: V2, dt: number, ducked: boolean): V2 {
	let [wx, wy] = wish;
	// (the air control limit)
	if (Math.hypot(v[0], v[1]) > AIR_LOCK) {
		if (Math.abs(v[0]) > AIR_LOCK / 2 && Math.sign(v[0]) * wx < 0) wx = 0;
		if (Math.abs(v[1]) > AIR_LOCK / 2 && Math.sign(v[1]) * wy < 0) wy = 0;
	}
	const length = Math.hypot(wx, wy);
	if (!length) return v;
	const wishSpeed = Math.min(MOVE_SPEED, length * MOVE_SPEED) * (ducked ? DUCK_WISH : 1);
	const nx = wx / length, ny = wy / length;
	const room = Math.min(AIR_CAP, wishSpeed) - (v[0] * nx + v[1] * ny);
	if (room <= 0) return v;
	const add = Math.min(AIR_ACCEL * dt * wishSpeed, room);
	return [v[0] + nx * add, v[1] + ny * add];
}

// a command's wish direction, in the world
export function wishOf(c: UserCmd): V2 {
	let side = c.sideMove / MOVE_SPEED, forward = c.forwardMove / MOVE_SPEED;
	const length = Math.hypot(side, forward);
	if (length > 1) {
		side /= length;
		forward /= length;
	}
	if (Math.abs(c.viewAngles[0]) >= PITCH_TILT) forward *= Math.cos(c.viewAngles[0] * Math.PI / 180);
	const yaw = c.viewAngles[1] * Math.PI / 180;
	return [Math.sin(yaw) * side + Math.cos(yaw) * forward, -Math.cos(yaw) * side + Math.sin(yaw) * forward];
}

// the most speed a tick's strafe could add (full input, the best direction)
export function bestGain(v: V2, dt: number, ducked: boolean): number {
	const speed = Math.hypot(v[0], v[1]);
	const gain = (a: number) => {
		const after = accelerate(v, [Math.cos(a), Math.sin(a)], dt, ducked);
		return Math.hypot(after[0], after[1]) - speed;
	};
	let best = -Infinity, bestA = 0;
	for (let k = 0; k < SEARCH; k++) {
		const a = (k / SEARCH) * 2 * Math.PI, g = gain(a);
		if (g > best) {
			best = g;
			bestA = a;
		}
	}
	const step = (2 * Math.PI) / SEARCH;
	for (let a = bestA - step; a <= bestA + step; a += step / 24) best = Math.max(best, gain(a));
	return Math.max(0, best);
}

const cache = new WeakMap<SegmentTrack, {move: Movement; s: Strafe | null}>();
export function strafe(track: SegmentTrack, move: Movement): Strafe | null {
	const had = cache.get(track);
	if (had && had.move === move) return had.s;
	const s = analyse(track, move);
	cache.set(track, {move, s});
	return s;
}

function analyse(track: SegmentTrack, move: Movement): Strafe | null {
	const {views, userCmds, intervalPerTick: dt, firstTick: first} = track.seg;
	// (a view every tick, mostly: else there's nothing to tell it from)
	const everyTick = views.filter((v, i) => i > 0 && v.tick - views[i - 1].tick === 1).length;
	if (views.length < 3 || everyTick < views.length * 0.8) return null;
	const n = Math.max(1, track.seg.lastTick - first + 1);
	const s: Strafe = {first, gained: new Float32Array(n).fill(NaN), ideal: new Float32Array(n).fill(NaN), keys: new Uint8Array(n)};
	const cmds = new Map(userCmds.map(c => [c.tick, c]));
	const velocity = (i: number): V2 => [(views[i].origin[0] - views[i - 1].origin[0]) / dt, (views[i].origin[1] - views[i - 1].origin[1]) / dt];
	for (let i = 2; i < views.length; i++) {
		const t = views[i].tick, c = cmds.get(t);
		if (!c || views[i - 1].tick !== t - 1 || views[i - 2].tick !== t - 2 || track.teleports[i] || track.teleports[i - 1]) continue;
		const before = stateAt(move, t - 1), now = stateAt(move, t);
		if ((before | now) & (GROUND | FUNNEL | PORTAL)) continue;
		const v0 = velocity(i - 1), v1 = velocity(i);
		if (Math.hypot(v0[0], v0[1]) < 1) continue;
		// (ducked or not: the flags say, else whichever explains the motion)
		const wish = wishOf(c);
		const off = (ducked: boolean) => {
			const p = accelerate(v0, wish, dt, ducked);
			return Math.hypot(p[0] - v1[0], p[1] - v1[1]);
		};
		const ducked = move.exact ? (now & DUCKED) !== 0 : (now & DUCKED) !== 0 && off(true) < off(false);
		if (off(ducked) > EXPLAINED) continue;
		const gained = Math.hypot(v1[0], v1[1]) - Math.hypot(v0[0], v0[1]);
		s.gained[t - first] = gained;
		s.ideal[t - first] = Math.max(gained, bestGain(v0, dt, ducked));
		s.keys[t - first] = c.sideMove ? 1 : 0;
	}
	return s;
}

// the strafing over some ticks (those a strafe key was held, or all in the
// air): speed gained of the most it could have, and how many ticks counted
export function strafeOver(s: Strafe, from: number, to: number, keyed = true): {gained: number; ideal: number; ticks: number} {
	let gained = 0, ideal = 0, ticks = 0;
	for (let t = Math.max(0, Math.ceil(from) - s.first); t <= Math.min(s.ideal.length - 1, Math.floor(to) - s.first); t++) {
		if (!Number.isFinite(s.ideal[t]) || (keyed && !s.keys[t])) continue;
		gained += s.gained[t];
		ideal += s.ideal[t];
		ticks++;
	}
	return {gained, ideal, ticks};
}
