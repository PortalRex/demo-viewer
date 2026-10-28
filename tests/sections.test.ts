// Section times and routes on made-up runs along the same corridor (and
// one that goes another way)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Playback} from '../src/player/playback.ts';
import {routes, sections, sectionTimes} from '../src/player/sections.ts';
import type {RunPath} from '../src/player/sections.ts';
import {run, segment, views} from './make.ts';
import type {Vec3} from '../src/core/model.ts';

// a run along x from 0 to 3000 units at `speed` units a tick (bending off
// to y where `via` says), starting at tick 0
function path(speed: number, via: (x: number) => number = () => 0): RunPath {
	const end = Math.ceil(3000 / speed);
	const track = new Playback(run([segment(views(0, end, 1, t => {
		const x = Math.min(3000, t * speed);
		return [x, via(x), 0] as Vec3;
	}))])).tracks[0];
	return {track, start: 0, end};
}

test("each run's time at each gate, its sections and the sum of the best", () => {
	// (the shown run steady; one fast then slow; one slow then fast)
	const steady = path(5);
	const fastSlow = {...path(5), track: new Playback(run([segment(views(0, 600, 1, t => [t < 200 ? t * 7.5 : 1500 + (t - 200) * 3.75, 0, 0] as Vec3))])).tracks[0], end: 600};
	const s = sections([steady, fastSlow])!;
	assert.ok(s.gates.length >= 3);
	assert.ok(s.gates.length <= 13);
	// (the finish last, at its end)
	assert.equal(s.gates[s.gates.length - 1].tick, steady.end);
	for (const a of s.arrivals) for (let i = 1; i < a.length; i++) assert.ok(a[i] > a[i - 1]);
	const {times, best, sumOfBest} = sectionTimes(s);
	assert.equal(times.length, 2);
	// (the fast-then-slow run has the best early sections, the steady one the late ones)
	assert.ok(times[1][0] < times[0][0]);
	assert.ok(times[0][times[0].length - 1] < times[1][times[1].length - 1]);
	assert.ok(Math.abs(sumOfBest - best.reduce((n, t) => n + t, 0)) < 1e-9);
	assert.ok(sumOfBest < 10);  // (both runs take 10 s)
});

test('gates only where every run passes: none in the middle of a detour', () => {
	// (the other run detours far off the shown one's line in the middle)
	const s = sections([path(5), path(5, x => (x > 1000 && x < 2000 ? 600 : 0))]);
	// (no gate in the detour, away from where it leaves and rejoins: every run passes each gate)
	assert.ok(s!.gates.every(g => g.pos[0] <= 1100 || g.pos[0] >= 1900));
	assert.ok(s!.arrivals[1].every(Number.isFinite));
});

test('runs along the same corridor are one route; one that goes another way, its own', () => {
	const groups = routes([path(5), path(4), path(6, x => 20 * Math.sin(x / 300)), path(5, x => (x > 800 && x < 2400 ? 700 : 0))]);
	assert.deepEqual(groups, [0, 0, 0, 1]);
});
