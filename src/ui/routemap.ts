// A map's routes as a picture, from above (or the side): where the runs
// went as a glow, brighter where more of them did; each route's fastest run
// as a line in its colour, named where it leaves the main route; this run's
// line bold over them, its tricks marked; and a title and key
import type {Vec3} from '../core/model.ts';

export interface RouteMapRun {
	points: Vec3[];  // its player's path, start to finish
	route: number;   // which route (0: the most taken)
}
export interface RouteMapTrick {
	pos: Vec3;
	label: string;
	color: string;
}
export interface RouteMap {
	title: string;
	subtitle: string;
	view: 'top' | 'side';
	own: Vec3[];            // the run shown's path
	runs: RouteMapRun[];    // every run (the shown one too), routes counted from them
	leaders: Vec3[][];      // each route's fastest run's path, by route
	tricks: RouteMapTrick[];
}

// routes taken by fewer runs than this (or this share of them) aren't drawn
const MIN_ROUTE_RUNS = 2, MIN_ROUTE_SHARE = 0.03;
const ROUTE_COLORS = ['#ffd84a', '#4cb8ff', '#d45cff', '#3fd6c8', '#ff5c7a', '#9be34a', '#ff9ad5', '#ff8c26'];
const JUMP = 512;  // units between points: a teleport, not walked

