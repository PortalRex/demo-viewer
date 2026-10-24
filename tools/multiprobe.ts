import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRuns} from '../src/core/load.ts';
import {segmentDuration} from '../src/core/model.ts';
const run = await loadRuns(process.argv.slice(2).map(p => ({bytes: new Uint8Array(readFileSync(p)), name: basename(p)})));
console.log(run.fileName, run.segments.map(s => `${s.index}:${s.map} ${segmentDuration(s).toFixed(2)}s (${s.endReason}) tables=${!!s.dataTables}`).join(' | '));
