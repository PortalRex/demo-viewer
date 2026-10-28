// Where the view is between views: straight a tick apart, along an eased
// curve where views come every few ticks, and never across a teleport
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Playback, viewAt} from '../src/player/playback.ts';
import {cmds, run, segment, views} from './make.ts';

const near = (a: number[], b: number[], within = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) <= within);

test('views a tick apart are kept as recorded, and straight between', () => {
	const track = new Playback(run([segment(views(0, 100, 1, t => [t * t / 4, 0, 0]))])).tracks[0];
	assert.ok(near(viewAt(track, 50)!.origin, [625, 0, 0]));
	assert.ok(near(viewAt(track, 50.5)!.origin, [(625 + 650.25) / 2, 0, 0]));
});

test('steady movement stays steady between sparse views', () => {
	const track = new Playback(run([segment(views(0, 300, 3, t => [t * 4, 100, 0]))])).tracks[0];
	for (const tick of [30, 31, 31.5, 32, 150.25]) assert.ok(near(viewAt(track, tick)!.origin, [tick * 4, 100, 0]), `tick ${tick}`);
});

test("sparse, unevenly timed views move more evenly than straight between them", () => {
	// steady movement, a view every 3 ticks, but each one where the player
	// was up to a tick off then, as a client's snapshots are
	const jitter = [0, 0.8, -0.6, 0.3, -0.9, 0.5, -0.2];
	const v = views(0, 300, 3, t => [t * 6, 0, 0]).map((f, i) => ({...f, origin: [(f.tick + jitter[i % jitter.length]) * 6, 0, 0] as [number, number, number]}));
	const track = new Playback(run([segment(v)])).tracks[0];
	const unevenness = (pos: (t: number) => number) => {
		let sum = 0;
		for (let t = 20; t < 280; t++) sum += Math.abs(pos(t + 1) - 2 * pos(t) + pos(t - 1));
		return sum;
	};
	const straight = (t: number) => {
		const i = v.findIndex(f => f.tick > t) - 1;
		const a = v[i], b = v[i + 1];
		return a.origin[0] + (b.origin[0] - a.origin[0]) * (t - a.tick) / (b.tick - a.tick);
	};
	assert.ok(unevenness(t => viewAt(track, t)!.origin[0]) < unevenness(straight) * 0.75);
});

test('no curve across a teleport', () => {
	const at = (t: number): [number, number, number] => (t < 60 ? [t * 3, 0, 0] : [9000 + t * 3, 0, 0]);
	const track = new Playback(run([segment(views(0, 120, 3, at))])).tracks[0];
	// (up to the teleport, where it was; after, from where it came out)
	assert.ok(near(viewAt(track, 58)!.origin, [57 * 3, 0, 0]));
	assert.ok(near(viewAt(track, 61)!.origin, [9000 + 61 * 3, 0, 0], 1));
});

test("between sparse views, the aim is each tick's user command's", () => {
	const seg = segment(views(0, 90, 3, t => [t, 0, 0], () => [0, 0, 0]), {userCmds: cmds(0, 90, () => 0, t => [t / 10, t, 0])});
	const track = new Playback(run([seg])).tracks[0];
	const v = viewAt(track, 31)!;
	assert.ok(near([v.angles[0], v.angles[1]], [3.1, 31]));
});
