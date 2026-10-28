// Small made-up runs for the tests: a segment of views (and user commands)
// built from a function of the tick, so each test says only what matters
import type {Run, SarEvent, Segment, UserCmd, Vec3, ViewFrame} from '../src/core/model.ts';

export const INTERVAL = 1 / 60;

export function segment(views: ViewFrame[], extra: Partial<Segment> = {}): Segment {
	return {
		index: 0, map: 'sp_test', startedMidMap: false, intervalPerTick: INTERVAL,
		firstTick: views[0]?.tick ?? 0, lastTick: views[views.length - 1]?.tick ?? 0,
		views, userCmds: [], consoleCmds: [], sar: [], net: [], ...extra,
	};
}

// a view every `every` ticks from `from` to `to`, where `at(tick)` says
export function views(from: number, to: number, every: number, at: (tick: number) => Vec3, angles: (tick: number) => Vec3 = () => [0, 0, 0]): ViewFrame[] {
	const out: ViewFrame[] = [];
	for (let tick = from; tick <= to; tick += every) out.push({tick, origin: at(tick), angles: angles(tick)});
	return out;
}

export function cmds(from: number, to: number, buttons: (tick: number) => number, angles: (tick: number) => Vec3 = () => [0, 0, 0]): UserCmd[] {
	const out: UserCmd[] = [];
	for (let tick = from; tick <= to; tick++) {
		out.push({tick, slot: 0, commandNumber: tick, viewAngles: angles(tick), forwardMove: 0, sideMove: 0, upMove: 0, buttons: buttons(tick), impulse: 0, mouseDx: 0, mouseDy: 0});
	}
	return out;
}

export function run(segments: Segment[], fileName = 'test.dem'): Run {
	return {format: 'dem', fileName, fileSize: 0, info: [], game: 'portal2', gameDir: 'portal2', player: 'tester', segments, warnings: []};
}

// SAR's timer finishing at a tick, having run for `ticks`
export function finished(tick: number, ticks: number): SarEvent {
	return {tick, kind: 'speedrunTime', complete: true, rules: [], splits: [{name: 'run', segments: [{name: 'run', ticks}]}]};
}
