// Links to a moment of a run, as the page's address after # (see main.ts's
// Link button): the recording's URL (where it was opened from one;
// otherwise its file name, for whoever has the file to drop in), the tick,
// the view, and the 3D camera:
//   #load=<url>&t=<tick>&view=3d&cam=free&pos=x,y,z&ang=pitch,yaw
// A run from the leaderboard is named by its board id instead, with its
// co-op partner's demo, the runs raced against it (theirs too) and which
// the split screen shows, all downloaded again by whoever opens it:
//   #board=<id>&with=<id>&race=<id>,<id>,...&split=<racer index|partner>&t=...
import type {CameraState} from '../ui/view3d.ts';

export type ViewMode = 'top' | 'side' | '3d';
export interface Moment {
	tick: number;
	view: ViewMode;
	camera?: CameraState;
	file?: string;
}
export interface BoardLink {
	id: number;
	partners: number[];
	raced: number[];
	split: string | null;
}
export interface Link {
	load: string | null;
	board: BoardLink | null;
	moment: Moment | null;
}

export function linkHash(link: Link): string {
	const q = new URLSearchParams();
	const {board, moment: m} = link;
	if (board) {
		q.set('board', String(board.id));
		if (board.partners.length) q.set('with', board.partners.join(','));
		if (board.raced.length) q.set('race', board.raced.join(','));
		if (board.split) q.set('split', board.split);
	} else if (link.load) q.set('load', link.load);
	else if (m?.file) q.set('file', m.file);
	if (m) {
		q.set('t', String(m.tick));
		q.set('view', m.view);
		if (m.camera) {
			q.set('cam', m.camera.mode);
			if (m.camera.pos) q.set('pos', m.camera.pos.join(','));
			if (m.camera.ang) q.set('ang', m.camera.ang.join(','));
			if (m.camera.offset) q.set('off', m.camera.offset.join(','));
		}
	}
	// (the URL's own characters kept readable)
	return '#' + q.toString().replace(/%2F/g, '/').replace(/%2C/g, ',').replace(/%3A/g, ':');
}

export function parseLink(hash: string): Link {
	const q = new URLSearchParams(hash.replace(/^#/, ''));
	const nums = (k: string) => q.get(k)?.split(',').filter(x => x !== '').map(Number).filter(Number.isFinite);
	const load = q.get('load');
	const id = Number(q.get('board'));
	const board = id > 0 ? {id, partners: nums('with') ?? [], raced: nums('race') ?? [], split: q.get('split')} : null;
	if (!q.has('t')) return {load, board, moment: null};
	const view = q.get('view');
	const cam = q.get('cam');
	return {
		load,
		board,
		moment: {
			tick: Number(q.get('t')) || 0,
			view: view === '3d' || view === 'side' ? view : 'top',
			camera: cam === 'eyes' || cam === 'orbit' || cam === 'free' || cam === 'chase' ? {mode: cam, pos: nums('pos'), ang: nums('ang'), offset: nums('off')} : undefined,
			file: q.get('file') ?? undefined,
		},
	};
}
