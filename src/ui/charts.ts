// The run timeline (segments end to end) and the speed graph for the current
// segment. Both seek on click/drag.
import type {Playback, SegmentTrack} from '../player/playback.ts';
import {tricks} from '../player/tricks.ts';
import type {Trick} from '../player/tricks.ts';
import type {UserCmd} from '../core/model.ts';
import {Buttons} from '../core/usercmd.ts';
import {speedColor} from './pathview.ts';
import {fmtTime} from './panels.ts';
import {GROUND, DUCKED, FUNNEL, PORTAL} from '../player/movement.ts';
import type {Movement} from '../player/movement.ts';
import type {Strafe} from '../player/strafe.ts';
import {chamberStretches} from '../player/fullgame.ts';
import type {ChamberStretch} from '../player/fullgame.ts';

function prepare(c: HTMLCanvasElement) {
	const dpr = window.devicePixelRatio || 1;
	const w = c.clientWidth, h = c.clientHeight;
	if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
		c.width = Math.round(w * dpr);
		c.height = Math.round(h * dpr);
	}
	const g = c.getContext('2d')!;
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	return {g, w, h};
}

function seekOnDrag(c: HTMLCanvasElement, seek: (fraction: number) => void) {
	let down = false;
	const at = (e: PointerEvent) => {
		const r = c.getBoundingClientRect();
		seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
	};
	c.addEventListener('pointerdown', e => {
		down = true;
		c.setPointerCapture(e.pointerId);
		at(e);
	});
	c.addEventListener('pointermove', e => down && at(e));
	c.addEventListener('pointerup', () => (down = false));
}

const shortMap = (m: string) => m.replace(/^(sp|mp_coop)_a\d_/, '').replace(/^sp_/, '');

// The run's segments end to end, named by chamber: segments in a row on one
// map (a death, a save loaded) under one name, a chamber's time beside it
// where there's room (a full game's demos, back to back)
export class Timeline {
	private c: HTMLCanvasElement;
	private stretchesOf: Playback | null = null;
	private stretches: ChamberStretch[] = [];
	pb: Playback | null = null;

	constructor(c: HTMLCanvasElement, seek: (t: number) => void) {
		this.c = c;
		seekOnDrag(c, f => this.pb && seek(f * this.pb.total));
	}

	draw(t: number, current: number) {
		const {g, w, h} = prepare(this.c);
		g.clearRect(0, 0, w, h);
		if (!this.pb) return;
		const pb = this.pb, total = pb.total;
		const x = (tick: number) => (tick / total) * w;
		if (this.stretchesOf !== pb) {
			this.stretchesOf = pb;
			this.stretches = chamberStretches(pb.run);
		}
		const stretchOf = (i: number) => this.stretches.findIndex(c => i >= c.first && i <= c.last);
		pb.tracks.forEach((tr, i) => {
			const x0 = x(tr.start), x1 = x(tr.start + tr.length);
			const ci = stretchOf(i);
			g.fillStyle = i === current ? '#26405f' : ci === stretchOf(current) ? '#1f3048' : ci % 2 ? '#1d232c' : '#222934';
			// (a gap between chambers; within one, a hairline)
			g.fillRect(x0, 8, Math.max(1, x1 - x0 - (this.stretches[ci]?.last === i ? 1 : 0.4)), h - 16);

			// portal placements and pauses, and the other tricks (hops,
			// flings, speed peaks) along the top
			for (const e of tr.seg.sar) {
				if (e.kind !== 'portal' && e.kind !== 'pause') continue;
				const ex = x(tr.start + (e.tick - tr.seg.firstTick));
				g.fillStyle = e.kind === 'pause' ? '#e8b84a' : e.orange ? '#ff8a1f' : '#3f9bff';
				g.fillRect(ex, e.kind === 'pause' ? 8 : h - 12, 1.5, 4);
			}
			for (const k of tricks(tr)) {
				if (k.kind === 'portal') continue;
				g.fillStyle = k.color;
				g.fillRect(x(tr.start + (k.tick - tr.seg.firstTick)), 2, 1.5, 5);
			}
		});
		// each chamber's name (and time, where it fits) over its segments
		this.stretches.forEach((c, k) => {
			const a = pb.tracks[c.first], b = pb.tracks[c.last];
			const x0 = x(a.start), x1 = x(b.start + b.length);
			if (x1 - x0 <= 46) return;
			const name = this.stretches.length > 1 ? c.name : shortMap(c.map);
			g.fillStyle = k === stretchOf(current) ? '#e6e9ef' : '#8a93a3';
			g.font = '11px ui-monospace, Consolas, monospace';
			g.textAlign = 'left';
			g.save();
			g.beginPath();
			g.rect(x0, 0, x1 - x0 - 4, h);
			g.clip();
			const time = this.stretches.length > 1 ? `  ${fmtTime(c.seconds)}` : '';
			g.fillText(g.measureText(name + time).width < x1 - x0 - 10 ? name + time : name, x0 + 5, h / 2 + 4);
			g.restore();
		});

		const px = x(t);
		g.fillStyle = '#5aa9ff';
		g.fillRect(px - 1, 0, 2, h);
	}
}

