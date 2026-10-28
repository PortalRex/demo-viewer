// Guess the time: a random board run to watch as you like, everything that
// would tell its time or whose it is hidden, then a guess at its whole time.
// Five rounds a game, points for how near each guess came, the best game
// remembered
import {CHAMBERS} from '../core/chambers.ts';
import type {Chamber} from '../core/chambers.ts';
import {fmtScore, parseTime} from '../core/leaderboard.ts';
import {boardDemo, boardRuns} from './board.ts';
import type {DemoFile} from './board.ts';

// what the page does for the quiz (main.ts)
export interface QuizHost {
	// the run opened and played from its start; false where it can't be
	// (too old to read)
	open(file: DemoFile): Promise<boolean>;
	// the quiz over: the page as it was (the last run left open)
	end(): void;
}

const ROUNDS = 5;
const FROM_TOP = 50;      // the runs picked among: a chamber's best few
const ZERO_AT = 0.2;      // a guess this far off (a share of the time) scores nothing

interface Round {
	chamber: Chamber;
	time: number;     // seconds, as the board has it
	rank: number;
	players: string;
	guess?: number;
	points?: number;
}

export class Quiz {
	private el: HTMLElement;
	private host: QuizHost;
	private rounds: Round[] = [];
	private busy = false;
	active = false;
	// whether this round's answer is out (its time and runner shown again)
	revealed = false;
	onReveal = () => {};

	constructor(el: HTMLElement, host: QuizHost) {
		this.el = el;
		this.host = host;
	}

	start() {
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
		this.el.innerHTML = `<div class="quiz-head"><b>Guess the time</b><span>Round ${Math.max(1, Math.min(round, ROUNDS))} of ${ROUNDS}</span><span>${this.score} points</span><button id="quiz-leave" title="Stop guessing (the run's time shown again)">Leave</button></div><div class="quiz-body">${body}</div>`;
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
				let file: DemoFile;
				try {
					file = await boardDemo(run.players.find(p => p.hasDemo)!.changelogId);
				} catch {
					continue;
				}
				this.revealed = false;
				if (!this.active || !(await this.host.open(file))) continue;
				const time = run.score / 100;
				const round: Round = {chamber, time, rank: run.rank, players: run.players.map(p => p.name).join(' & ')};
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
		this.show(`<p><b>${round.chamber.name}</b>${round.chamber.coop ? ' (co-op)' : ''}: a top ${FROM_TOP} run, whose and how long hidden. Watch it as you like (scrub, any camera), then guess its whole time.</p>
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
		const last = this.rounds.length >= ROUNDS;
		this.show(`<p>${round.points >= 900 ? 'Spot on!' : round.points >= 600 ? 'Close!' : round.points > 0 ? 'Not far.' : 'Way off.'}
			It's <b>${fmtScore(Math.round(round.time * 100))}</b>, #${round.rank} on ${round.chamber.name} by ${round.players}.
			You said ${fmtScore(Math.round(guess * 100))}: ${off.toFixed(2)} s ${guess > round.time ? 'too long' : 'too short'}, <b>+${round.points}</b>.</p>
			<button class="primary" id="quiz-next">${last ? 'See how you did' : 'Next run'}</button>`);
		(this.el.querySelector('#quiz-next') as HTMLButtonElement).onclick = () => (last ? this.results() : this.next());
		this.revealed = true;
		this.onReveal();
	}

	private results() {
		const score = this.score;
		let best = 0;
		try {
			best = Number(localStorage.getItem('quizBest')) || 0;
			if (score > best) localStorage.setItem('quizBest', String(score));
		} catch {}
		this.show(`<p><b>${score}</b> points of ${ROUNDS * 1000}${score > best ? ' — your best yet!' : ` (your best: ${best})`}</p>
			<ol class="quiz-results">${this.rounds.map(r => `<li>${r.chamber.name}: ${fmtScore(Math.round(r.time * 100))}, you said ${fmtScore(Math.round((r.guess ?? 0) * 100))} (+${r.points})</li>`).join('')}</ol>
			<button class="primary" id="quiz-again">Play again</button>`);
		(this.el.querySelector('#quiz-again') as HTMLButtonElement).onclick = () => {
			this.rounds = [];
			this.next();
		};
	}
}
