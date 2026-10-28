// The leaderboard's rows made into runs, its chambers, and links to them
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boardRunsOf, fmtScore} from '../src/core/leaderboard.ts';
import type {BoardJson} from '../src/core/leaderboard.ts';
import {CHAMBERS, chamberFor} from '../src/core/chambers.ts';
import {linkHash, parseLink} from '../src/core/links.ts';

const row = (name: string, rank: number, score: number, changelogId: number, hasDemo = 1) =>
	({scoreData: {changelogId, playerRank: rank, score, date: '2024-01-01T00:00:00Z', hasDemo, note: null}, userData: {boardname: name}});

test("co-op rows with the same time, submitted together, are one run, best first", () => {
	// (keyed by Steam id, as the board gives them: not in rank order)
	const json: BoardJson = {
		'76561198000000003': row('C', 3, 1800, 500),
		'76561198000000001': row('A', 1, 1756, 300),
		'76561198000000004': row('D', 3, 1800, 900),  // the same time, but not submitted with C
		'76561198000000002': row('B', 1, 1756, 301),
	};
	const coop = boardRunsOf(json, true);
	assert.deepEqual(coop.map(r => r.players.map(p => p.name)), [['A', 'B'], ['C'], ['D']]);
	assert.equal(coop[0].rank, 1);
	// single player: each row its own run
	assert.equal(boardRunsOf(json, false).length, 4);
});

test("times as the board shows them", () => {
	assert.equal(fmtScore(1756), '17.56');
	assert.equal(fmtScore(995), '9.95');
	assert.equal(fmtScore(6230), '1:02.30');
	assert.equal(fmtScore(16843), '2:48.43');
});

test('every chamber once, each with its map', () => {
	assert.equal(CHAMBERS.length, 108);
	assert.equal(new Set(CHAMBERS.map(c => c.id)).size, 108);
	assert.equal(new Set(CHAMBERS.map(c => c.map)).size, 108);
	assert.equal(chamberFor('mp_coop_race_2')?.name, 'Buttons');
	assert.equal(chamberFor('sp_a2_fizzler_intro')?.coop, false);
});

test('a leaderboard link carries its runs, split screen and moment', () => {
	const link = {
		load: null,
		board: {id: 286767, partners: [286768], raced: [304459, 304460, 347573], split: '1'},
		moment: {tick: 700, view: '3d' as const, camera: {mode: 'free' as const, pos: [1, 2.5, -3], ang: [10, 90]}},
	};
	const hash = linkHash(link);
	assert.equal(hash, '#board=286767&with=286768&race=304459,304460,347573&split=1&t=700&view=3d&cam=free&pos=1,2.5,-3&ang=10,90');
	const back = parseLink(hash);
	assert.deepEqual(back.board, link.board);
	assert.deepEqual(back.moment, {...link.moment, camera: {...link.moment.camera, offset: undefined}, file: undefined});
});

test('a link to a file or a URL', () => {
	assert.equal(linkHash({load: 'runs/a.dem', board: null, moment: {tick: 5, view: 'top'}}), '#load=runs/a.dem&t=5&view=top');
	assert.equal(linkHash({load: null, board: null, moment: {tick: 5, view: 'side', file: 'a.dem'}}), '#file=a.dem&t=5&view=side');
	assert.deepEqual(parseLink('#load=runs/a.dem'), {load: 'runs/a.dem', board: null, moment: null});
});