// a raced run's lead or lag over the segment: seconds ahead of (+) or
// behind (−) this run at sampled ticks (NaN where it can't be told)
export interface GapLine {
	color: string;
	ticks: Float32Array;
	gaps: Float32Array;
}

// a run's inputs for the Inputs graph: its user command at a tick of this
// run's segment (lined up as the race lines it up), in its colour
export interface InputLane {
	name: string;
	color: string;
	cmd: (tick: number) => UserCmd | null;
	state?: (tick: number) => number;  // its movement (player/movement.ts)
}
// the keys the Inputs graph shows, a row each
const INPUT_KEYS: [string, (c: UserCmd) => boolean][] = [
	['W', c => (c.buttons & Buttons.FORWARD) !== 0 || c.forwardMove > 0],
	['A', c => (c.buttons & Buttons.MOVELEFT) !== 0 || c.sideMove < 0],
	['S', c => (c.buttons & Buttons.BACK) !== 0 || c.forwardMove < 0],
	['D', c => (c.buttons & Buttons.MOVERIGHT) !== 0 || c.sideMove > 0],
	['Jump', c => (c.buttons & Buttons.JUMP) !== 0],
	['Duck', c => (c.buttons & Buttons.DUCK) !== 0],
	['Use', c => (c.buttons & Buttons.USE) !== 0],
	['Blue', c => (c.buttons & Buttons.ATTACK) !== 0],
	['Orange', c => (c.buttons & Buttons.ATTACK2) !== 0],
];
// and below them, how the player was moving, a row each
const STATE_ROWS: [string, (s: number) => boolean][] = [
	['In air', s => !(s & GROUND)],
	['Crouch', s => (s & DUCKED) !== 0],
	['Funnel', s => (s & FUNNEL) !== 0],
];
// the movement lane along the bottom of the other graphs: on the ground,
// in the air or in a funnel; crouched a line over it; portals a mark
const LANE_H = 6;
const LANE_COLORS = {ground: '#2b3340', air: '#3d7fd1', funnel: '#3fd6c8', ducked: '#d45cff', portal: '#ffffff'};
const INPUT_WINDOW = 1.5;  // seconds either side of now the Inputs graph shows
const INPUT_LABELS = 46;   // pixels for the keys' names

// The current segment's speed, or how far ahead or behind each raced run is
// over it (Gap), with the segment's tricks marked along the top: clicking
// near one goes to it. Or (Inputs) the keys this run and another held, tick
// by tick, over the few seconds around now, and how each was moving; or
// (Strafe) how much speed each tick in the air gained of the most the best
// strafe could have. Along the bottom (but in Inputs), the movement lane
export class SpeedGraph {
	private track: SegmentTrack | null = null;
	private max = 400;
	private c: HTMLCanvasElement;
	private now = 0;  // the tick last drawn at
	mode: 'speed' | 'gap' | 'inputs' | 'strafe' = 'speed';
	tricks: Trick[] = [];
	move: Movement | null = null;
	strafe: Strafe | null = null;
	strafeNote = '';
	gaps: GapLine[] = [];
	lanes: InputLane[] = [];

