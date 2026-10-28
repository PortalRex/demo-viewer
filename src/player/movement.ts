// What the player's doing at each tick of a segment: on the ground or in the
// air, crouched, in a funnel, going through a portal. Exact from the
// recording player's networked flags where its entities are decoded (the 3D
// view decodes them); else told from how the view moves (in the air it
// falls under gravity) and the duck key, a good guess
import type {SegmentTrack} from './playback.ts';
import type {EntityTrack} from '../net/entities.ts';
import {Buttons} from '../core/usercmd.ts';

export const GROUND = 1, DUCKED = 2, FUNNEL = 4, PORTAL = 8;

export interface Movement {
	first: number;        // the segment's first tick (states[0])
	states: Uint8Array;   // a tick each: GROUND | DUCKED | FUNNEL | PORTAL
	exact: boolean;       // from the player's flags, not guessed
}

const GRAVITY = 600;      // units/s² (sv_gravity)
const STILL_Z = 20;       // |vertical speed| under this, not falling: on the ground
const FALLING_SLACK = 60; // units/s² off gravity still falling
const FL_ONGROUND = 1, FL_DUCKING = 2;
const NO_HANDLE = 2047;   // an empty entity handle's index

const cache = new WeakMap<SegmentTrack, {player: EntityTrack | null; m: Movement}>();
export function movement(track: SegmentTrack, player: EntityTrack | null = null): Movement {
	const had = cache.get(track);
	if (had && had.player === player) return had.m;
	const m = player ? fromFlags(track, player) ?? guessed(track) : guessed(track);
	cache.set(track, {player, m});
	return m;
}

export function stateAt(m: Movement, tick: number): number {
	return m.states[Math.max(0, Math.min(m.states.length - 1, Math.round(tick) - m.first))] ?? 0;
}

function empty(track: SegmentTrack): Uint8Array {
	return new Uint8Array(Math.max(1, track.seg.lastTick - track.seg.firstTick + 1));
}

// (portals: where the view jumped, a teleport)
function markPortals(track: SegmentTrack, states: Uint8Array) {
	const v = track.seg.views, first = track.seg.firstTick;
	for (let i = 1; i < v.length; i++) if (track.teleports[i]) states[v[i].tick - first] |= PORTAL;
}

function guessed(track: SegmentTrack): Movement {
	const {views, userCmds, intervalPerTick: dt, firstTick: first} = track.seg;
	const states = empty(track);
	// (vertical speed into each view; NaN across a teleport)
	const vz = new Float32Array(views.length).fill(NaN);
	for (let i = 1; i < views.length; i++) {
		const t = (views[i].tick - views[i - 1].tick) * dt;
		if (t > 0 && !track.teleports[i]) vz[i] = (views[i].origin[2] - views[i - 1].origin[2]) / t;
	}
	const inAir = (i: number) => {
		if (!Number.isFinite(vz[i])) return false;
		if (Math.abs(vz[i]) > STILL_Z) return true;
		// (at the top of a jump: slow, but slowing as gravity slows it)
		const j = Number.isFinite(vz[i + 1]) ? i + 1 : Number.isFinite(vz[i - 1]) ? i - 1 : -1;
		if (j < 0) return false;
		const a = (vz[Math.max(i, j)] - vz[Math.min(i, j)]) / ((views[Math.max(i, j)].tick - views[Math.min(i, j)].tick) * dt);
		return Math.abs(a + GRAVITY) < FALLING_SLACK;
	};
	let ci = 0;
	for (let i = 0; i < views.length; i++) {
		const from = i ? views[i - 1].tick + 1 : first;
		const ground = !inAir(i);
		for (let tick = from; tick <= views[i].tick; tick++) {
			while (ci + 1 < userCmds.length && userCmds[ci + 1].tick <= tick) ci++;
			const c = userCmds[ci];
			const ducked = !!c && c.tick <= tick && tick - c.tick <= 2 && (c.buttons & Buttons.DUCK) !== 0;
			states[tick - first] = (ground ? GROUND : 0) | (ducked ? DUCKED : 0);
		}
	}
	markPortals(track, states);
	return {first, states, exact: false};
}

function fromFlags(track: SegmentTrack, player: EntityTrack): Movement | null {
	const first = track.seg.firstTick;
	const keys = player.keys.filter(k => k.extra?.m_fFlags !== undefined);
	if (!keys.length) return null;
	const states = empty(track);
	let ki = 0;
	for (let i = 0; i < states.length; i++) {
		const tick = first + i;
		while (ki + 1 < keys.length && keys[ki + 1].tick <= tick) ki++;
		const k = keys[ki];
		const flags = Number(k.extra!.m_fFlags);
		const beam = Number(k.extra?.['m_PortalLocal.m_hTractorBeam'] ?? NaN);
		const funnel = Number.isFinite(beam) && beam >= 0 && (beam & NO_HANDLE) !== NO_HANDLE;
		states[i] = (flags & FL_ONGROUND ? GROUND : 0) | (flags & FL_DUCKING ? DUCKED : 0) | (funnel ? FUNNEL : 0);
	}
	markPortals(track, states);
	return {first, states, exact: true};
}
