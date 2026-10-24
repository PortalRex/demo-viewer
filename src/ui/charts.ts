// The run timeline (segments end to end) and the speed graph for the current
// segment. Both seek on click/drag.
import type {Playback, SegmentTrack} from '../player/playback.ts';
import {speedColor} from './pathview.ts';

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

export class Timeline {
	private c: HTMLCanvasElement;
	pb: Playback | null = null;

	constructor(c: HTMLCanvasElement, seek: (t: number) => void) {
		this.c = c;
		seekOnDrag(c, f => this.pb && seek(f * this.pb.total));
	}

	draw(t: number, current: number) {
		const {g, w, h} = prepare(this.c);
		g.clearRect(0, 0, w, h);
		if (!this.pb) return;
		const total = this.pb.total;
		const x = (tick: number) => (tick / total) * w;
		this.pb.tracks.forEach((tr, i) => {
			const x0 = x(tr.start), x1 = x(tr.start + tr.length);
			g.fillStyle = i === current ? '#26405f' : i % 2 ? '#1d232c' : '#222934';
			g.fillRect(x0, 8, Math.max(1, x1 - x0 - 1), h - 16);
			// portal placements and pauses
			for (const e of tr.seg.sar) {
				if (e.kind !== 'portal' && e.kind !== 'pause') continue;
				const ex = x(tr.start + (e.tick - tr.seg.firstTick));
				g.fillStyle = e.kind === 'pause' ? '#e8b84a' : e.orange ? '#ff8a1f' : '#3f9bff';
				g.fillRect(ex, e.kind === 'pause' ? 8 : h - 12, 1.5, 4);
			}
			if (x1 - x0 > 46) {
				g.fillStyle = i === current ? '#e6e9ef' : '#8a93a3';
				g.font = '11px ui-monospace, Consolas, monospace';
				g.textAlign = 'left';
				g.save();
				g.beginPath();
				g.rect(x0, 0, x1 - x0 - 4, h);
				g.clip();
				g.fillText(shortMap(tr.seg.map), x0 + 5, h / 2 + 4);
				g.restore();
			}
		});
		const px = x(t);
		g.fillStyle = '#5aa9ff';
		g.fillRect(px - 1, 0, 2, h);
	}
}

export class SpeedGraph {
	private track: SegmentTrack | null = null;
	private max = 400;
	private c: HTMLCanvasElement;

	constructor(c: HTMLCanvasElement, seek: (fraction: number) => void) {
		this.c = c;
		seekOnDrag(c, seek);
	}

	setTrack(track: SegmentTrack) {
		this.track = track;
		let m = 0;
		for (const s of track.speeds) m = Math.max(m, s);
		this.max = Math.max(200, Math.ceil(m / 100) * 100);
	}

	draw(tick: number) {
		const {g, w, h} = prepare(this.c);
		g.clearRect(0, 0, w, h);
		const tr = this.track;
		if (!tr || !tr.seg.views.length) return;
		const views = tr.seg.views;
		const t0 = tr.seg.firstTick, len = tr.length;
		const x = (t: number) => ((t - t0) / len) * w;
		const y = (s: number) => h - 2 - (s / this.max) * (h - 12);

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
		g.fillText(`${this.max} u/s`, 4, 10);
		g.fillStyle = '#5aa9ff';
		g.fillRect(x(tick) - 1, 0, 2, h);
	}
}