	constructor(c: HTMLCanvasElement, seek: (fraction: number) => void) {
		this.c = c;
		seekOnDrag(c, f => seek(this.mode === 'inputs' ? this.inputsFraction(f) : this.snap(f) ?? f));
		c.addEventListener('pointermove', e => {
			const r = c.getBoundingClientRect();
			const near = this.trickNear((e.clientX - r.left) / r.width);
			c.title = near ? near.label : '';
		});
	}

	setTrack(track: SegmentTrack) {
		this.track = track;
		let m = 0;
		for (const s of track.speeds) m = Math.max(m, s);
		this.max = Math.max(200, Math.ceil(m / 100) * 100);
	}

	// the trick within a few pixels of a point across the graph (0..1)
	private trickNear(fraction: number): Trick | null {
		const tr = this.track;
		if (!tr) return null;
		const w = this.c.clientWidth;
		let best: Trick | null = null, bestD = 5;
		for (const t of this.tricks) {
			const d = Math.abs(((t.tick - tr.seg.firstTick) / tr.length - fraction) * w);
			if (d < bestD) {
				bestD = d;
				best = t;
			}
		}
		return best;
	}
	private snap(fraction: number): number | null {
		const t = this.trickNear(fraction);
		return t && this.track ? (t.tick - this.track.seg.firstTick) / this.track.length : null;
	}

	// (Inputs: a point across the graph as a point across the segment)
	private inputsFraction(f: number): number {
		const tr = this.track;
		if (!tr) return f;
		const w = this.c.clientWidth, half = INPUT_WINDOW / tr.seg.intervalPerTick;
		const at = (f * w - INPUT_LABELS) / (w - INPUT_LABELS);
		const tick = this.now - half + Math.max(0, at) * 2 * half;
		return Math.min(1, Math.max(0, (Math.round(tick) - tr.seg.firstTick) / tr.length));
	}

	draw(tick: number) {
		const {g, w, h} = prepare(this.c);
		g.clearRect(0, 0, w, h);
		this.now = tick;
		const tr = this.track;
		if (!tr || !tr.seg.views.length) return;
		if (this.mode === 'inputs') return this.drawInputs(g, w, h, tick);
		const t0 = tr.seg.firstTick, len = tr.length;
		const x = (t: number) => ((t - t0) / len) * w;
		if (this.mode === 'gap' && this.gaps.length) this.drawGaps(g, w, h, x);
		else if (this.mode === 'strafe') this.drawStrafe(g, w, h, x);
		else this.drawSpeed(g, w, h, x);
		this.drawLane(g, w, h, x);
		// the tricks, a mark each along the top
		for (const t of this.tricks) {
			g.fillStyle = t.color;
			g.fillRect(Math.round(x(t.tick)) - 1, 0, 2, t.kind === 'portal' ? 4 : 7);
		}
		g.fillStyle = '#5aa9ff';
		g.fillRect(x(tick) - 1, 0, 2, h);
	}

