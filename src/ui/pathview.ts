// Top-down (or side-on) drawing of the player's path through the current
// segment, with the view direction and portal placements.
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

export class PathView {
	mode: Mode = 'top';
	follow = true;
	racers: RacerMark[] = [];
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

		const views = track.seg.views;
		const current = view?.viewIndex ?? -1;

		// whole path, dim; then the part already travelled, coloured by speed
		g.lineWidth = 1.5;
		g.lineJoin = 'round';
		g.strokeStyle = 'rgba(138, 147, 163, 0.28)';
		this.strokePath(g, 0, views.length - 1);
		g.lineWidth = 2.5;
		for (let i = 1; i <= current; i++) {
			if (track.teleports[i]) continue;
			const [ax, ay] = this.toScreen(...this.project(views[i - 1].origin));
			const [bx, by] = this.toScreen(...this.project(views[i].origin));
			g.strokeStyle = speedColor(track.speeds[i]);
			g.beginPath();
			g.moveTo(ax, ay);
			g.lineTo(bx, by);
			g.stroke();
		}
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
		for (const r of this.racers) if (r.view) this.drawRacer(g, r.view, r.color);
		if (view) this.drawPlayer(g, view);
		this.drawScale(g, w, h);
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

// blue (slow) -> green -> yellow -> red (fast)
export function speedColor(speed: number) {
	const t = Math.min(1, speed / 1000);
	const hue = 210 - 210 * t;
	return `hsl(${hue}, 85%, 58%)`;
}
