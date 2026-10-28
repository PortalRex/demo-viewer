// Tricks found in made-up movement: a hop off a landing, a fling out of a
// portal, portal placements and a speed peak
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Playback} from '../src/player/playback.ts';
import {tricks} from '../src/player/tricks.ts';
import {Buttons} from '../src/core/usercmd.ts';
import {cmds, run, segment, views} from './make.ts';
import type {Vec3} from '../src/core/model.ts';

const track = (seg: ReturnType<typeof segment>) => new Playback(run([seg])).tracks[0];

// standing, then a jump at `jump`, falling back to the floor; jumped again
// the tick after landing where `hopAt` says
function jumping(jumps: number[]): (tick: number) => Vec3 {
	return tick => {
		let z = 0;
		for (const j of jumps) {
			const dt = (tick - j) / 60;
			if (dt > 0) z = Math.max(z, 230 * dt - 300 * dt * dt);  // ~0.77 s in the air
		}
		return [tick * 3, 0, z];
	};
}

test('a jump straight off a landing is a hop; a chain is counted', () => {
	const at = jumping([60, 107, 154]);
	const seg = segment(views(0, 300, 1, at), {userCmds: cmds(0, 300, t => ([60, 107, 154].includes(t) ? Buttons.JUMP : 0))});
	const hops = tricks(track(seg)).filter(t => t.kind === 'bhop');
	assert.equal(hops.length, 1);
	assert.equal(hops[0].label, 'Bhop ×2');
});

test('a jump after standing a while is no hop', () => {
	const at = jumping([60, 200]);
	const seg = segment(views(0, 300, 1, at), {userCmds: cmds(0, 300, t => ([60, 200].includes(t) ? Buttons.JUMP : 0))});
	assert.equal(tricks(track(seg)).filter(t => t.kind === 'bhop').length, 0);
});

test('fast out of a portal is a fling; fast without one, a peak', () => {
	// slow, through a portal at tick 100 (a jump across the map), then 15 units a tick (900 u/s)
	const at = (t: number): Vec3 => (t < 100 ? [t * 2, 0, 0] : [5000 + (t - 100) * 15, 0, 0]);
	const found = tricks(track(segment(views(0, 200, 1, at))));
	const fling = found.find(t => t.kind === 'fling');
	assert.equal(fling?.tick, 100);
	assert.match(fling!.label, /^Fling 900 u\/s$/);
	assert.equal(found.filter(t => t.kind === 'peak').length, 1);
});

test("SAR's portal placements, once each; else the fire buttons", () => {
	const flat = views(0, 200, 1, t => [t, 0, 0]);
	// (one placed again every two ticks, as on a moving surface, counted once)
	const placed = [10, 100, 102, 104, 106].map(tick => ({tick, kind: 'portal' as const, slot: 0, orange: tick > 10, pos: [tick, 0, 0] as Vec3}));
	assert.deepEqual(tricks(track(segment(flat, {sar: placed}))).filter(t => t.kind === 'portal').map(t => [t.tick, t.label]), [[10, 'Blue portal'], [100, 'Orange portal']]);
	const fired = tricks(track(segment(flat, {userCmds: cmds(0, 200, t => (t >= 50 && t < 55 ? Buttons.ATTACK : t === 80 ? Buttons.ATTACK2 : 0))})));
	assert.deepEqual(fired.filter(t => t.kind === 'portal').map(t => [t.tick, t.label]), [[50, 'Blue shot'], [80, 'Orange shot']]);
});
