// Movement states and air strafing in made-up runs: a player falling
// through the air moved by the strafe model itself, strafing as well as it
// can or holding a key without turning
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Playback} from '../src/player/playback.ts';
import {movement, stateAt, GROUND, PORTAL} from '../src/player/movement.ts';
import {accelerate, bestGain, strafe, strafeOver, wishOf} from '../src/player/strafe.ts';
import {INTERVAL, cmds, run, segment} from './make.ts';
import type {UserCmd, Vec3, ViewFrame} from '../src/core/model.ts';

const track = (seg: ReturnType<typeof segment>) => new Playback(run([seg])).tracks[0];

// a minute on the ground, then off a ledge at `speed`: each tick's command
// from `aim` (its yaw, holding right), the motion as the model has it
function flight(aim: (v: [number, number]) => number, ticks = 120) {
	const out: ViewFrame[] = [];
	const commands = cmds(0, 60 + ticks, () => 0);
	let p: Vec3 = [0, 0, 1000], v: [number, number] = [200, 0], vz = 0;
	for (let tick = 0; tick <= 60 + ticks; tick++) {
		if (tick > 60) {
			const c: UserCmd = commands[tick];
			c.sideMove = 175;
			c.viewAngles = [0, aim(v), 0];
			v = accelerate(v, wishOf(c), INTERVAL, false);
			vz -= 600 * INTERVAL;
		}
		p = [p[0] + v[0] * INTERVAL, p[1] + v[1] * INTERVAL, p[2] + (tick > 60 ? vz * INTERVAL : 0)];
		out.push({tick, origin: p, angles: [0, tick > 60 ? aim(v) : 0, 0]});
	}
	return segment(out, {userCmds: commands});
}

// the yaw whose right is the best direction to accelerate in
function bestYaw(v: [number, number]): number {
	let best = -Infinity, yaw = 0;
	for (let a = 0; a < 360; a += 0.05) {
		const after = accelerate(v, [Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180)], INTERVAL, false);
		const s = Math.hypot(...after);
		if (s > best) {
			best = s;
			yaw = a + 90;
		}
	}
	return yaw;
}

test('on the ground until the ledge, then in the air', () => {
	const tr = track(flight(() => 0));
	const m = movement(tr);
	assert.ok(stateAt(m, 30) & GROUND);
	assert.ok(!(stateAt(m, 90) & GROUND));
	assert.ok(!(stateAt(m, 90) & PORTAL));
});

test('the best strafe each tick scores all it could gain', () => {
	const tr = track(flight(bestYaw));
	const s = strafe(tr, movement(tr))!;
	const o = strafeOver(s, 0, 180);
	assert.ok(o.ticks > 100);
	assert.ok(o.gained / o.ideal > 0.99, `${o.gained} of ${o.ideal}`);
});

test('a key held without turning gains less', () => {
	const tr = track(flight(() => 0));
	const s = strafe(tr, movement(tr))!;
	const o = strafeOver(s, 0, 180);
	assert.ok(o.ticks > 100);
	assert.ok(o.gained / o.ideal < 0.6, `${o.gained} of ${o.ideal}`);
});

test('the best strafe at 200 u/s gains more than straight across', () => {
	const across = Math.hypot(200, 5 * INTERVAL * 175) - 200;
	assert.ok(bestGain([200, 0], INTERVAL, false) > across * 3);
});

test('views every few ticks can\'t be told', () => {
	const seg = flight(() => 0);
	seg.views = seg.views.filter(v => v.tick % 3 === 0);
	const tr = track(seg);
	assert.equal(strafe(tr, movement(tr)), null);
});
