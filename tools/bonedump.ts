import {GameFiles} from '../src/game/files.ts';
import {loadSkeleton} from '../src/game/anim.ts';
import {nodeFS} from './nodefs.ts';
const files = new GameFiles(nodeFS);
await files.init('portal2');
const sk = await loadSkeleton(files, (await files.read(process.argv[2]))!);
for (const b of sk.bones) console.log(b.name, 'parent', b.parent, 'pos', b.pos.map(x => x.toFixed(2)), 'quat', b.quat.map(x => x.toFixed(3)), 'rot', b.rot.map(x => x.toFixed(3)), '\n  poseToBone', b.poseToBone.map(x => x.toFixed(2)).join(' '));
