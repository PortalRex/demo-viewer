// A model's bone names (filtered):  node --experimental-strip-types tools/bones.ts models/x.mdl [regex]
import {GameFiles} from '../src/game/files.ts';
import {loadSkeleton} from '../src/game/anim.ts';
import {nodeFS} from './nodefs.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const re = new RegExp(process.argv[3] ?? '.', 'i');
const sk = await loadSkeleton(files, (await files.read(process.argv[2]))!);
console.log(sk.bones.map((b, i) => [i, b.name, b.parent] as const).filter(([, n]) => re.test(n)).map(([i, n, p]) => `${i}:${n}<${p}`).join('  '));
