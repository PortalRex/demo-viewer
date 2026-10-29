// The boards v2 site's API (PortalRex/portal2-cm-boards-v2), for the viewer
// when it's served by that site (VITE_BOARDS_API): a chamber's board, its
// changelog, made into the same runs as board.portal2.sr's. A player's
// `changelogId` here is their run's demo id (what /demos/{id}/file takes),
// the id links and the demo cache go by
import type {BoardPlayer, BoardRun} from './leaderboard.ts';

export interface SpRow {
	map_data: {timestamp: string | null; profile_number: string; score: number; demo_id: number | null; note: string | null; user_name: string | null};
	rank: number;
}
export interface CoopRow {
	map_data: {
		timestamp: string | null; score: number;
		profile_number1: string; profile_number2: string;
		user_name1: string; user_name2: string | null;
		demo_id1: number | null; demo_id2: number | null;
		note1: string | null; note2: string | null;
		p1_is_host: boolean | null;
	};
	rank: number;
}
export interface ChangelogRow {
	timestamp: string | null;
	profile_number: string;
	score: number;
	demo_id: number | null;
	banned: boolean;
	user_name: string;
	note: string | null;
}

// (times without a zone are UTC)
const utc = (t: string | null) => (t ? `${t.replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? '' : 'Z'}` : null);
const player = (steamId: string, name: string | null, demo: number | null): BoardPlayer => ({steamId, name: name ?? steamId, changelogId: demo ?? 0, hasDemo: !!demo});

export function spRunsOf(rows: SpRow[]): BoardRun[] {
	return rows.map(r => ({
		rank: r.rank, score: r.map_data.score, date: utc(r.map_data.timestamp), note: r.map_data.note, coop: false,
		players: [player(r.map_data.profile_number, r.map_data.user_name, r.map_data.demo_id)],
	}));
}

export function coopRunsOf(rows: CoopRow[]): BoardRun[] {
	return rows.map(({map_data: m, rank}) => {
		const players = [player(m.profile_number1, m.user_name1, m.demo_id1), player(m.profile_number2, m.user_name2, m.demo_id2)];
		// (the host, blue, first where it's known: their demo opens, the partner's races)
		if (m.p1_is_host === false) players.reverse();
		return {rank, score: m.score, date: utc(m.timestamp), note: m.note1 ?? m.note2, coop: true, players};
	});
}

// changelog entries (with demos, not banned), newest first, as runs each
// noted with when it was set
// (a co-op record is an entry for each player: one of them raced)
export function changelogRunsOf(rows: ChangelogRow[], coop: boolean, rank: number): BoardRun[] {
	const seen = new Set<string>();
	return rows.filter(r => r.demo_id && !r.banned)
		.filter(r => {
			if (!coop) return true;
			const key = `${r.score}:${r.timestamp}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map(r => ({
			rank, score: r.score, date: utc(r.timestamp), coop,
			players: [player(r.profile_number, r.user_name, r.demo_id)],
			note: r.timestamp ? new Date(utc(r.timestamp)!).toLocaleDateString('en', {month: 'short', year: 'numeric', timeZone: 'UTC'}) : null,
		}))
		.sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
}

// a download's file name, from its Content-Disposition
export function dispositionName(header: string | null): string | null {
	if (!header) return null;
	const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
	if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
	return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1].trim() ?? null;
}
