// Props of a server class whose names match a pattern: props.ts <demo> <class> <regex>
import {readFileSync} from 'node:fs';
import {loadRun} from '../src/core/load.ts';
import {parseDataTables} from '../src/net/datatables.ts';
const run = await loadRun(new Uint8Array(readFileSync(process.argv[2])), 'x');
const dt = parseDataTables(run.dataTables!);
const c = dt.classes.find(c => c.name === process.argv[3]);
if (!c) { console.log('classes:', dt.classes.map(c => c.name).filter(n => new RegExp(process.argv[3], 'i').test(n)).join(' ')); process.exit(); }
console.log(c.flat.map((f, i) => `${i}:${f.name}(t${f.prop.type},f${f.prop.flags.toString(16)},b${f.prop.bits},${f.prop.low}..${f.prop.high})`).filter(s => new RegExp(process.argv[4], 'i').test(s)).join('\n'));
