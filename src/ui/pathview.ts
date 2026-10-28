// Top-down (or side-on) drawing of the player's path through the current
// segment, with the view direction and portal placements.
import {viewAt} from '../player/playback.ts';
import type {SegmentTrack, ViewState} from '../player/playback.ts';
import type {SarEvent, Vec3} from '../core/model.ts';

type Mode = 'top' | 'side';

// another run raced against this one: where its player is now (null: not
// on this map now) and its segment on this map where its path is drawn
export interface RacerMark {
	view: {origin: Vec3; angles: Vec3} | null;
	color: string;
	path: SegmentTrack | null;
}

const GRID_STEPS = [64, 128, 256, 512, 1024, 2048, 4096];
const TRAIL_TIME = 1;        // seconds of the trail behind the player
const SHOT_TIME = 0.5;       // seconds a portal shot's line lasts
const HEAT_CELL = 16;         // units a side of the heatmap's cells
const HEAT_MAX_CELLS = 1024;  // across, at most (larger maps: larger cells)
const HULL_HALF = 16, HULL_TALL = 72, HULL_DUCKED = 36;  // the player's collision box


// Where many runs went: each cell of a grid over the map counted once for
// every run whose path crosses it, as an image (a pixel a cell) and where
// it lies in the view's (projected) world coordinates
interface Heat {
	key: string;
	image: HTMLCanvasElement;
	x0: number;
	y0: number;
	cell: number;
	runs: number;
}

