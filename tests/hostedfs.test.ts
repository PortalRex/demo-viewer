// The game's files as the site hosts them: looked up in the index, fetched
// once by their hash, read whole or a piece at a time
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HostedFS} from '../src/game/gamefs.ts';

function serve(files: Record<string, Uint8Array>) {
	const index: Record<string, [string, number]> = {};
	const blobs = new Map<string, Uint8Array>();
	Object.entries(files).forEach(([path, bytes], i) => {
		const hash = `${i}`.padStart(32, 'a');
		index[path] = [hash, bytes.length];
		blobs.set(`/game/v1/files/${hash.slice(0, 2)}/${hash}`, bytes);
	});
	const fetched: string[] = [];
	globalThis.fetch = (async (url: string) => {
		fetched.push(url);
		if (url === '/game/v1/index.json') return new Response(JSON.stringify({files: index}), {headers: {'content-type': 'application/json'}});
		const b = blobs.get(url);
		return b ? new Response(b) : new Response(null, {status: 404});
	}) as typeof fetch;
	return fetched;
}

test('files read by path, whole or in pieces, each fetched once', async () => {
	const fetched = serve({
		'portal2/maps/sp_a1_intro1.bsp': new Uint8Array([1, 2, 3, 4, 5, 6]),
		'portal2/materials/metal/wall.vtf': new Uint8Array([9, 9]),
		'portal2/media/fizzler.bik': new Uint8Array([7]),
	});
	const fs = (await HostedFS.open('/game/v1/'))!;
	assert.deepEqual([...(await fs.read('portal2/maps/sp_a1_intro1.bsp'))!], [1, 2, 3, 4, 5, 6]);
	assert.deepEqual([...(await fs.read('PORTAL2\\maps\\sp_a1_intro1.bsp', 2, 3))!], [3, 4, 5]);
	assert.equal(await fs.size('portal2/materials/metal/wall.vtf'), 2);
	assert.equal(await fs.read('portal2/maps/nope.bsp'), null);
	assert.equal(await fs.size('portal2/maps/nope.bsp'), null);
	// (the map's file fetched once for both reads)
	assert.equal(fetched.filter(u => u.includes('/files/')).length, 1);
	// (the loose asset folders listed; media isn't one of them)
	assert.deepEqual([...await fs.list('portal2')].sort(), ['maps/sp_a1_intro1.bsp', 'materials/metal/wall.vtf']);
});

test('no hosted files where the index is missing or not JSON', async () => {
	globalThis.fetch = (async () => new Response('<html>the site</html>', {headers: {'content-type': 'text/html'}})) as typeof fetch;
	assert.equal(await HostedFS.open('/game/v1/'), null);
	globalThis.fetch = (async () => new Response(null, {status: 404})) as typeof fetch;
	assert.equal(await HostedFS.open('/game/v1/'), null);
});
