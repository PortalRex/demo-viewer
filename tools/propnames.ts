// Flattened prop names of server classes, filtered:
//   node --experimental-strip-types tools/propnames.ts <file> <class regex> [prop regex]
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {parseDataTables} from '../src/net/datatables.ts';

const [path, cls, prop] = process.argv.slice(2);
const run = await loadRun(new Uint8Array(readFileSync(path)), basename(path));
const seg = run.segments[0];
const dt = parseDataTables((seg.dataTables ?? run.dataTables)!);
for (const c of dt.classes) {
	if (!new RegExp(cls).test(c.name)) continue;
	const names = [...c.index.keys()].filter(n => !prop || new RegExp(prop, 'i').test(n));
	console.log(c.name, names.join(' '));
}