export class PathView {
	mode: Mode = 'top';
	follow = true;
	racers: RacerMark[] = [];
	// the heatmap's runs (this one's segment and every raced run's on the
	// map), drawn under the paths while heatShown
	heatTracks: SegmentTrack[] = [];
	heatShown = false;
	private heat: Heat | null = null;
	// the player's trail (where they were over the last second, fading) and
	// portal shots (a line from them to each portal just placed, fading)
	trailShown = false;
	shotsShown = false;
	// the swarm's dots (see player/swarm.ts), colours as CSS
	swarm: {pos: Vec3; color: string}[] = [];
	// the player's hitbox (crouched: half as tall)
	hitboxShown = false;
	hitboxDucked = false;
	// the path coloured by where it gained or lost time on another run (a
	// colour a view, CSS; null: by speed), and what it's against
	lossColors: string[] | null = null;
	lossNote = '';
	private scale = 0.1;  // pixels per unit
	private cx = 0;       // world (projected) coordinates at the canvas center
	private cy = 0;
	private track: SegmentTrack | null = null;
	private sideAxis = 0;  // 0 = x, 1 = y for the side view
	private dpr = 1;
	private dragging: {x: number; y: number} | null = null;
	onUserMove = () => {};
	readonly canvas: HTMLCanvasElement;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		canvas.addEventListener('wheel', e => {
			e.preventDefault();
			const r = canvas.getBoundingClientRect();
			const [wx, wy] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
			this.scale *= Math.exp(-e.deltaY * 0.0015);
			this.scale = Math.min(20, Math.max(0.002, this.scale));
			// keep the point under the cursor fixed
			const [nx, ny] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
			this.cx += wx - nx;
			this.cy += wy - ny;
			this.onUserMove();
		}, {passive: false});
		canvas.addEventListener('pointerdown', e => {
			this.dragging = {x: e.clientX, y: e.clientY};
			canvas.setPointerCapture(e.pointerId);
		});
		canvas.addEventListener('pointermove', e => {
			if (!this.dragging) return;
			this.cx -= (e.clientX - this.dragging.x) / this.scale;
			this.cy += (e.clientY - this.dragging.y) / this.scale;
			this.dragging = {x: e.clientX, y: e.clientY};
			this.follow = false;
			this.onUserMove();
		});
		canvas.addEventListener('pointerup', () => (this.dragging = null));
	}

	setTrack(track: SegmentTrack) {
		this.track = track;
		const v = track.seg.views;
		if (v.length) {
			const xs = v.map(f => f.origin[0]), ys = v.map(f => f.origin[1]);
			this.sideAxis = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? 0 : 1;
		}
		this.fit();
	}

	private project(p: Vec3): [number, number] {
		return this.mode === 'top' ? [p[0], p[1]] : [p[this.sideAxis], p[2]];
	}

	private toScreen(wx: number, wy: number): [number, number] {
		const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
		return [w / 2 + (wx - this.cx) * this.scale, h / 2 - (wy - this.cy) * this.scale];
	}

	private toWorld(sx: number, sy: number): [number, number] {
		const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
		return [this.cx + (sx - w / 2) / this.scale, this.cy - (sy - h / 2) / this.scale];
	}

	fit() {
		const v = this.track?.seg.views;
		if (!v?.length) return;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const f of v) {
			const [x, y] = this.project(f.origin);
			x0 = Math.min(x0, x); x1 = Math.max(x1, x);
			y0 = Math.min(y0, y); y1 = Math.max(y1, y);
		}
		const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
		this.cx = (x0 + x1) / 2;
		this.cy = (y0 + y1) / 2;
		this.scale = Math.min(20, 0.85 * Math.min(w / Math.max(64, x1 - x0), h / Math.max(64, y1 - y0)));
	}

	setMode(mode: Mode) {
		this.mode = mode;
		this.fit();
	}

	draw(view: ViewState | null, tick: number, events: SarEvent[]) {
		const c = this.canvas;
		this.dpr = window.devicePixelRatio || 1;
		const w = c.clientWidth, h = c.clientHeight;
		if (c.width !== Math.round(w * this.dpr) || c.height !== Math.round(h * this.dpr)) {
			c.width = Math.round(w * this.dpr);
			c.height = Math.round(h * this.dpr);
		}
		const g = c.getContext('2d')!;
		g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		g.fillStyle = '#0c0e12';
		g.fillRect(0, 0, w, h);

		if (view && this.follow) {
			const [px, py] = this.project(view.origin);
			// keep the player inside the middle 60% instead of locking to it
			const [sx, sy] = this.toScreen(px, py);
			const mx = w * 0.2, my = h * 0.2;
			if (sx < mx) this.cx -= (mx - sx) / this.scale;
			if (sx > w - mx) this.cx += (sx - (w - mx)) / this.scale;
			if (sy < my) this.cy += (my - sy) / this.scale;
			if (sy > h - my) this.cy -= (sy - (h - my)) / this.scale;
		}

		this.drawGrid(g, w, h);
		const track = this.track;
		if (!track) return;
		if (this.heatShown) this.drawHeat(g);

		const views = track.seg.views;
		const current = view?.viewIndex ?? -1;

		// whole path, dim; then the part already travelled, coloured by speed
		// (or all of it by time gained and lost, the part to come dimmer)
		g.lineWidth = 1.5;
		g.lineJoin = 'round';
		g.strokeStyle = 'rgba(138, 147, 163, 0.28)';
		this.strokePath(g, 0, views.length - 1);
		const loss = this.lossColors?.length === views.length ? this.lossColors : null;
		g.lineWidth = loss ? 3.5 : 2.5;
		for (let i = 1; i <= (loss ? views.length - 1 : current); i++) {
			if (track.teleports[i]) continue;
			const [ax, ay] = this.toScreen(...this.project(views[i - 1].origin));
			const [bx, by] = this.toScreen(...this.project(views[i].origin));
			g.strokeStyle = loss ? loss[i] : speedColor(track.speeds[i]);
			g.globalAlpha = loss && i > current ? 0.55 : 1;
			g.beginPath();
			g.moveTo(ax, ay);
			g.lineTo(bx, by);
			g.stroke();
		}
		g.globalAlpha = 1;
		// teleports as dashed links
		g.setLineDash([4, 5]);
		g.lineWidth = 1;
		g.strokeStyle = 'rgba(200, 160, 255, 0.55)';
		for (let i = 1; i < views.length; i++) {
			if (!track.teleports[i]) continue;
			const [ax, ay] = this.toScreen(...this.project(views[i - 1].origin));
			const [bx, by] = this.toScreen(...this.project(views[i].origin));
			g.beginPath();
			g.moveTo(ax, ay);
			g.lineTo(bx, by);
			g.stroke();
		}
		g.setLineDash([]);

		// the other runs' paths (as far as shown) and players, in their colours
		g.lineWidth = 1.5;
		g.globalAlpha = 0.7;
		for (const r of this.racers) {
			if (!r.path) continue;
			g.strokeStyle = r.color;
			this.strokePath(g, 0, r.path.seg.views.length - 1, r.path);
		}
		g.globalAlpha = 1;

		this.drawPortals(g, events, tick);
		this.drawSwarm(g);
		if (this.trailShown) this.drawTrail(g, track, tick);
		if (this.shotsShown) this.drawShots(g, track, events, tick);
		for (const r of this.racers) if (r.view) this.drawRacer(g, r.view, r.color);
		if (view && this.hitboxShown) this.drawHitbox(g, view);
		if (view) this.drawPlayer(g, view);
		this.drawScale(g, w, h);
		if (loss && this.lossNote) this.drawLossKey(g);
	}

	// the player's collision box, from their feet: 32 units square, 72 tall
	// (36 crouched)
	private drawHitbox(g: CanvasRenderingContext2D, view: ViewState) {
		const [x, y] = this.toScreen(...this.project(view.origin));
		const half = HULL_HALF * this.scale, tall = (this.hitboxDucked ? HULL_DUCKED : HULL_TALL) * this.scale;
		g.strokeStyle = this.hitboxDucked ? '#d45cff' : '#ffd84a';
		g.lineWidth = 1.5;
		g.setLineDash([4, 3]);
		if (this.mode === 'top') g.strokeRect(x - half, y - half, half * 2, half * 2);
		else g.strokeRect(x - half, y - tall, half * 2, tall);
		g.setLineDash([]);
	}

	private drawLossKey(g: CanvasRenderingContext2D) {
		g.font = '11px ui-monospace, Consolas, monospace';
		g.textAlign = 'left';
		const items: [string, string][] = [['#47d17b', 'gaining'], ['#ff5c5c', 'losing'], ['#8a93a3', `time ${this.lossNote}`]];
		let x = 12;
		for (const [color, label] of items) {
			g.fillStyle = color;
			g.fillRect(x, 12, 14, 4);
			g.fillStyle = '#c5cad3';
			g.fillText(label, x + 19, 18);
			x += 19 + g.measureText(label).width + 14;
		}
	}

	private strokePath(g: CanvasRenderingContext2D, from: number, to: number, track = this.track!) {
		const views = track.seg.views;
		g.beginPath();
		for (let i = from; i <= to; i++) {
			const [x, y] = this.toScreen(...this.project(views[i].origin));
			if (i === from || track.teleports[i]) g.moveTo(x, y);
			else g.lineTo(x, y);
		}
		g.stroke();
	}

	private drawHeat(g: CanvasRenderingContext2D) {
		const tracks = this.heatTracks;
		if (tracks.length < 2) return;
		const key = `${this.mode} ${this.sideAxis} ${tracks.map(t => `${t.seg.map}:${t.start}:${t.seg.views.length}`).join(',')}`;
		if (this.heat?.key !== key || this.heat.runs !== tracks.length) this.heat = this.makeHeat(key, tracks);
		const heat = this.heat;
		if (!heat) return;
		// (the image's top row is the grid's highest y: the screen's y is down)
		const [sx, sy] = this.toScreen(heat.x0, heat.y0 + heat.image.height * heat.cell);
		g.globalAlpha = 0.85;
		g.imageSmoothingQuality = 'high';
		g.drawImage(heat.image, sx, sy, heat.image.width * heat.cell * this.scale, heat.image.height * heat.cell * this.scale);
		g.globalAlpha = 1;
	}

	private makeHeat(key: string, tracks: SegmentTrack[]): Heat | null {
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const t of tracks) {
			for (const f of t.seg.views) {
				const [x, y] = this.project(f.origin);
				x0 = Math.min(x0, x); x1 = Math.max(x1, x);
				y0 = Math.min(y0, y); y1 = Math.max(y1, y);
			}
		}
		if (!Number.isFinite(x0)) return null;
		const cell = Math.max(HEAT_CELL, Math.ceil(Math.max(x1 - x0, y1 - y0) / HEAT_MAX_CELLS));
		x0 -= cell; y0 -= cell;
		const cols = Math.ceil((x1 - x0) / cell) + 2, rows = Math.ceil((y1 - y0) / cell) + 2;
		const counts = new Uint16Array(cols * rows);
		const seen = new Uint32Array(cols * rows);  // the run (+1) that last counted each cell
		tracks.forEach((t, run) => {
			const mark = (x: number, y: number) => {
				const i = Math.floor((y - y0) / cell) * cols + Math.floor((x - x0) / cell);
				if (seen[i] === run + 1) return;
				seen[i] = run + 1;
				counts[i]++;
			};
			const v = t.seg.views;
			for (let i = 0; i < v.length; i++) {
				const [bx, by] = this.project(v[i].origin);
				if (i === 0 || t.teleports[i]) {
					mark(bx, by);
					continue;
				}
				// (along the step from the view before, a half cell at a time)
				const [ax, ay] = this.project(v[i - 1].origin);
				const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell / 2)));
				for (let k = 1; k <= steps; k++) mark(ax + (bx - ax) * k / steps, ay + (by - ay) * k / steps);
			}
		});
		const image = document.createElement('canvas');
		image.width = cols;
		image.height = rows;
		const g = image.getContext('2d')!;
		const pixels = g.createImageData(cols, rows);
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const n = counts[r * cols + c];
				if (!n) continue;
				// (a lone run faint and blue, all of them bright and hot)
				const f = (n - 1) / Math.max(1, tracks.length - 1);
				const [cr, cg, cb] = heatColor(f);
				const o = ((rows - 1 - r) * cols + c) * 4;
				pixels.data[o] = cr;
				pixels.data[o + 1] = cg;
				pixels.data[o + 2] = cb;
				pixels.data[o + 3] = Math.round(70 + 185 * Math.sqrt(f));
			}
		}
		g.putImageData(pixels, 0, 0);
		return {key, image, x0, y0, cell, runs: tracks.length};
	}

	// (glowing: each dot added to what's under it)
	private drawSwarm(g: CanvasRenderingContext2D) {
		if (!this.swarm.length) return;
		g.globalCompositeOperation = 'lighter';
		g.globalAlpha = 0.75;
		for (const d of this.swarm) {
			const [x, y] = this.toScreen(...this.project(d.pos));
			g.fillStyle = d.color;
			g.beginPath();
			g.arc(x, y, 3, 0, Math.PI * 2);
			g.fill();
		}
		g.globalAlpha = 1;
		g.globalCompositeOperation = 'source-over';
	}

	private drawTrail(g: CanvasRenderingContext2D, track: SegmentTrack, tick: number) {
		const views = track.seg.views, interval = track.seg.intervalPerTick;
		for (let i = views.length - 1; i >= 0; i--) {
			const age = (tick - views[i].tick) * interval;
			if (age < 0) continue;
			if (age > TRAIL_TIME) break;
			const [x, y] = this.toScreen(...this.project(views[i].origin));
			g.fillStyle = `rgba(140, 190, 255, ${(0.7 * (1 - age / TRAIL_TIME)).toFixed(3)})`;
			g.beginPath();
			g.arc(x, y, 3.5, 0, Math.PI * 2);
			g.fill();
		}
	}

	private drawShots(g: CanvasRenderingContext2D, track: SegmentTrack, events: SarEvent[], tick: number) {
		const interval = track.seg.intervalPerTick;
		g.lineWidth = 2;
		for (const e of events) {
			if (e.kind !== 'portal') continue;
			const age = (tick - e.tick) * interval;
			if (age < 0 || age > SHOT_TIME) continue;
			const from = viewAt(track, e.tick);
			if (!from) continue;
			const [ax, ay] = this.toScreen(...this.project(from.origin));
			const [bx, by] = this.toScreen(...this.project(e.pos));
			g.strokeStyle = e.orange ? '#ff8a1f' : '#3f9bff';
			g.globalAlpha = 1 - age / SHOT_TIME;
			g.beginPath();
			g.moveTo(ax, ay);
			g.lineTo(bx, by);
			g.stroke();
		}
		g.globalAlpha = 1;
	}

	private drawGrid(g: CanvasRenderingContext2D, w: number, h: number) {
		const step = GRID_STEPS.find(s => s * this.scale >= 40) ?? 8192;
		const [x0, y1] = this.toWorld(0, 0);
		const [x1, y0] = this.toWorld(w, h);
		g.lineWidth = 1;
		for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
			const [sx] = this.toScreen(x, 0);
			g.strokeStyle = x === 0 ? '#2b3340' : '#171b22';
			g.beginPath();
			g.moveTo(Math.round(sx) + 0.5, 0);
			g.lineTo(Math.round(sx) + 0.5, h);
			g.stroke();
		}
		for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
			const [, sy] = this.toScreen(0, y);
			g.strokeStyle = y === 0 ? '#2b3340' : '#171b22';
			g.beginPath();
			g.moveTo(0, Math.round(sy) + 0.5);
			g.lineTo(w, Math.round(sy) + 0.5);
			g.stroke();
		}
	}

	private drawScale(g: CanvasRenderingContext2D, w: number, h: number) {
		const step = GRID_STEPS.find(s => s * this.scale >= 40) ?? 8192;
		const len = step * this.scale;
		const x = w - 16 - len, y = h - 16;
		g.strokeStyle = '#8a93a3';
		g.lineWidth = 1;
		g.beginPath();
		g.moveTo(x, y - 4); g.lineTo(x, y); g.lineTo(x + len, y); g.lineTo(x + len, y - 4);
		g.stroke();
		g.fillStyle = '#8a93a3';
		g.font = '11px ui-monospace, Consolas, monospace';
		g.textAlign = 'center';
		const axes = this.mode === 'top' ? 'top view (x, y)' : `side view (${'xy'[this.sideAxis]}, z)`;
		g.fillText(`${step} units`, x + len / 2, y - 7);
		g.textAlign = 'right';
		g.fillText(axes, w - 16, 18);
	}

	private drawPortals(g: CanvasRenderingContext2D, events: SarEvent[], tick: number) {
		const latest = new Map<string, Vec3>();
		for (const e of events) {
			if (e.kind !== 'portal' || e.tick > tick) continue;
			const key = `${e.slot}:${e.orange ? 1 : 0}`;
			const prev = latest.get(key);
			if (prev) this.portalMark(g, prev, e.orange, false);
			latest.set(key, e.pos);
		}
		for (const [key, pos] of latest) this.portalMark(g, pos, key.endsWith(':1'), true);
	}

	private portalMark(g: CanvasRenderingContext2D, pos: Vec3, orange: boolean, current: boolean) {
		const [x, y] = this.toScreen(...this.project(pos));
		const col = orange ? '#ff8a1f' : '#3f9bff';
		g.globalAlpha = current ? 1 : 0.3;
		g.strokeStyle = col;
		g.lineWidth = current ? 2.5 : 1.5;
		g.beginPath();
		g.ellipse(x, y, current ? 7 : 4, current ? 10 : 6, 0, 0, Math.PI * 2);
		g.stroke();
		g.globalAlpha = 1;
	}

	// the way a view looks, as an angle on the canvas
	private facing(angles: Vec3): number {
		if (this.mode === 'top') return -angles[1] * Math.PI / 180;  // yaw: counter-clockwise from +x
		// facing along the side axis or away from it, tilted by pitch
		const yaw = angles[1] * Math.PI / 180;
		const along = this.sideAxis === 0 ? Math.cos(yaw) : Math.sin(yaw);
		const pitch = angles[0] * Math.PI / 180;
		return Math.atan2(Math.sin(pitch), along * Math.cos(pitch));
	}

	// another run's player: a dot in its colour, pointing where it looks
	private drawRacer(g: CanvasRenderingContext2D, view: {origin: Vec3; angles: Vec3}, color: string) {
		const [x, y] = this.toScreen(...this.project(view.origin));
		const dir = this.facing(view.angles);
		g.strokeStyle = color;
		g.lineWidth = 2;
		g.beginPath();
		g.moveTo(x, y);
		g.lineTo(x + Math.cos(dir) * 20, y + Math.sin(dir) * 20);
		g.stroke();
		g.fillStyle = color;
		g.beginPath();
		g.arc(x, y, 4.5, 0, Math.PI * 2);
		g.fill();
	}

	private drawPlayer(g: CanvasRenderingContext2D, view: ViewState) {
		const [x, y] = this.toScreen(...this.project(view.origin));
		const dir = this.facing(view.angles);
		// view cone
		const fov = 45 * Math.PI / 180;
		g.fillStyle = 'rgba(90, 169, 255, 0.16)';
		g.beginPath();
		g.moveTo(x, y);
		g.arc(x, y, 70, dir - fov, dir + fov);
		g.closePath();
		g.fill();
		g.strokeStyle = '#5aa9ff';
		g.lineWidth = 2;
		g.beginPath();
		g.moveTo(x, y);
		g.lineTo(x + Math.cos(dir) * 26, y + Math.sin(dir) * 26);
		g.stroke();
		g.fillStyle = '#e6e9ef';
		g.beginPath();
		g.arc(x, y, 5, 0, Math.PI * 2);
		g.fill();
	}
}

// the heatmap's colours: deep blue (few runs) -> magenta -> orange -> pale yellow (all)
function heatColor(f: number): [number, number, number] {
	const stops: [number, number, number][] = [[40, 60, 190], [190, 50, 170], [255, 130, 40], [255, 240, 170]];
	const x = Math.min(1, Math.max(0, f)) * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(x)), k = x - i;
	const a = stops[i], b = stops[i + 1];
	return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

// blue (slow) -> green -> yellow -> red (fast)
export function speedColor(speed: number) {
	const t = Math.min(1, speed / 1000);
	const hue = 210 - 210 * t;
	return `hsl(${hue}, 85%, 58%)`;
}
