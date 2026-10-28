// The ghost race's lining up: board names, finishes, the other run's tick
// at a moment of this one, and how far ahead or behind it is
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Playback} from '../src/player/playback.ts';
import {alignedTick, boardRun, finishOf, gapAt, sameBoardRun, trackOnSameMap} from '../src/player/race.ts';
import {finished, run, segment, views} from './make.ts';

test('board demo names: a co-op run is the same map and time, ids one apart', () => {
	assert.deepEqual(boardRun('Buttons_1756_76561198048179892_304460.dem'), {map: 'buttons', time: '1756', id: 304460});
	assert.equal(boardRun('my run.dem'), null);
	assert.ok(sameBoardRun('Buttons_1756_76561198048179892_304460.dem', 'Buttons_1756_76561198823602829_304459.dem'));
	assert.ok(!sameBoardRun('Buttons_1756_76561198048179892_304460.dem', 'Buttons_1756_76561198823602829_304470.dem'));
	assert.ok(!sameBoardRun('Buttons_1756_76561198048179892_304460.dem', 'Buttons_1760_76561198823602829_304459.dem'));
	assert.ok(!sameBoardRun(null, 'Buttons_1756_76561198823602829_304459.dem'));
});

test("a finish from SAR's timer, else the board name's time", () => {
	const timed = segment(views(0, 600, 1, () => [0, 0, 0]), {sar: [finished(550, 500)]});
	assert.deepEqual(finishOf(timed, run([timed])), {tick: 550, ticks: 500});
	// (challenge mode flags only: the time from the name, 9.95 s at 60 ticks a second)
	const flagged = segment(views(0, 700, 1, () => [0, 0, 0]), {sar: [{tick: 650, kind: 'cmFlags', slot: 0}]});
	assert.deepEqual(finishOf(flagged, run([flagged], 'FizzlerIntro_995_76561198099281433_346528.dem')), {tick: 650, ticks: 597});
	assert.equal(finishOf(segment(views(0, 10, 1, () => [0, 0, 0])), run([])), null);
});

test('runs line up from where their timers started', () => {
	// this run's timer starts at tick 100 (finish 600 after 500), the other's at 40 (finish 640 after 600)
	const own = segment(views(0, 700, 1, () => [0, 0, 0]), {sar: [finished(600, 500)]});
	const other = segment(views(0, 700, 1, () => [0, 0, 0]), {sar: [finished(640, 600)]});
	const a = new Playback(run([own])), b = new Playback(run([other]));
	const loc = a.locate(a.tracks[0].start + 200);  // this run's tick 200: 100 ticks into its timer
	const track = trackOnSameMap(a, b, loc)!;
	assert.equal(alignedTick(loc, a.run, track, b.run), 140);
	// (without finishes: from where each segment starts)
	assert.equal(alignedTick(loc, null, track, null), 200);
});

test("a run's gap: ahead where it was at this spot earlier, behind where later", () => {
	// the other player walks along x at 5 units a tick
	const other = new Playback(run([segment(views(0, 600, 1, t => [t * 5, 0, 0]))])).tracks[0];
	// it's at tick 300 of its run; this player is where it was at tick 240: it's a second ahead
	const ahead = gapAt([1200, 0, 0], other, 300)!;
	assert.ok(Math.abs(ahead.delta - 1) < 1e-9);
	assert.equal(ahead.tick, 240);
	// where it gets to at 330: half a second behind
	assert.ok(Math.abs(gapAt([1650, 0, 0], other, 300)!.delta + 0.5) < 1e-9);
	// somewhere it never went
	assert.equal(gapAt([0, 5000, 0], other, 300), null);
	// matched only within the ticks given
	assert.equal(gapAt([1200, 0, 0], other, 300, [280, 320])!.tick, 280);
});
