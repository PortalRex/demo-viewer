// Do the vertex lighting files line up with the models as the viewer reads them?
import {existsSync} from 'node:fs';
import {loadBsp} from '../src/game/bsp.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {GameFiles} from '../src/game/files.ts';
import {Zip} from '../src/game/zip.ts';
import {loadModel} from '../src/game/mdl.ts';
import {readVhv} from '../src/game/vhv.ts';
import {nodeFS, ROOT} from './nodefs.ts';
const files = new GameFiles(nodeFS);
await files.init('portal2');
for (const map of process.argv.slice(2)) {
	const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`))!;
	const bsp = await loadBsp(nodeFS, path, map);
	const zip = new Zip(bsp.pak!);
	files.mapPak = zip;
	let ok = 0, noFile = 0, badSum = 0, badCount = 0;
	const bad: string[] = [];
	for (const p of bsp.staticProps) {
		const b = (await zip.read(`sp_hdr_${p.index}.vhv`)) ?? (await zip.read(`sp_${p.index}.vhv`));
		if (!b) { noFile++; continue; }
		const vl = readVhv(b)!;
		const m = await loadModel(files, p.model, [1, 1, 1], p.skin);
		if (!m) continue;
		if (vl.checksum !== m.checksum) { badSum++; continue; }
		const mismatch = m.meshes.some((mesh, i) => mesh && (!vl.meshes[i] || vl.meshes[i]!.length / 4 !== mesh.vertexCount));
		if (mismatch) { badCount++; if (bad.length < 3) bad.push(`${p.model}: model ${m.meshes.map(x => x?.vertexCount).join(',')} vs vhv ${vl.meshes.map(x => x ? x.length / 4 : '-').join(',')}`); }
		else ok++;
	}
	console.log(`${map}: ${ok} match, ${badCount} vertex count mismatch, ${badSum} checksum mismatch, ${noFile} without a file`, bad);
}
