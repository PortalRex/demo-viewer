// The leaderboard (board.portal2.sr) in a dialog: a chamber's runs, best
// first, each one's demo downloaded to open or race (a co-op run's two
// players' demos together)
import {CHAMBERS, chamberFor} from '../core/chambers.ts';
import type {Chamber} from '../core/chambers.ts';
import {boardRunsOf, fmtScore, wrHistoryOf} from '../core/leaderboard.ts';
import type {BoardJson, BoardRun, WrJson} from '../core/leaderboard.ts';

const BOARD = 'https://board.portal2.sr';
// (the dev server passes the board through, as its demos can't be read by
// another site; a built page asks its proxy (VITE_BOARD_PROXY: see
// deploy/board-proxy), else the board itself, whose demos it then can't read)
const BASE: string = import.meta.env.DEV ? '/__board' : (import.meta.env.VITE_BOARD_PROXY || BOARD).replace(/\/$/, '');
const SHOWN_RUNS = 200;
const SWARM_RUNS = 100;

export async function boardRuns(chamber: Chamber): Promise<BoardRun[]> {
	const res = await fetch(`${BASE}/chamber/${chamber.id}/json`);
	if (!res.ok) throw new Error(`the board answered ${res.status}`);
	return boardRunsOf(await res.json() as BoardJson, chamber.coop);
}
// A chamber's world records with demos, newest first, as runs to race: each
// noted with when it was set
export async function boardWrHistory(chamber: Chamber): Promise<BoardRun[]> {
	const res = await fetch(`${BASE}/changelog/json?chamber=${chamber.id}&wr=1`);
	if (!res.ok) throw new Error(`the board answered ${res.status}`);
	return wrHistoryOf(await res.json() as WrJson, chamber.coop).filter(r => r.players.some(p => p.hasDemo)).map(r => ({
		rank: 1, score: r.score, date: r.date, coop: chamber.coop, players: r.players,
		note: r.date ? new Date(r.date).toLocaleDateString('en', {month: 'short', year: 'numeric', timeZone: 'UTC'}) : null,
	}));
}
// A player's personal bests on a chamber, newest first, as runs to race:
// each noted with when it was set
export async function boardPbHistory(chamber: Chamber, steamId: string): Promise<BoardRun[]> {
	const res = await fetch(`${BASE}/changelog/json?chamber=${chamber.id}&profileNumber=${steamId}`);
	if (!res.ok) throw new Error(`the board answered ${res.status}`);
	return wrHistoryOf(await res.json() as WrJson, false).filter(r => r.players.some(p => p.hasDemo)).map(r => ({
		rank: 0, score: r.score, date: r.date, coop: chamber.coop, players: r.players,
		note: r.date ? new Date(r.date).toLocaleDateString('en', {month: 'short', year: 'numeric', timeZone: 'UTC'}) : null,
	}));
}
export interface DemoFile {
	bytes: Uint8Array;
	name: string;
	id: number;      // the board's id for it (its changelog entry's)
	note?: string;   // what the race calls it besides its players (a world record's date)
}