export function drawRouteMap(map: RouteMap, width = 1920, height = 1080): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = width;
	c.height = height;
	const g = c.getContext('2d')!;
	const s = height / 1080;
	g.fillStyle = '#0b0d11';
	g.fillRect(0, 0, width, height);

	// (the view: every run fitted in, room for the title above and key below)
	const sideAxis = (() => {
		const xs = map.own.map(p => p[0]), ys = map.own.map(p => p[1]);
		return Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? 0 : 1;
	})();
	const project = (p: Vec3): [number, number] => (map.view === 'top' ? [p[0], p[1]] : [p[sideAxis], p[2]]);
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const r of [map.own, ...map.runs.map(r => r.points)]) {
		for (const p of r) {
			const [x, y] = project(p);
			x0 = Math.min(x0, x); x1 = Math.max(x1, x);
			y0 = Math.min(y0, y); y1 = Math.max(y1, y);
		}
	}
	const top = 130 * s, bottom = 90 * s, side = 80 * s;
	const scale = Math.min((width - 2 * side) / Math.max(64, x1 - x0), (height - top - bottom) / Math.max(64, y1 - y0));
	const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
	const toScreen = (p: Vec3): [number, number] => {
		const [x, y] = project(p);
		return [width / 2 + (x - cx) * scale, top + (height - top - bottom) / 2 - (y - cy) * scale];
	};
	const counts = map.runs.reduce((m, r) => m.set(r.route, (m.get(r.route) ?? 0) + 1), new Map<number, number>());
	const drawn = (k: number) => k === 0 || (counts.get(k) ?? 0) >= Math.max(MIN_ROUTE_RUNS, MIN_ROUTE_SHARE * map.runs.length);
	const path = (points: Vec3[]) => {
		g.beginPath();
		points.forEach((p, i) => {
			const [x, y] = toScreen(p);
			const jumped = i > 0 && Math.hypot(...([0, 1, 2].map(k => p[k] - points[i - 1][k]) as [number, number, number])) > JUMP;
			if (i === 0 || jumped) g.moveTo(x, y);
			else g.lineTo(x, y);
		});
	};

	// the glow: every run's path, faint and wide, added up
	const glow = document.createElement('canvas');
	glow.width = width;
	glow.height = height;
	const gg = glow.getContext('2d')!;
	gg.globalCompositeOperation = 'lighter';
	gg.lineCap = gg.lineJoin = 'round';
	const each = Math.min(0.35, 2.5 / Math.max(1, map.runs.length));
	for (const r of map.runs) {
		gg.strokeStyle = `rgba(255, 120, 40, ${each})`;
		gg.lineWidth = 14 * s;
		gg.beginPath();
		r.points.forEach((p, i) => {
			const [x, y] = toScreen(p);
			const jumped = i > 0 && Math.hypot(p[0] - r.points[i - 1][0], p[1] - r.points[i - 1][1], p[2] - r.points[i - 1][2]) > JUMP;
			if (i === 0 || jumped) gg.moveTo(x, y);
			else gg.lineTo(x, y);
		});
		gg.stroke();
	}
	g.filter = `blur(${Math.round(6 * s)}px)`;
	g.drawImage(glow, 0, 0);
	g.filter = 'none';

	g.lineCap = g.lineJoin = 'round';
	// each route's fastest run, the most taken last (on top)
	for (let k = map.leaders.length - 1; k >= 1; k--) {
		if (!drawn(k)) continue;
		g.strokeStyle = ROUTE_COLORS[k % ROUTE_COLORS.length];
		g.lineWidth = 3 * s;
		g.setLineDash([10 * s, 7 * s]);
		path(map.leaders[k]);
		g.stroke();
	}
	g.setLineDash([]);
	// this run's, bold and glowing
	g.shadowColor = 'rgba(255, 255, 255, 0.6)';
	g.shadowBlur = 12 * s;
	g.strokeStyle = '#ffffff';
	g.lineWidth = 4.5 * s;
	path(map.own);
	g.stroke();
	g.shadowBlur = 0;

	// start and finish
	const dot = (p: Vec3, color: string, label: string) => {
		const [x, y] = toScreen(p);
		g.fillStyle = color;
		g.beginPath();
		g.arc(x, y, 9 * s, 0, Math.PI * 2);
		g.fill();
		tag(x, y - 22 * s, label, color);
	};
	// (each label moved up, then down, past those already placed)
	const placed: {x: number; y: number; w: number; h: number}[] = [];
	const clear = (x: number, y: number, w: number, h: number) => {
		const hits = (yy: number) => placed.some(p => x < p.x + p.w && x + w > p.x && yy < p.y + p.h && yy + h > p.y);
		for (let n = 0; n < 12; n++) {
			for (const yy of [y - n * (h + 3 * s), y + n * (h + 3 * s)]) if (!hits(yy)) return yy;
		}
		return y;
	};
	const tag = (x: number, y: number, text: string, color: string) => {
		g.font = `600 ${17 * s}px Arial, Helvetica, sans-serif`;
		const w = g.measureText(text).width + 16 * s, h = 26 * s;
		const lx = Math.min(width - w - 8 * s, Math.max(8 * s, x - w / 2));
		const ly = clear(lx, Math.min(height - h - 8 * s, Math.max(top - 14 * s, y - h / 2)), w, h);
		placed.push({x: lx, y: ly, w, h});
		g.fillStyle = 'rgba(11, 13, 17, 0.85)';
		g.beginPath();
		g.roundRect(lx, ly, w, h, 5 * s);
		g.fill();
		g.strokeStyle = color;
		g.lineWidth = 1.5 * s;
		g.stroke();
		g.fillStyle = color;
		g.textAlign = 'left';
		g.textBaseline = 'middle';
		g.fillText(text, lx + 8 * s, ly + h / 2 + 1);
	};

	// each route named where its line is furthest from the main one's
	map.leaders.forEach((leader, k) => {
		if (!leader.length || !drawn(k)) return;
		let at = leader[Math.floor(leader.length / 3)];
		if (k > 0) {
			let far = -1;
			for (const p of leader) {
				const d = Math.min(...map.leaders[0].map(q => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2));
				if (d > far) {
					far = d;
					at = p;
				}
			}
		}
		const [x, y] = toScreen(at);
		const n = counts.get(k) ?? 0;
		tag(x, y - 26 * s, `Route ${String.fromCharCode(65 + k)} · ${n} run${n === 1 ? '' : 's'}`, ROUTE_COLORS[k % ROUTE_COLORS.length]);
	});
	dot(map.own[0], '#3fd67a', 'Start');
	dot(map.own[map.own.length - 1], '#ff5c5c', 'Finish');

	// the tricks along this run, small marks, their names clear of the labels
	g.font = `${13 * s}px Arial, Helvetica, sans-serif`;
	g.textAlign = 'left';
	g.textBaseline = 'middle';
	for (const t of map.tricks) {
		const [x, y] = toScreen(t.pos);
		g.fillStyle = t.color;
		g.beginPath();
		g.moveTo(x, y - 8 * s);
		g.lineTo(x + 7 * s, y + 5 * s);
		g.lineTo(x - 7 * s, y + 5 * s);
		g.closePath();
		g.fill();
		const w = g.measureText(t.label).width + 4 * s, h = 16 * s;
		const ly = clear(x + 10 * s, y - h / 2, w, h);
		placed.push({x: x + 10 * s, y: ly, w, h});
		g.fillText(t.label, x + 10 * s, ly + h / 2);
	}

	// title and key
	g.textAlign = 'left';
	g.textBaseline = 'alphabetic';
	g.fillStyle = '#ffffff';
	g.font = `700 ${46 * s}px Arial, Helvetica, sans-serif`;
	g.fillText(map.title, side, 70 * s);
	g.fillStyle = '#8a93a3';
	g.font = `${20 * s}px Arial, Helvetica, sans-serif`;
	g.fillText(map.subtitle, side, 104 * s);
	const key: [string, string, boolean][] = [['#ffffff', 'This run', false], ['#ff8a3d', 'Where the runs went', false]];
	map.leaders.forEach((_, k) => k > 0 && drawn(k) && key.push([ROUTE_COLORS[k % ROUTE_COLORS.length], `Route ${String.fromCharCode(65 + k)}'s fastest`, true]));
	let kx = side;
	g.font = `${16 * s}px Arial, Helvetica, sans-serif`;
	g.textBaseline = 'middle';
	for (const [color, label, dashed] of key) {
		g.strokeStyle = color;
		g.lineWidth = 4 * s;
		g.setLineDash(dashed ? [8 * s, 5 * s] : []);
		g.beginPath();
		g.moveTo(kx, height - 45 * s);
		g.lineTo(kx + 34 * s, height - 45 * s);
		g.stroke();
		g.setLineDash([]);
		g.fillStyle = '#c5cad3';
		g.fillText(label, kx + 44 * s, height - 45 * s);
		kx += 44 * s + g.measureText(label).width + 36 * s;
	}
	g.textAlign = 'right';
	g.textBaseline = 'alphabetic';
	g.fillStyle = '#5d6573';
	g.fillText('SAR Run Viewer', width - side, 70 * s);
	return c;
}