	// each key a row, each run a lane in it, a bar for every tick it was held;
	// now in the middle
	private drawInputs(g: CanvasRenderingContext2D, w: number, h: number, tick: number) {
		const half = INPUT_WINDOW / this.track!.seg.intervalPerTick;
		const from = Math.floor(tick - half), to = Math.ceil(tick + half);
		const x = (t: number) => INPUT_LABELS + ((t - (tick - half)) / (2 * half)) * (w - INPUT_LABELS);
		const tickW = (w - INPUT_LABELS) / (2 * half);
		// (the runs named along the top, clear of the graph's mode buttons)
		const rows = INPUT_KEYS.length + STATE_ROWS.length;
		const top = 28, rowH = (h - top - 2) / rows, laneH = Math.max(1, (rowH - 2) / Math.max(1, this.lanes.length));
		g.font = '10px ui-monospace, Consolas, monospace';
		g.textBaseline = 'middle';
		g.textAlign = 'left';
		[...INPUT_KEYS, ...STATE_ROWS].forEach(([name], k) => {
			const y = top + k * rowH;
			g.fillStyle = k % 2 ? '#141820' : '#181d26';
			g.fillRect(INPUT_LABELS, y, w - INPUT_LABELS, rowH);
			g.fillStyle = '#8a93a3';
			g.fillText(name, 4, y + rowH / 2);
		});
		// (a line every 6 ticks, a tenth of a second)
		g.fillStyle = '#232a35';
		for (let t = Math.ceil(from / 6) * 6; t <= to; t += 6) g.fillRect(Math.round(x(t)), top, 1, h - top - 2);
		this.lanes.forEach((lane, l) => {
			g.fillStyle = lane.color;
			for (let t = from; t <= to; t++) {
				const c = lane.cmd(t);
				if (!c) continue;
				INPUT_KEYS.forEach(([, held], k) => {
					if (held(c)) g.fillRect(x(t), top + k * rowH + 1 + l * laneH, Math.max(1, tickW - 0.5), laneH - (this.lanes.length > 1 ? 0.5 : 0));
				});
			}
			if (!lane.state) return;
			// (the movement rows dimmer: what happened, not what was pressed)
			g.globalAlpha = 0.6;
			for (let t = from; t <= to; t++) {
				const s = lane.state(t);
				STATE_ROWS.forEach(([, on], k) => {
					if (on(s)) g.fillRect(x(t), top + (INPUT_KEYS.length + k) * rowH + 1 + l * laneH, Math.max(1, tickW - 0.5), laneH - (this.lanes.length > 1 ? 0.5 : 0));
				});
			}
			g.globalAlpha = 1;
		});
		let nameX = INPUT_LABELS;
		for (const lane of this.lanes) {
			g.fillStyle = lane.color;
			g.fillRect(nameX, 10, 8, 8);
			g.fillText(lane.name, nameX + 12, 14);
			nameX += 12 + g.measureText(lane.name).width + 16;
		}
		g.fillStyle = '#5aa9ff';
		g.fillRect(x(tick) - 1, 0, 2, h);
	}

	// the movement lane: a strip along the bottom, a colour a stretch
	private drawLane(g: CanvasRenderingContext2D, w: number, h: number, x: (t: number) => number) {
		const m = this.move;
		if (!m) return;
		const y = h - LANE_H;
		g.fillStyle = '#0c0e12';
		g.fillRect(0, y - 1, w, LANE_H + 1);
		const color = (s: number) => (s & FUNNEL ? LANE_COLORS.funnel : s & GROUND ? LANE_COLORS.ground : LANE_COLORS.air);
		// (a run of ticks alike drawn at once)
		let from = 0;
		for (let i = 1; i <= m.states.length; i++) {
			if (i < m.states.length && (m.states[i] & ~PORTAL) === (m.states[from] & ~PORTAL)) continue;
			const s = m.states[from], x0 = x(m.first + from), x1 = x(m.first + i);
			g.fillStyle = color(s);
			g.fillRect(x0, y, Math.max(1, x1 - x0), LANE_H);
			if (s & DUCKED) {
				g.fillStyle = LANE_COLORS.ducked;
				g.fillRect(x0, y, Math.max(1, x1 - x0), 2);
			}
			from = i;
		}
		g.fillStyle = LANE_COLORS.portal;
		m.states.forEach((s, i) => s & PORTAL && g.fillRect(x(m.first + i), y - 1, 1.5, LANE_H + 1));
	}

