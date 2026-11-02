// The game files the 3D view reads, built for hosting (served by the boards
// site at /game/<version>/): every campaign map's files as tools/assetplan.ts
// found them, textures cut to the 512 pixels the 3D view loads, the movies
// its in-world screens play, the HUD's fonts and strings, and the movie
// decoder's tables. Each file is stored once, under the hash of its bytes,
// gzipped (nginx serves the .gz as it is); index.json maps every path the
// viewer asks for (as under the game's folder: portal2/materials/..., the maps
// under their own game folder) to its hash and size.
//   node --experimental-strip-types tools/build-assets.ts [plan.json] [out folder]
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {GameFiles} from '../src/game/files.ts';
import {trimVtf} from '../src/game/vtf.ts';
import {nodeFS, ROOT} from './nodefs.ts';

const VERSION = 'v1';
const TEXTURES = 512;
const SCREEN_MOVIES = 5.5 * 2 ** 20;  // movies up to this size are in-world screens (larger: menus, cinematics)
const NOT_SCREENS = /^e1912_end\.bik$/;
const [planPath = 'build/assetplan.json', outRoot = 'build/gameassets'] = process.argv.slice(2);
const out = `${outRoot}/${VERSION}`;

const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {maps: {map: string; files: string[]}[]; extras: string[]};
const files = new GameFiles(nodeFS);
await files.init('portal2');

// every path the viewer asks for, and how to read it: through the game's file
// system (what the walker recorded: materials, models, ...) or straight from
// the install (the maps, the fonts, the decoder's tables)
const wanted = new Map<string, () => Promise<Uint8Array | null>>();
const fromGame = (p: string) => wanted.set(`portal2/${p}`, () => files.read(p));
const fromInstall = (p: string) => wanted.set(p, () => nodeFS.read(p));
for (const m of plan.maps) for (const f of m.files) (f.endsWith('.bsp') ? fromInstall(f) : fromGame(f));
for (const f of plan.extras) (f.startsWith('resource/') ? fromGame(f) : fromInstall(f));
for (const d of ['portal2', 'portal2_dlc1', 'portal2_dlc2']) {
	if (!existsSync(`${ROOT}/${d}/media`)) continue;
	for (const f of readdirSync(`${ROOT}/${d}/media`)) {
		if (!f.endsWith('.bik') || NOT_SCREENS.test(f) || statSync(`${ROOT}/${d}/media/${f}`).size > SCREEN_MOVIES) continue;
		fromGame(`media/${f.toLowerCase()}`);
	}
}

mkdirSync(`${out}/files`, {recursive: true});
const index: Record<string, [string, number]> = {};
let stored = 0, storedBytes = 0, rawBytes = 0, missing = 0, n = 0;
for (const [path, read] of [...wanted].sort()) {
	let bytes = await read();
	if (!bytes) {
		missing++;
		console.log('missing', path);
		continue;
	}
	if (path.endsWith('.vtf')) bytes = trimVtf(bytes, TEXTURES);
	const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
	index[path] = [hash, bytes.length];
	rawBytes += bytes.length;
	const blob = `${out}/files/${hash.slice(0, 2)}/${hash}.gz`;
	if (!existsSync(blob)) {
		mkdirSync(`${out}/files/${hash.slice(0, 2)}`, {recursive: true});
		const gz = gzipSync(bytes, {level: 9});
		writeFileSync(blob, gz);
		stored++;
		storedBytes += gz.length;
	}
	if (++n % 500 === 0) console.log(`${n} of ${wanted.size}`);
}
const json = JSON.stringify({version: VERSION, textures: TEXTURES, files: index});
writeFileSync(`${out}/index.json`, json);
writeFileSync(`${out}/index.json.gz`, gzipSync(json, {level: 9}));

const mb = (b: number) => `${(b / 2 ** 20).toFixed(0)} MB`;
console.log(`\n${Object.keys(index).length} paths (${missing} missing), ${stored} files stored this run`);
console.log(`raw ${mb(rawBytes)}, stored this run (gzipped) ${mb(storedBytes)}, index ${mb(json.length)}`);
