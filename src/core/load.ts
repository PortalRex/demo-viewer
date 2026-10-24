import {isSarp, readSarp} from './sarp.ts';
import {isDem, readDem} from './dem.ts';
import type {Run} from './model.ts';

// Several files as one run: a speedrun's demos (name.dem, name_2.dem, ...)
// in order, each one or more segments.
export async function loadRuns(files: {bytes: Uint8Array; name: string}[]): Promise<Run> {
	if (files.length === 1) return loadRun(files[0].bytes, files[0].name);
	const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
	// "fullgame.dem" sorts after "fullgame_2.dem"; the unnumbered one is first
	const stem = (n: string) => n.replace(/\.[^.]+$/, '');
	sorted.sort((a, b) => {
		const sa = stem(a.name), sb = stem(b.name);
		if (sb.startsWith(sa + '_')) return -1;
		if (sa.startsWith(sb + '_')) return 1;
		return 0;
	});
	const runs: Run[] = [];
	for (const f of sorted) runs.push(await loadRun(f.bytes, f.name));
	const first = runs[0];
	const segments = runs.flatMap((r, i) => r.segments.map(s => ({...s, dataTables: s.dataTables ?? r.dataTables, endReason: s.endReason ?? (runs.length > 1 ? sorted[i].name : undefined)})));
	segments.forEach((s, i) => (s.index = i));
	return {
		...first,
		fileName: `${sorted[0].name} + ${sorted.length - 1} more`,
		fileSize: runs.reduce((n, r) => n + r.fileSize, 0),
		info: [...first.info, ['Files', sorted.map(f => f.name).join(', ')]],
		segments,
		verification: runs.every(r => r.verification) ? first.verification : undefined,
		warnings: runs.flatMap((r, i) => r.warnings.map(w => `${sorted[i].name}: ${w}`)),
	};
}

export async function loadRun(bytes: Uint8Array, fileName: string): Promise<Run> {
	if (isSarp(bytes)) return readSarp(bytes, fileName);
	if (isDem(bytes)) return readDem(bytes, fileName);
	throw new Error('Not a SAR proof (.sarp) or Source demo (.dem).');
}