	// a bar each tick in the air: how much speed it could have gained (grey)
	// and what it did (green where a strafe key was held, blue where not;
	// red, below the line, where it lost speed)
	private drawStrafe(g: CanvasRenderingContext2D, w: number, h: number, x: (t: number) => number) {
		const s = this.strafe;
		g.fillStyle = '#8a93a3';
		g.font = '10px ui-monospace, Consolas, monospace';
		g.textAlign = 'left';
		if (!s) {
			g.fillText('Strafing can\'t be told here: it needs a view every tick (a co-op partner\'s demo has one every few)', 4, 18);
			return;
		}
		let most = 1;
		for (const v of s.ideal) if (Number.isFinite(v)) most = Math.max(most, v);
		const base = h - LANE_H - 16, top = 26;
		const y = (v: number) => base - (v / most) * (base - top);
		g.strokeStyle = '#2b3340';
		g.lineWidth = 1;
		g.beginPath();
		g.moveTo(0, Math.round(base) + 0.5);
		g.lineTo(w, Math.round(base) + 0.5);
		g.stroke();
		const bar = Math.max(1, x(s.first + 1) - x(s.first) - 0.3);
		for (let i = 0; i < s.ideal.length; i++) {
			const ideal = s.ideal[i];
			if (!Number.isFinite(ideal)) continue;
			const px = x(s.first + i), got = s.gained[i];
			g.fillStyle = '#2f3846';
			g.fillRect(px, y(ideal), bar, base - y(ideal));
			g.fillStyle = got < 0 ? '#ff5c5c' : s.keys[i] ? '#47c17b' : '#4c88d6';
			if (got >= 0) g.fillRect(px, y(got), bar, base - y(got));
			else g.fillRect(px, base + 1, bar, Math.min(12, (-got / most) * (base - top)));
		}
		g.fillStyle = '#8a93a3';
		g.fillText(this.strafeNote, 4, 18);
	}

	private drawSpeed(g: CanvasRenderingContext2D, w: number, h: number, x: (t: number) => number) {
		const tr = this.track!, views = tr.seg.views;
		const y = (s: number) => h - LANE_H - 4 - (s / this.max) * (h - LANE_H - 14);

		g.strokeStyle = '#1d232c';
		g.lineWidth = 1;
		for (let s = 100; s < this.max; s += this.max > 1000 ? 500 : 100) {
			g.beginPath();
			g.moveTo(0, Math.round(y(s)) + 0.5);
			g.lineTo(w, Math.round(y(s)) + 0.5);
			g.stroke();
		}

		g.lineWidth = 1.5;
		let prevX = x(views[0].tick), prevY = y(tr.speeds[0]);
		for (let i = 1; i < views.length; i++) {
			const nx = x(views[i].tick), ny = y(tr.speeds[i]);
			g.strokeStyle = speedColor(tr.speeds[i]);
			g.beginPath();
			g.moveTo(prevX, prevY);
			g.lineTo(nx, ny);
			g.stroke();
			prevX = nx;
			prevY = ny;
		}

		g.fillStyle = '#8a93a3';
		g.font = '10px ui-monospace, Consolas, monospace';
		g.textAlign = 'left';
		g.fillText(`${this.max} u/s`, 4, 18);
	}

	// each raced run's gap as a line in its colour: ahead of this run above
	// the middle, behind below, the scale fitting the largest gap
	private drawGaps(g: CanvasRenderingContext2D, w: number, h: number, x: (t: number) => number) {
		let most = 0.25;
		for (const l of this.gaps) for (const d of l.gaps) if (Number.isFinite(d)) most = Math.max(most, Math.abs(d));
		const range = most <= 1 ? Math.ceil(most * 4) / 4 : Math.ceil(most);
		const mid = (h + 8 - LANE_H) / 2, half = (h - 14 - LANE_H) / 2;

		const y = (d: number) => mid - (d / range) * half;
		g.strokeStyle = '#2b3340';
		g.lineWidth = 1;
		g.beginPath();
		g.moveTo(0, Math.round(mid) + 0.5);
		g.lineTo(w, Math.round(mid) + 0.5);
		g.stroke();
		g.lineWidth = 1.5;
		for (const l of this.gaps) {
			g.strokeStyle = l.color;
			g.beginPath();
			let drawing = false;
			for (let i = 0; i < l.ticks.length; i++) {
				const d = l.gaps[i];
				if (!Number.isFinite(d)) {
					drawing = false;
					continue;
				}
				if (drawing) g.lineTo(x(l.ticks[i]), y(d));
				else g.moveTo(x(l.ticks[i]), y(d));
				drawing = true;
			}
			g.stroke();
		}
		g.fillStyle = '#8a93a3';
		g.font = '10px ui-monospace, Consolas, monospace';
		g.textAlign = 'left';
		g.fillText(`raced run ${range} s ahead`, 4, 18);
		g.fillText(`${range} s behind`, 4, h - LANE_H - 4);
	}
}
