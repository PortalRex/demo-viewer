// Studio header flags (and illum position) of models:
//   node --experimental-strip-types tools/mdlflags.ts models/x.mdl...
import {GameFiles} from '../src/game/files.ts';
import {nodeFS} from './nodefs.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const NAMES: Record<number, string> = {16: 'AMBIENT_BOOST', 17: 'DO_NOT_CAST_SHADOWS', 13: 'CONSTANT_DIRECTIONAL_LIGHT_DOT', 4: 'USE_SHADOWLOD_MATERIALS', 8: 'STATIC_PROP', 1: 'USES_ENV_CUBEMAP'};
for (const name of process.argv.slice(2)) {
	const b = await files.read(name);
	if (!b) { console.log(name, 'missing'); continue; }
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const flags = v.getInt32(152, true);
	const bits = [...Array(32).keys()].filter(i => flags & (1 << i)).map(i => NAMES[i] ?? `bit${i}`);
	console.log(name, '0x' + flags.toString(16), bits.join(' '), 'illum', [92, 96, 100].map(o => v.getFloat32(o, true).toFixed(1)).join(','));
}
