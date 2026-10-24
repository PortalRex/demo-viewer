// A model as the viewer loads it: groups, triangle counts, material candidates and whether they resolve:
//   node --experimental-strip-types tools/mdlinfo.ts models/x.mdl
import {GameFiles} from '../src/game/files.ts';
import {Materials} from '../src/game/materials.ts';
import {loadModel} from '../src/game/mdl.ts';
import {nodeFS} from './nodefs.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const mats = new Materials(files);
for (const path of process.argv.slice(2)) {
	const m = await loadModel(files, path, [1, 1, 1]);
	if (!m) {
		console.log(path, 'failed');
		continue;
	}
	console.log(path, Object.keys(m).join(','));
	for (const g of m.groups) {
		const found: string[] = [];
		for (const c of g.materialCandidates) {
			const info = await mats.get(c);
			found.push(`${c}${info.found ? `[${info.shader} ${info.baseTexture} at=${info.alphaTest} tr=${info.translucent}]` : ''}`);
		}
		console.log(`  ${g.positions.length / 9} tris  ${found.join(' | ')}`);
	}
}
