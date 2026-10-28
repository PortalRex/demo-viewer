// A chamber's leaderboard as board.portal2.sr gives it (its JSON: a row a
// player, keyed by Steam id) made into runs, best first: a co-op run's two
// players' rows (the same time, submitted together) as one
export interface BoardPlayer {
	steamId: string;
	name: string;
	changelogId: number;
	hasDemo: boolean;
}
// a run on the board: one player's, or a co-op pair's
export interface BoardRun {
	rank: number;
	score: number;  // hundredths of a second
	date: string | null;
	note: string | null;
	players: BoardPlayer[];
	coop: boolean;
}
export type BoardJson = Record<string, {
	scoreData: {changelogId: number; playerRank: number; score: number; date: string | null; hasDemo: number; note: string | null};
	userData: {boardname: string};
}>;

const PAIRED_IDS = 3;  // a co-op pair's rows' changelog ids at most this far apart

export function boardRunsOf(json: BoardJson, coop: boolean): BoardRun[] {
	// (keyed by Steam id, which come back in number order: by rank instead)
	const rows = Object.entries(json).map(([steamId, e]) => ({steamId, ...e})).sort((a, b) => a.scoreData.playerRank - b.scoreData.playerRank);
	const runs: BoardRun[] = [];
	const paired = new Set<string>();
	const player = (x: typeof rows[number]): BoardPlayer => ({steamId: x.steamId, name: x.userData.boardname, changelogId: x.scoreData.changelogId, hasDemo: !!x.scoreData.hasDemo});
	for (const r of rows) {
		if (paired.has(r.steamId)) continue;
		const run: BoardRun = {rank: r.scoreData.playerRank, score: r.scoreData.score, date: r.scoreData.date, note: r.scoreData.note, players: [player(r)], coop};
		if (coop) {
			const partner = rows.find(x => x !== r && !paired.has(x.steamId) && x.scoreData.score === r.scoreData.score
				&& Math.abs(x.scoreData.changelogId - r.scoreData.changelogId) <= PAIRED_IDS);
			if (partner) {
				paired.add(partner.steamId);
				run.players.push(player(partner));
			}
		}
		paired.add(r.steamId);
		runs.push(run);
	}
	return runs;
}

// A chamber's world records, newest first, as the board's changelog gives
// them (?wr=1: a row a player, a co-op record's two submitted together, the
// same time on the same day); banned ones left out
export type WrJson = {score: number; id: number; player_name: string; profile_number: string; time_gained: string | null; hasDemo: number; banned: number; note: string | null}[];
export interface WrRun {
	date: string | null;
	score: number;
	players: BoardPlayer[];
}
export function wrHistoryOf(json: WrJson, coop: boolean): WrRun[] {
	const out: WrRun[] = [];
	for (const e of json) {
		if (e.banned) continue;
		const player: BoardPlayer = {steamId: e.profile_number, name: e.player_name, changelogId: e.id, hasDemo: !!e.hasDemo};
		const day = e.time_gained?.slice(0, 10) ?? null;
		const pair = coop ? out.find(r => r.score === e.score && (r.date?.slice(0, 10) ?? null) === day && r.players.length === 1) : undefined;
		if (pair) pair.players.push(player);
		else out.push({date: e.time_gained, score: e.score, players: [player]});
	}
	return out;
}

// a time in hundredths as the board shows it (17.56, 1:02.30)
export const fmtScore = (cs: number) => {
	const m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60, c = cs % 100;
	return `${m ? `${m}:${String(s).padStart(2, '0')}` : s}.${String(c).padStart(2, '0')}`;
};
