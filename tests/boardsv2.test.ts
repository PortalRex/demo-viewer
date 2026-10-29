// The boards v2 site's JSON made into the viewer's board runs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {changelogRunsOf, coopRunsOf, dispositionName, spRunsOf} from '../src/core/boardsv2.ts';
import type {ChangelogRow, CoopRow} from '../src/core/boardsv2.ts';

test('a single player board: each run its demo id, times as UTC', () => {
	const [run] = spRunsOf([{rank: 1, map_data: {timestamp: '2024-05-01T12:00:00', profile_number: '76561198000000001', score: 1756, demo_id: 42, note: 'nice', user_name: 'Rex'}}]);
	assert.equal(run.rank, 1);
	assert.equal(run.date, '2024-05-01T12:00:00Z');
	assert.deepEqual(run.players, [{steamId: '76561198000000001', name: 'Rex', changelogId: 42, hasDemo: true}]);
});

test('a co-op board: both demos, the host first', () => {
	const row = (p1IsHost: boolean | null): CoopRow => ({rank: 2, map_data: {
		timestamp: null, score: 1800, profile_number1: '1', profile_number2: '2', user_name1: 'A', user_name2: 'B',
		demo_id1: 10, demo_id2: null, note1: null, note2: 'gg', p1_is_host: p1IsHost,
	}});
	const [known] = coopRunsOf([row(null)]);
	assert.deepEqual(known.players.map(p => [p.name, p.changelogId, p.hasDemo]), [['A', 10, true], ['B', 0, false]]);
	assert.equal(known.note, 'gg');
	const [second] = coopRunsOf([row(false)]);
	assert.equal(second.players[0].name, 'B');
});

test('changelog runs: with demos, not banned, a co-op record once, newest first', () => {
	const entry = (score: number, timestamp: string, demo: number | null, banned = false): ChangelogRow =>
		({timestamp, profile_number: String(demo), score, demo_id: demo, banned, user_name: `p${demo}`, note: null});
	const runs = changelogRunsOf([
		entry(2000, '2020-01-01T00:00:00', 1),
		entry(1900, '2021-03-01T00:00:00', 2),
		entry(1900, '2021-03-01T00:00:00', 3),
		entry(1800, '2022-01-01T00:00:00', null),
		entry(1700, '2023-01-01T00:00:00', 4, true),
	], true, 1);
	assert.deepEqual(runs.map(r => r.players[0].changelogId), [2, 1]);
	assert.equal(runs[0].note, 'Mar 2021');
	assert.equal(changelogRunsOf([entry(1900, '2021-03-01T00:00:00', 2), entry(1900, '2021-03-01T00:00:00', 3)], false, 0).length, 2);
});

test('a download\'s file name from its Content-Disposition', () => {
	assert.equal(dispositionName('attachment; filename="Buttons_1756_765_286767.dem"'), 'Buttons_1756_765_286767.dem');
	assert.equal(dispositionName('attachment; filename*=UTF-8\'\'a%20b.dem'), 'a b.dem');
	assert.equal(dispositionName(null), null);
});
