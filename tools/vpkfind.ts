import {Vpk} from '../src/game/vpk.ts';
import {nodeFS} from './nodefs.ts';
for (const d of ['update', 'portal2_dlc2', 'portal2_dlc1', 'portal2']) {
	const v = await Vpk.open(nodeFS, `${d}/pak01_dir.vpk`);
	if (!v) continue;
	for (const k of v.entries.keys()) if (k.includes(process.argv[2])) console.log(d, k);
}
