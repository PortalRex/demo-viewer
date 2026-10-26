// A map's entities whose class name matches a pattern, with their keys:
//   node --experimental-strip-types tools/ents.ts <map> <class regex>
import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {nodeFS, ROOT} from './nodefs.ts';

const [map, pattern] = process.argv.slice(2);
const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
const bsp = await loadBsp(nodeFS, path, map);
const re = new RegExp(pattern, 'i');
for (const e of bsp.entities) if (re.test(e.classname ?? '')) console.log(JSON.stringify(e));