// A run's demos, once each: kept for the page's life, and in the browser's
// cache storage (the most recent few hundred) so racing the same runs again
// another day doesn't download them again. A demo on the board doesn't
// change once submitted
const demos = new Map<number, Promise<DemoFile>>();
const CACHE = 'board-demos';
const CACHED_DEMOS = 300;
const cacheKey = (id: number) => `/board-demo/${id}`;
async function cached(id: number): Promise<DemoFile | null> {
	try {
		const res = await (await caches.open(CACHE)).match(cacheKey(id));
		if (!res) return null;
		return {bytes: new Uint8Array(await res.arrayBuffer()), name: res.headers.get('X-File-Name') ?? `${id}.dem`, id};
	} catch {
		return null;  // (no cache storage: an insecure page, or storage blocked)
	}
}
async function keep(d: DemoFile) {
	try {
		const cache = await caches.open(CACHE);
		await cache.put(cacheKey(d.id), new Response(d.bytes, {headers: {'X-File-Name': d.name}}));
		// (the oldest let go past the limit: the cache lists them in the order put)
		const keys = await cache.keys();
		for (const k of keys.slice(0, Math.max(0, keys.length - CACHED_DEMOS))) await cache.delete(k);
	} catch {}
}
// (store: false for one only looked at, kept if it turns out to be wanted)
export function boardDemo(changelogId: number, store = true): Promise<DemoFile> {
	let p = demos.get(changelogId);
	if (!p) {
		p = (async () => {
			const kept = await cached(changelogId);
			if (kept) return kept;
			const res = await fetch(`${BASE}/getDemo?id=${changelogId}`);
			if (!res.ok) throw new Error(`the board answered ${res.status}`);
			const name = res.headers.get('X-File-Name') || decodeURIComponent(new URL(res.url).pathname.split('/').pop() ?? '') || `${changelogId}.dem`;
			const demo = {bytes: new Uint8Array(await res.arrayBuffer()), name, id: changelogId};
			if (store) keep(demo);
			return demo;
		})();
		demos.set(changelogId, p);
		// (held only while it's on its way: once here, the cache storage has it)
		p.finally(() => demos.get(changelogId) === p && demos.delete(changelogId)).catch(() => {});
	}
	return p;
}
// A co-op run whose partner isn't on the board with it (the board lists a
// player once, at their best: the partner's best was another run): their
// demo was submitted with it, next to it, as the board names its demos
// (map_time_steamid_id). Null where neither neighbour is it
async function partnerDemo(own: DemoFile, changelogId: number): Promise<DemoFile | null> {
	const run = /^(.+?_\d+)_(\d{17})_\d+\.dem$/i.exec(own.name);
	if (!run) return null;
	for (const id of [changelogId + 1, changelogId - 1]) {
		try {
			const d = await boardDemo(id, false);
			const other = /^(.+?_\d+)_(\d{17})_\d+\.dem$/i.exec(d.name);
			if (other && other[1] === run[1] && other[2] !== run[2]) {
				keep(d);
				return d;
			}
			demos.delete(id);  // (someone else's run: not kept)
		} catch {}
	}
	return null;
}
// a run's demos (those it has, and a co-op partner's left off the board),
// a few runs at a time
export async function runDemos(runs: BoardRun[], progress: (done: number) => void): Promise<DemoFile[][]> {
	const out: DemoFile[][] = runs.map(() => []);
	let next = 0, done = 0;
	const worker = async () => {
		while (next < runs.length) {
			const i = next++;
			const run = runs[i], players = run.players.filter(p => p.hasDemo);
			out[i] = await Promise.all(players.map(p => boardDemo(p.changelogId)));
			if (run.coop && out[i].length === 1) {
				const partner = await partnerDemo(out[i][0], players[0].changelogId);
				if (partner) out[i].push(partner);
			}
			progress(++done);
		}
	};
	await Promise.all([worker(), worker(), worker(), worker()]);
	return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);

// The dialog: pick a chamber (the shown run's map's to begin with), then
// open a run, or race the ticked ones or the top few against the shown one
export class BoardBrowser {
	private dialog: HTMLDialogElement;
	private chamber: Chamber | null = null;
	private runs: BoardRun[] = [];
	private picked = new Set<BoardRun>();
	private busy = false;
	onOpen: (files: DemoFile[]) => Promise<void> = async () => {};
	onRace: (runs: DemoFile[][]) => Promise<void> = async () => {};
	canRace: (chamber: Chamber | null) => boolean = () => false;
	onSwarm: (runs: {file: DemoFile; rank: number}[]) => Promise<void> = async () => {};

