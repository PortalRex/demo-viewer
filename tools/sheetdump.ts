// A texture's sprite sheet:  node --experimental-strip-types tools/sheetdump.ts <path under materials>
import {nodeFS} from './nodefs.ts';
import {GameFiles} from '../src/game/files.ts';
import {readVtfSheet} from '../src/game/vtf.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const s = readVtfSheet((await files.read(`materials/${process.argv[2]}.vtf`))!);
if (!s) console.log('no sheet');
s?.forEach((q, i) => q && console.log(i, q.total.toFixed(2), q.clamp ? 'clamp' : 'loop', q.frames.length, q.frames.slice(0, 4).map(f => `${f.duration.toFixed(2)}@${f.uv.map(x => x.toFixed(3)).join(',')}`).join('  ')));
