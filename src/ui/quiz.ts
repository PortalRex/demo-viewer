// Guess the time, or the runner: a random board run to watch as you like,
// everything that would tell its time or whose it is hidden, then a guess at
// its whole time (points for how near it came) or at whose it is, of four
// runners from the chamber's board (points for the right one). Five rounds
// a game, the best game of each remembered
import {CHAMBERS} from '../core/chambers.ts';
import type {Chamber} from '../core/chambers.ts';
import {fmtScore, parseTime} from '../core/leaderboard.ts';
import type {BoardRun} from '../core/leaderboard.ts';
import {boardDemo, boardRuns} from './board.ts';
import type {DemoFile} from './board.ts';

// what the page does for the quiz (main.ts)
export interface QuizHost {
	// the run opened and loaded, in 3D and paused at its start; false where it
	// can't be (too old to read)
	open(file: DemoFile): Promise<boolean>;
	// the quiz over: the page as it was (the last run left open)
	end(): void;
}

const ROUNDS = 5;
const FROM_TOP = 50;      // the runs picked among: a chamber's best few
const ZERO_AT = 0.2;      // a guess this far off (a share of the time) scores nothing
const CHOICES = 4;        // runners to pick from

export type QuizMode = 'time' | 'runner';
const TITLES: Record<QuizMode, string> = {time: 'Guess the time', runner: 'Guess the runner'};
const BEST_KEYS: Record<QuizMode, string> = {time: 'quizBest', runner: 'quizBestRunner'};

interface Round {
	chamber: Chamber;
	time: number;     // seconds, as the board has it
	rank: number;
	players: string;
	choices: string[];   // (runner mode) the runners to pick from, the right one among them
	guess?: number;
	pick?: string;
	points?: number;
}

const shuffle = <T>(a: T[]): T[] => {
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
};
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);
const who = (r: BoardRun) => r.players.map(p => p.name).join(' & ');

export class Quiz {
	private el: HTMLElement;
	private host: QuizHost;
	private rounds: Round[] = [];
	private busy = false;
	active = false;
	mode: QuizMode = 'time';
	// whether this round's answer is out (its time and runner shown again)
	revealed = false;
	onReveal = () => {};

	constructor(el: HTMLElement, host: QuizHost) {
		this.el = el;
		this.host = host;
	}

	start(mode: QuizMode) {
		this.mode = mode;
		this.active = true;
		this.rounds = [];
		document.body.classList.add('quiz');
		this.el.hidden = false;
		this.next();
	}

	leave() {
		this.active = false;
		document.body.classList.remove('quiz');
		this.el.hidden = true;
		this.host.end();
	}

	private get score() {
		return this.rounds.reduce((n, r) => n + (r.points ?? 0), 0);
	}

	// (round: the one being played; the one being picked while it's picked)
	private show(body: string, round = this.rounds.length) {
		this.el.innerHTML = `<div class="quiz-head"><b>${TITLES[this.mode]}</b><span>Round ${Math.max(1, Math.min(round, ROUNDS))} of ${ROUNDS}</span><span>${this.score} points</span><button id="quiz-leave" title="Stop guessing (the run's time shown again)">Leave</button></div><div class="quiz-body">${body}</div>`;
		(this.el.querySelector('#quiz-leave') as HTMLButtonElement).onclick = () => this.leave();
	}

	// a random chamber's random top run (one with a demo the viewer reads)
	private async next() {
		if (this.busy) return;
		this.busy = true;
		this.show('Picking a run…', this.rounds.length + 1);
		try {
			for (let tries = 0; tries < 8 && this.active; tries++) {
				const chamber = CHAMBERS[Math.floor(Math.random() * CHAMBERS.length)];
				let runs;
				try {
					runs = (await boardRuns(chamber)).filter(r => r.players.some(p => p.hasDemo)).slice(0, FROM_TOP);
				} catch {
					continue;
				}
				if (!runs.length) continue;
				const run = runs[Math.floor(Math.random() * runs.length)];
				// (the others: other runners on the chamber's board, a name once)
				const others = shuffle([...new Set(runs.map(who))].filter(w => w !== who(run))).slice(0, CHOICES - 1);
				if (this.mode === 'runner' && others.length < CHOICES - 1) continue;
				let file: DemoFile;
				try {
					file = await boardDemo(run.players.find(p => p.hasDemo)!.changelogId);
				} catch {
					continue;
				}
				this.revealed = false;
				this.show('Loading the run…', this.rounds.length + 1);
				if (!this.active || !(await this.host.open(file))) continue;
				const time = run.score / 100;
				const round: Round = {chamber, time, rank: run.rank, players: who(run), choices: shuffle([who(run), ...others])};
				this.rounds.push(round);
				this.watch(round);
				return;
			}
			if (this.active) this.show('Couldn\'t get a run from the leaderboard. <button id="quiz-retry">Try again</button>');
			this.el.querySelector<HTMLButtonElement>('#quiz-retry')?.addEventListener('click', () => this.next());
		} finally {
			this.busy = false;
		}
	}

