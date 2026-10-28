// A run of many maps (a full game's demos played back to back) by chamber:
// the segments in a row on one map are one chamber's (a death or a save
// loaded starts a segment, not a chamber), timed as the demos have them
import type {Run} from '../core/model.ts';
import {segmentDuration} from '../core/model.ts';
import {chamberFor} from '../core/chambers.ts';

export interface ChamberStretch {
	map: string;
	name: string;     // the chamber's (challenge mode's) name, else the map's
	first: number;    // its first segment
	last: number;     // and last
	seconds: number;
}

export function chamberStretches(run: Run): ChamberStretch[] {
	const out: ChamberStretch[] = [];
	run.segments.forEach((s, i) => {
		const last = out[out.length - 1];
		if (last && last.map === s.map) {
			last.last = i;
			last.seconds += segmentDuration(s);
		} else {
			out.push({map: s.map, name: chamberFor(s.map)?.name ?? s.map, first: i, last: i, seconds: segmentDuration(s)});
		}
	});
	return out;
}
