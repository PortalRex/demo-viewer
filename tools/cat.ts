import {GameFiles} from '../src/game/files.ts';
import {nodeFS} from './nodefs.ts';
const files = new GameFiles(nodeFS);
await files.init('portal2');
for (const p of process.argv.slice(2)) console.log(`--- ${p}\n${await files.text(p)}`);