	private watch(round: Round) {
		const intro = `<p><b>${round.chamber.name}</b>${round.chamber.coop ? ' (co-op)' : ''}: a top ${FROM_TOP} run, whose and how long hidden. Watch it as you like (scrub, any camera), then`;
		if (this.mode === 'runner') {
			this.show(`${intro} pick whose it is.</p>
				<div class="quiz-choices">${round.choices.map((c, i) => `<button data-i="${i}">${esc(c)}</button>`).join('')}</div>`);
			for (const b of this.el.querySelectorAll<HTMLButtonElement>('.quiz-choices button')) b.onclick = () => this.revealRunner(round, round.choices[Number(b.dataset.i)]);
			return;
		}
		this.show(`${intro} guess its whole time.</p>
			<form id="quiz-form"><input id="quiz-guess" placeholder="Your guess: 12.34 or 1:02.30" autocomplete="off"> <button class="primary">Guess</button></form>`);
		const input = this.el.querySelector('#quiz-guess') as HTMLInputElement;
		(this.el.querySelector('#quiz-form') as HTMLFormElement).onsubmit = e => {
			e.preventDefault();
			const guess = parseTime(input.value);
			if (guess === null) {
				input.setCustomValidity('A time: seconds (12.34) or minutes and seconds (1:02.30)');
				input.reportValidity();
				return;
			}
			this.reveal(round, guess);
		};
		input.oninput = () => input.setCustomValidity('');
	}

	private reveal(round: Round, guess: number) {
		round.guess = guess;
		const off = Math.abs(guess - round.time);
		round.points = Math.round(1000 * Math.max(0, 1 - off / (round.time * ZERO_AT)));
		this.answer(`${round.points >= 900 ? 'Spot on!' : round.points >= 600 ? 'Close!' : round.points > 0 ? 'Not far.' : 'Way off.'}
			It's <b>${fmtScore(Math.round(round.time * 100))}</b>, #${round.rank} on ${round.chamber.name} by ${esc(round.players)}.
			You said ${fmtScore(Math.round(guess * 100))}: ${off.toFixed(2)} s ${guess > round.time ? 'too long' : 'too short'}, <b>+${round.points}</b>.`);
	}

	private revealRunner(round: Round, pick: string) {
		round.pick = pick;
		const right = pick === round.players;
		round.points = right ? 1000 : 0;
		this.answer(`${right ? 'Right!' : `No, not ${esc(pick)}.`}
			It's <b>${esc(round.players)}</b>, #${round.rank} on ${round.chamber.name} in ${fmtScore(Math.round(round.time * 100))}, <b>+${round.points}</b>.`);
	}

	// a round's answer out, and on to the next
	private answer(text: string) {
		const last = this.rounds.length >= ROUNDS;
		this.show(`<p>${text}</p>
			<button class="primary" id="quiz-next">${last ? 'See how you did' : 'Next run'}</button>`);
		(this.el.querySelector('#quiz-next') as HTMLButtonElement).onclick = () => (last ? this.results() : this.next());
		this.revealed = true;
		this.onReveal();
	}

	private results() {
		const score = this.score;
		let best = 0;
		try {
			best = Number(localStorage.getItem(BEST_KEYS[this.mode])) || 0;
			if (score > best) localStorage.setItem(BEST_KEYS[this.mode], String(score));
		} catch {}
		const line = (r: Round) => this.mode === 'runner'
			? `${r.chamber.name}: ${esc(r.players)}${r.pick === r.players ? '' : `, you said ${esc(r.pick ?? '')}`} (+${r.points})`
			: `${r.chamber.name}: ${fmtScore(Math.round(r.time * 100))}, you said ${fmtScore(Math.round((r.guess ?? 0) * 100))} (+${r.points})`;
		this.show(`<p><b>${score}</b> points of ${ROUNDS * 1000}${score > best ? ' — your best yet!' : ` (your best: ${best})`}</p>
			<ol class="quiz-results">${this.rounds.map(r => `<li>${line(r)}</li>`).join('')}</ol>
			<button class="primary" id="quiz-again">Play again</button>`);
		(this.el.querySelector('#quiz-again') as HTMLButtonElement).onclick = () => {
			this.rounds = [];
			this.next();
		};
	}
}
