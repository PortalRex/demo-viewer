// Whether recordings come from before Portal 2's build 8873 (their data
// tables still have DT_PointSurvey) and so need demofixup before the game
// plays them. Prints "old" or "new" per file:
//   node --experimental-strip-types tools/needsfixup.ts <files...>
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {parseDataTables} from '../src/net/datatables.ts';

for (const path of process.argv.slice(2)) {
	const run = await loadRun(new Uint8Array(readFileSync(path)), basename(path));
	const data = run.segments[0]?.dataTables ?? run.dataTables;
	const old = !!data && parseDataTables(data).tables.has('DT_PointSurvey');
	console.log(`${old ? 'old' : 'new'} ${path}`);
}