	constructor(dialog: HTMLDialogElement) {
		this.dialog = dialog;
		const select = this.el<HTMLSelectElement>('board-chamber');
		const group = (coop: boolean) => {
			const chapters = new Map<string, Chamber[]>();
			for (const c of CHAMBERS.filter(c => c.coop === coop)) chapters.set(c.chapter, [...chapters.get(c.chapter) ?? [], c]);
			return [...chapters].map(([chapter, list]) => `<optgroup label="${coop ? 'Co-op' : 'Single player'}: ${esc(chapter)}">${list.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
		};
		select.innerHTML = group(false) + group(true);
		select.onchange = () => this.show(CHAMBERS.find(c => c.id === Number(select.value))!);
		this.el('board-close').onclick = () => this.dialog.close();
		this.el('board-list').onclick = e => {
			const target = e.target as HTMLElement;
			const row = target.closest<HTMLElement>('tr[data-i]');
			if (!row) return;
			const run = this.runs[Number(row.dataset.i)];
			if (target.closest('.board-open')) return void this.openRun(run);
			if (target.closest('.board-race')) return void this.race([run]);
			if (target.closest('.board-pbs')) return void this.racePbHistory(run);
			if (!run.players.some(p => p.hasDemo)) return;
			if (this.picked.has(run)) this.picked.delete(run);
			else this.picked.add(run);
			this.showPicked();
		};
		for (const b of this.dialog.querySelectorAll<HTMLButtonElement>('.board-top')) {
			b.onclick = () => this.race(this.runs.filter(r => r.players.some(p => p.hasDemo)).slice(0, Number(b.dataset.n)));
		}
		this.el('board-race-picked').onclick = () => this.race(this.runs.filter(r => this.picked.has(r)));
		this.el('board-wr').onclick = () => this.raceWrHistory();
		this.el('board-swarm').onclick = () => this.swarm(SWARM_RUNS);
	}

	private el<T extends HTMLElement = HTMLElement>(id: string): T {
		return this.dialog.querySelector<T>(`#${id}`)!;
	}

	// opened on a map's chamber (else the one last looked at, or the first)
	openFor(map: string | null) {
		const chamber = (map && chamberFor(map)) || this.chamber || CHAMBERS[0];
		this.dialog.showModal();
		this.showButtons();
		// (the list drawn again: what can be raced depends on the run shown)
		if (chamber !== this.chamber || !this.runs.length) this.show(chamber);
		else this.showList();
	}

	private async show(chamber: Chamber) {
		this.chamber = chamber;
		this.el<HTMLSelectElement>('board-chamber').value = String(chamber.id);
		this.runs = [];
		this.picked.clear();
		this.showPicked();
		const list = this.el('board-list');
		list.innerHTML = '<div class="empty">Loading the board…</div>';
		try {
			const runs = await boardRuns(chamber);
			if (this.chamber !== chamber) return;
			this.runs = runs.slice(0, SHOWN_RUNS);
		} catch (e) {
			if (this.chamber === chamber) list.innerHTML = `<div class="empty">Couldn't load the board: ${esc((e as Error).message)}</div>`;
			return;
		}
		this.showList();
	}

	private showList() {
		this.el('board-list').innerHTML = !this.runs.length ? '<div class="empty">No runs on this chamber.</div>' : `<table>${this.runs.map((r, i) => {
			const demo = r.players.some(p => p.hasDemo);
			return `<tr data-i="${i}" class="${demo ? '' : 'no-demo'}" title="${esc(r.note ?? '')}">
				<td class="rank">${r.rank}</td>
				<td class="who">${r.players.map(p => esc(p.name)).join(' &amp; ')}</td>
				<td class="time">${fmtScore(r.score)}</td>
				<td class="date">${esc((r.date ?? '').slice(0, 10))}</td>
				<td class="acts">${demo ? `<button class="board-open" title="Open this run">Open</button><button class="board-race" title="Race this run against the one shown (or this chamber's best, opened first)">Race</button><button class="board-pbs" title="Race every personal best this player has set here (with demos) against the run shown, each named with when it was set">PBs</button>` : '<span class="muted">no demo</span>'}</td>
			</tr>`;
		}).join('')}</table>`;
		this.showPicked();
	}

	private showPicked() {
		for (const row of this.dialog.querySelectorAll<HTMLElement>('tr[data-i]')) row.classList.toggle('on', this.picked.has(this.runs[Number(row.dataset.i)]));
		const b = this.el<HTMLButtonElement>('board-race-picked');
		b.textContent = `Race ticked (${this.picked.size})`;
		this.showButtons();
	}

	// (with no run of the chamber shown, its best is opened first to race
	// against: the buttons work either way)
	private showButtons() {
		const idle = !this.busy && !!this.runs.length;
		for (const b of this.dialog.querySelectorAll<HTMLButtonElement>('.board-top')) b.disabled = !idle;
		this.el<HTMLButtonElement>('board-race-picked').disabled = !idle || !this.picked.size;
		this.el<HTMLButtonElement>('board-wr').disabled = !idle;
		this.el<HTMLButtonElement>('board-swarm').disabled = !idle;
		this.el('board-race-note').hidden = this.canRace(this.chamber);
	}

	// the chamber's best run (with a demo) opened, where no run of it is shown
	// to race against; the run opened (null: one already was), or false where
	// it couldn't be
	private async ensureShown(): Promise<BoardRun | null | false> {
		if (this.canRace(this.chamber)) return null;
		const best = this.runs.find(r => r.players.some(p => p.hasDemo));
		if (!best) return false;
		this.note('Opening the best run to race against…');
		const [files] = await runDemos([best], () => {});
		await this.onOpen(files);
		return this.canRace(this.chamber) ? best : false;
	}

	private note(text: string | null) {
		const el = this.el('board-note');
		el.hidden = text === null;
		el.textContent = text ?? '';
	}

	private async openRun(run: BoardRun) {
		if (this.busy) return;
		this.busy = true;
		this.note(`Downloading ${run.players.length > 1 ? 'the demos' : 'the demo'}…`);
		try {
			const [files] = await runDemos([run], () => {});
			await this.onOpen(files);
			this.dialog.close();
		} catch (e) {
			this.note(`Couldn't download it: ${(e as Error).message}`);
			return;
		} finally {
			this.busy = false;
			this.showButtons();
		}
		this.note(null);
	}

	// every world record the chamber has had (with a demo) raced against the
	// shown run, each noted with when it was set
	private async raceWrHistory() {
		if (this.busy || !this.chamber) return;
		this.note('Looking up the world records…');
		try {
			let runs = await boardWrHistory(this.chamber);
			if (!runs.length) return this.note('No world record on this chamber has a demo.');
			// (with nothing shown, the newest opened and the older ones raced)
			if (!this.canRace(this.chamber)) {
				const [newest, ...older] = runs;
				this.note('Opening the world record to race against…');
				const [files] = await runDemos([newest], () => {});
				await this.onOpen(files);
				if (!this.canRace(this.chamber)) return this.note("Couldn't open the world record (too old to read?).");
				runs = older;
				if (!runs.length) return this.dialog.close();
			}
			await this.race(runs, true);
		} catch (e) {
			this.note(`Couldn't look them up: ${(e as Error).message}`);
		}
	}

	// the top runs (one player's demo each) as the swarm
	private async swarm(count: number) {
		if (this.busy) return;
		const runs = this.runs.filter(r => r.players.some(p => p.hasDemo)).slice(0, count);
		this.busy = true;
		this.showButtons();
		let done = 0;
		const got: {file: DemoFile; rank: number}[] = [];
		try {
			if (await this.ensureShown() === false) return this.note("Couldn't open a run of this chamber to swarm around.");
			let next = 0;
			const worker = async () => {
				while (next < runs.length) {
					const r = runs[next++];
					try {
						got.push({file: await boardDemo(r.players.find(p => p.hasDemo)!.changelogId), rank: r.rank});
					} catch {}
					this.note(`Downloading ${++done} of ${runs.length}…`);
				}
			};
			await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
			this.note('Reading them…');
			await this.onSwarm(got.sort((a, b) => a.rank - b.rank));
			this.dialog.close();
			this.note(null);
		} catch (e) {
			this.note(`Couldn't make the swarm: ${(e as Error).message}`);
		} finally {
			this.busy = false;
			this.showButtons();
		}
	}

	// every personal best a run's (first) player set on the chamber
	private async racePbHistory(run: BoardRun) {
		if (this.busy || !this.chamber) return;
		const player = run.players[0];
		this.note(`Looking up ${player.name}'s personal bests…`);
		try {
			const runs = await boardPbHistory(this.chamber, player.steamId);
			if (!runs.length) return this.note(`None of ${player.name}'s personal bests here has a demo.`);
			await this.race(runs, true);
		} catch (e) {
			this.note(`Couldn't look them up: ${(e as Error).message}`);
		}
	}

	private async race(runs: BoardRun[], noted = false) {
		if (this.busy || !runs.length) return;
		this.busy = true;
		this.showButtons();
		try {
			const opened = await this.ensureShown();
			if (opened === false) return this.note("Couldn't open a run of this chamber to race against.");
			// (the run just opened not raced against itself)
			runs = runs.filter(r => r !== opened);
			if (!runs.length) return this.dialog.close();
			this.note(`Downloading 0 of ${runs.length}…`);
			let files = await runDemos(runs, done => this.note(`Downloading ${done} of ${runs.length}…`));
			if (noted) files = files.map((f, i) => f.map(d => ({...d, note: runs[i].note ?? undefined})));
			await this.onRace(files.filter(f => f.length));
			this.picked.clear();
			this.showPicked();
			this.dialog.close();
			this.note(null);
		} catch (e) {
			this.note(`Couldn't download them: ${(e as Error).message}`);
		} finally {
			this.busy = false;
			this.showButtons();
		}
	}
}
