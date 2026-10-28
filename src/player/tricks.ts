// Moments worth jumping to in a segment, found from its views and inputs:
// bunny hops (a jump straight off a landing, chains counted), flings (fast
// out of a portal), portal placements (SAR's, else the fire buttons) and
// speed peaks. Rough where a demo has a view every few ticks (a co-op
// client's), and a guide rather than a judgement
import type {SegmentTrack} from './playback.ts';
import type {SarEvent} from '../core/model.ts';
import {Buttons} from '../core/usercmd.ts';

export type TrickKind = 'bhop' | 'fling' | 'portal' | 'peak';
export interface Trick {
	tick: number;
	kind: TrickKind;
	label: string;
	color: string;
}

export const TRICK_COLORS: Record<TrickKind, string> = {bhop: '#9be34a', fling: '#d45cff', portal: '#3f9bff', peak: '#ffd84a'};
const ORANGE = '#ff8a1f';

const JUMP_SPEED = 120;     // rising faster than this (u/s) just after a jump: left the ground
const STILL_Z = 20;         // |vertical speed| below this: on the ground
const FALLING = -60;        // and below this before: came down onto it
const HOP_GROUND = 3;       // at most this many ticks on the ground between: a hop
const CHAIN_GAP = 1.5;      // seconds between hops of one chain
const FLING_SPEED = 700;    // out of a portal this fast: a fling
const PEAK_SPEED = 800;     // speed peaks above this, at most one a second
const REPORTED_AGAIN = 0.25; // seconds: a portal placed again this soon is the same one

const found = new WeakMap<SegmentTrack, Trick[]>();
export function tricks(track: SegmentTrack): Trick[] {
	let list = found.get(track);
	if (!list) {
		list = [...hops(track), ...flings(track), ...portals(track), ...peaks(track)].sort((a, b) => a.tick - b.tick);
		found.set(track, list);
	}
	return list;
}

// (vertical speed between each view and the one before; NaN across a teleport)
function verticalSpeeds(track: SegmentTrack): Float32Array {
	const v = track.seg.views, out = new Float32Array(v.length).fill(NaN);
	for (let i = 1; i < v.length; i++) {
		const dt = (v[i].tick - v[i - 1].tick) * track.seg.intervalPerTick;
		if (dt > 0 && !track.teleports[i]) out[i] = (v[i].origin[2] - v[i - 1].origin[2]) / dt;
	}
	return out;
}

function hops(track: SegmentTrack): Trick[] {
	const v = track.seg.views, cmds = track.seg.userCmds, vz = verticalSpeeds(track);
	const jumpNear = (tick: number) => cmds.some(c => c.tick >= tick - 3 && c.tick <= tick && (c.buttons & Buttons.JUMP));
	const hopTicks: number[] = [];
	for (let i = 2; i < v.length; i++) {
		if (!(vz[i] > JUMP_SPEED && Math.abs(vz[i - 1]) <= STILL_Z) || !jumpNear(v[i].tick)) continue;
		// back over the ground before the jump, to how it got there
		let g = i - 1;
		while (g > 1 && Math.abs(vz[g - 1]) <= STILL_Z) g--;
		if (v[i - 1].tick - v[g].tick <= HOP_GROUND && vz[g - 1] < FALLING) hopTicks.push(v[g].tick);
	}
	const out: Trick[] = [];
	let chain: {tick: number; n: number; last: number} | null = null;
	const close = () => chain && out.push({tick: chain.tick, kind: 'bhop', label: chain.n > 1 ? `Bhop ×${chain.n}` : 'Bhop', color: TRICK_COLORS.bhop});
	for (const tick of hopTicks) {
		if (chain && (tick - chain.last) * track.seg.intervalPerTick <= CHAIN_GAP) {
			chain.n++;
			chain.last = tick;
		} else {
			close();
			chain = {tick, n: 1, last: tick};
		}
	}
	close();
	return out;
}

function flings(track: SegmentTrack): Trick[] {
	const v = track.seg.views, out: Trick[] = [];
	for (let i = 1; i < v.length; i++) {
		if (!track.teleports[i]) continue;
		let top = 0;
		for (let j = i + 1; j < Math.min(v.length, i + 10); j++) top = Math.max(top, track.speeds[j]);
		if (top > FLING_SPEED) out.push({tick: v[i].tick, kind: 'fling', label: `Fling ${Math.round(top)} u/s`, color: TRICK_COLORS.fling});
	}
	return out;
}

function portals(track: SegmentTrack): Trick[] {
	const placed = track.seg.sar.filter((e): e is Extract<SarEvent, {kind: 'portal'}> => e.kind === 'portal');
	if (placed.length) {
		// (a portal reported again and again, as one on a moving surface is
		// every tick or two, counted once)
		const last = new Map<string, number>();
		const again = REPORTED_AGAIN / track.seg.intervalPerTick;
		return placed.filter(e => {
			const key = `${e.slot}:${e.orange}`, was = last.get(key);
			last.set(key, e.tick);
			return was === undefined || e.tick - was > again;
		}).map(e => ({tick: e.tick, kind: 'portal', label: e.orange ? 'Orange portal' : 'Blue portal', color: e.orange ? ORANGE : TRICK_COLORS.portal}));
	}
	// (no SAR data: each press of a fire button)
	const out: Trick[] = [];
	let was = 0;
	for (const c of track.seg.userCmds) {
		const pressed = c.buttons & ~was;
		if (pressed & Buttons.ATTACK) out.push({tick: c.tick, kind: 'portal', label: 'Blue shot', color: TRICK_COLORS.portal});
		if (pressed & Buttons.ATTACK2) out.push({tick: c.tick, kind: 'portal', label: 'Orange shot', color: ORANGE});
		was = c.buttons;
	}
	return out;
}

function peaks(track: SegmentTrack): Trick[] {
	const v = track.seg.views, s = track.speeds, out: Trick[] = [];
	const window = 1 / track.seg.intervalPerTick;  // a second, in ticks
	for (let i = 1; i < v.length - 1; i++) {
		if (s[i] < PEAK_SPEED || track.teleports[i]) continue;
		let highest = true;
		for (let j = i - 1; j >= 0 && v[i].tick - v[j].tick <= window && highest; j--) highest = s[j] < s[i];
		for (let j = i + 1; j < v.length && v[j].tick - v[i].tick <= window && highest; j++) highest = s[j] <= s[i];
		if (highest) out.push({tick: v[i].tick, kind: 'peak', label: `${Math.round(s[i])} u/s`, color: TRICK_COLORS.peak});
	}
	return out;
}
