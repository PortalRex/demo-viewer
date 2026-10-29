// The game folder as a file input gives it (browsers without folder access:
// Brave, Firefox)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FileListFS} from '../src/game/gamefs.ts';

const file = (path: string, text: string) => {
	const f = new File([text], path.split('/').pop()!);
	Object.defineProperty(f, 'webkitRelativePath', {value: path});
	return f;
};

test('files by their path in the picked folder, regardless of case', async () => {
	const fs = new FileListFS([
		file('Portal 2/portal2/gameinfo.txt', 'GameInfo'),
		file('Portal 2/portal2/maps/sp_a1_intro1.bsp', 'VBSP0123'),
		file('Portal 2/portal2/materials/Metal/wall.vmt', 'x'),
		file('Portal 2/portal2/cfg/config.cfg', 'y'),
	]);
	assert.equal(fs.label, 'Portal 2');
	assert.equal(await fs.size('portal2/gameinfo.txt'), 8);
	assert.deepEqual([...await fs.read('PORTAL2/maps/sp_a1_intro1.bsp', 4, 4) ?? []], [...new TextEncoder().encode('0123')]);
	assert.equal(await fs.read('portal2/maps/nope.bsp'), null);
	// (the asset folders' files: not cfg/)
	assert.deepEqual([...await fs.list('portal2') ?? []].sort(), ['maps/sp_a1_intro1.bsp', 'materials/metal/wall.vmt']);
});
