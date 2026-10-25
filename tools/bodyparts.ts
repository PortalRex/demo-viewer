// A model's body parts and the models in each (what m_nBody picks between):
//   node --experimental-strip-types tools/bodyparts.ts models/x.mdl
import {GameFiles} from '../src/game/files.ts';
import {nodeFS} from './nodefs.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
for (const path of process.argv.slice(2)) {
	const b = await files.read(path);
	if (!b) {
		console.log(path, 'missing');
		continue;
	}
	const m = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const str = (o: number) => {
		let s = '';
		for (let i = o; b[i]; i++) s += String.fromCharCode(b[i]);
		return s;
	};
	const n = m.getInt32(232, true), off = m.getInt32(236, true);
	for (let i = 0; i < n; i++) {
		const bp = off + i * 16;
		const models = m.getInt32(bp + 4, true), base = m.getInt32(bp + 8, true), mo = bp + m.getInt32(bp + 12, true);
		const names = [];
		for (let k = 0; k < models; k++) names.push(`${str(mo + k * 148)}(${m.getInt32(mo + k * 148 + 72, true)} meshes)`);
		console.log(`${str(bp + m.getInt32(bp, true))} base=${base}: ${names.join(', ')}`);
	}
}
