import {GameFiles} from '../src/game/files.ts';
import {nodeFS} from './nodefs.ts';
const files = new GameFiles(nodeFS);
await files.init('portal2');
const b = (await files.read(process.argv[2]))!;
const m = new DataView(b.buffer, b.byteOffset, b.byteLength);
const bodyParts = m.getInt32(232, true), bpo = m.getInt32(236, true);
console.log('version', m.getInt32(4, true), 'bodyparts', bodyParts);
for (let i = 0; i < bodyParts; i++) {
	const bp = bpo + i * 16;
	const models = m.getInt32(bp + 4, true);
	for (let k = 0; k < models; k++) {
		const model = bp + m.getInt32(bp + 12, true) + k * 148;
		const meshes = m.getInt32(model + 72, true), mo = model + m.getInt32(model + 76, true);
		console.log(` bp ${i} model ${k}: ${meshes} meshes, numvertices ${m.getInt32(model + 80, true)}`);
		for (let j = 0; j < meshes; j++) {
			const me = mo + j * 116;
			const lods = Array.from({length: 8}, (_, l) => m.getInt32(me + 52 + l * 4, true));
			console.log(`   mesh ${j}: numvertices ${m.getInt32(me + 8, true)} offset ${m.getInt32(me + 12, true)} lod vertexes ${lods.join(',')}`);
		}
	}
}
