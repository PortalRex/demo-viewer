// What hosting the game's files for the 3D view would take: for every campaign
// map (single player and co-op, as full-game runs play them), the files the
// viewer reads to show it (the map, its materials and their textures, its
// models, particles and movies, and the models runs bring in: players, the
// gun, cubes), found by running the viewer's own readers on the local install
// with every file read recorded. Reports the size of each map's set, of what
// all maps share, and of everything, with textures at three sizes: the 512
// pixels the 3D view loads now, 1024, and the game's full size. Writes the
// per-map file lists as JSON.
//   node --experimental-strip-types tools/assetplan.ts [out.json] [map...]
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {loadBsp} from '../src/game/bsp.ts';
import {GameFiles} from '../src/game/files.ts';
import {mapPaths} from '../src/game/gamefs.ts';
import {Materials, type MaterialInfo} from '../src/game/materials.ts';
import {loadModel} from '../src/game/mdl.ts';
import {readParticleSystems} from '../src/game/pcf.ts';
import {bytesFor} from '../src/game/vtf.ts';
import {Zip} from '../src/game/zip.ts';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities} from '../src/net/entities.ts';
import {nodeFS, ROOT} from './nodefs.ts';

const [out = 'build/assetplan.json', ...only] = process.argv.slice(2);
const CAPS = [512, 1024, Infinity] as const;

// The campaign maps: every shipped map but the variants, test and duel maps
// and the workshop hub (runs never play those)
const NOT_CAMPAIGN = /_rotated$|_practice$|_d$|_d_cheat|^e1912$|^scrunt$|^sp_coop_|^mp_coop_lgduel$|^mp_coop_community_hub$/;
const allMaps = ['portal2', 'portal2_dlc1'].flatMap(d => readdirSync(`${ROOT}/${d}/maps`).filter(f => f.endsWith('.bsp')).map(f => f.slice(0, -4)));
const maps = (only.length ? only : allMaps.filter(m => !NOT_CAMPAIGN.test(m))).sort();

// (a board demo for each challenge mode map: the models runs bring in)
const demos = new Map<string, string>();
if (existsSync('fixtures/allmaps')) for (const f of readdirSync('fixtures/allmaps')) demos.set(f.replace(/_\d+\.dem$/, ''), `fixtures/allmaps/${f}`);

// Every file read, recorded: the game's files by their path (a map's own pak
// files aren't separate: they come with the map)
const files = new GameFiles(nodeFS);
await files.init('portal2');
let reads = new Set<string>();
const readOf = files.read, rangeOf = files.readRange;
files.read = async function (this: GameFiles, path: string) {
	const b = await readOf.call(this, path);
	const p = path.toLowerCase().replace(/\\/g, '/');
	if (b && !this.mapPak?.has(p)) reads.add(p);
	return b;
};
files.readRange = async function (this: GameFiles, path: string, start: number, length: number) {
	const b = await rangeOf.call(this, path, start, length);
	const p = path.toLowerCase().replace(/\\/g, '/');
	if (b && !this.mapPak?.has(p)) reads.add(p);
	return b;
};
const has = async (path: string) => (await files.readRange(path, 0, 1)) !== null;

// a material's file and every texture or material its parameters name
const materialsDone = new Set<string>();
async function walkMaterial(mats: Materials, name: string) {
	const key = name.toLowerCase().replace(/\\/g, '/').replace(/\.vmt$/, '');
	if (!key || materialsDone.has(key)) return;
	materialsDone.add(key);
	const raw = await mats.raw(key);
	if (!raw) return;
	for (const value of raw.params.values()) {
		const v = value.toLowerCase().replace(/\\/g, '/').replace(/\.(vtf|vmt)$/, '');
		if (!v || v.startsWith('_rt_') || v === 'env_cubemap' || /^[\d.\s[\]{}-]+$/.test(v)) continue;
		if (await has(`materials/${v}.vtf`)) continue;  // (a texture: recorded by the read)
		if (await has(`materials/${v}.vmt`)) await walkMaterial(mats, v);  // (a material: water's, a patch's)
	}
}

async function walkModel(mats: Materials, name: string, skin = 0, body = 0) {
	const m = await loadModel(files, name, [1, 1, 1], skin, body).catch(() => null);
	if (!m) return;
	for (const g of m.groups) {
		for (const c of g.materialCandidates) {
			if (await has(`materials/${c}.vmt`)) {
				await walkMaterial(mats, c);
				break;
			}
		}
	}
}

// what the particle effects use: the manifest's files (all maps load the
// global manifest) and the map's own, and the effects' materials
async function walkParticles(mats: Materials, map: string) {
	const lists = [await files.text('particles/particles_manifest.txt'), await files.text(`maps/${map}_particles.txt`)];
	for (const list of lists) {
		for (const m of (list ?? '').matchAll(/"file"\s+"!?([^"]+)"/gi)) {
			const pcf = await files.read(m[1].toLowerCase().replace(/\\/g, '/'));
			if (!pcf) continue;
			for (const def of readParticleSystems(pcf)) if (def.material) await walkMaterial(mats, def.material);
		}
	}
}

interface MapSet { map: string; files: string[]; bspBytes: number }
const sets: MapSet[] = [];
for (const map of maps) {
	reads = new Set();
	materialsDone.clear();
	const path = mapPaths(map, 'portal2').find(p => existsSync(`${ROOT}/${p}`));
	if (!path) {
		console.log(map, 'not found');
		continue;
	}
	let zip: Zip | null = null;
	const bsp = await loadBsp(nodeFS, path, map, {
		materials: async (names, pak) => {
			zip = pak ? new Zip(pak) : null;
			const scoped = new Materials(files.withPak(zip));
			const outMats = new Map<string, MaterialInfo>();
			for (const n of names) {
				outMats.set(n, await scoped.get(n));
				await walkMaterial(scoped, n);
			}
			return outMats;
		},
	});
	const view = files.withPak(zip);
	const mats = new Materials(view);
	// (models: static props, entities', and those a run of the map shows)
	const models = new Set<string>(bsp.staticProps.map(p => p.model.toLowerCase()));
	for (const e of bsp.entities) for (const [k, v] of Object.entries(e)) if (/model/i.test(k) && /\.mdl$/i.test(v)) models.add(v.toLowerCase().replace(/\\/g, '/'));
	const demo = demos.get(map);
	if (demo) {
		const run = await loadRun(new Uint8Array(readFileSync(demo)), 'x');
		for (const seg of run.segments) {
			const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
			for (const t of tl.tracks) if (t.model?.endsWith('.mdl')) models.add(t.model.toLowerCase());
		}
	}
	for (const m of models) await walkModel(mats, m);
	await walkParticles(mats, map);
	// (the skybox, and the movies its screens play)
	const sky = bsp.entities.find(e => e.classname === 'worldspawn')?.skyname;
	if (sky) for (const side of ['rt', 'lf', 'bk', 'ft', 'up', 'dn']) await walkMaterial(mats, `skybox/${sky}${side}`);
	for (const e of bsp.entities) for (const v of Object.values(e)) if (/\.bik$/i.test(v)) await files.read(v.toLowerCase().replace(/\\/g, '/'));
	const bspBytes = (await nodeFS.size(path)) ?? 0;
	// (the map's own file too, read straight from the install)
	sets.push({map, files: [...reads, path].sort(), bspBytes});
	console.log(`${map}: ${reads.size} files, ${models.size} models`);
}

// The extras the 3D view reads straight from the install: the HUD's and
// signs' fonts, the movie decoder's tables, the HUD's strings
const extras = ['platform/vgui/fonts/universc.vfont', 'platform/vgui/fonts/univercb.vfont', 'bin/binkw32.dll', 'resource/portal2_english.txt'];

// Each file's size, with textures cut to each cap (the levels larger than it
// left out)
const sizeOf = new Map<string, number[]>();
async function sizes(path: string): Promise<number[]> {
	let s = sizeOf.get(path);
	if (s) return s;
	const b = await files.read(path) ?? await nodeFS.read(path);
	const full = b?.length ?? 0;
	s = CAPS.map(cap => (b && path.endsWith('.vtf') ? vtfAt(b, cap) : full));
	sizeOf.set(path, s);
	return s;
}
function vtfAt(b: Uint8Array, cap: number): number {
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (b.length < 64 || v.getUint32(0, true) !== 0x00465456) return b.length;
	const minor = v.getUint32(8, true);
	const width = v.getUint16(16, true), height = v.getUint16(18, true);
	const flags = v.getUint32(20, true), frames = v.getUint16(24, true);
	const format = v.getInt32(52, true), mipCount = v.getUint8(56);
	const depth = minor >= 2 ? Math.max(1, v.getUint16(63, true)) : 1;
	const faces = flags & 0x4000 ? (minor < 5 ? 7 : 6) : 1;
	let cut = 0;
	for (let m = 0; m < mipCount - 1 && Math.max(width >> m, height >> m) > cap; m++) {
		const n = bytesFor(format, Math.max(1, width >> m), Math.max(1, height >> m));
		if (n < 0) return b.length;
		cut += n * frames * faces * Math.max(1, depth >> m);
	}
	return b.length - cut;
}

// (which maps use each file: a file most maps use is in the shared set)
const usedBy = new Map<string, number>();
for (const s of sets) for (const f of s.files) usedBy.set(f, (usedBy.get(f) ?? 0) + 1);
const sum = async (list: Iterable<string>) => {
	const t = [0, 0, 0];
	for (const f of list) (await sizes(f)).forEach((n, i) => (t[i] += n));
	return t;
};
const mb = (n: number) => `${(n / 2 ** 20).toFixed(0)} MB`;
const row = (label: string, t: number[]) => console.log(`${label.padEnd(34)} ${CAPS.map((c, i) => `${c === Infinity ? 'full' : c}: ${mb(t[i]).padStart(8)}`).join('   ')}`);
const textures = (list: string[]) => list.filter(f => f.endsWith('.vtf'));

const allFiles = [...usedBy.keys()];
const shared = allFiles.filter(f => (usedBy.get(f) ?? 0) > sets.length / 2);
console.log(`\n${sets.length} maps, ${allFiles.length} files (${shared.length} used by most maps: the shared set)`);
row('Everything (no repeats)', await sum([...allFiles, ...extras]));
row('  of which textures', await sum(textures(allFiles)));
row('Shared set', await sum([...shared, ...extras]));
const perMap: {map: string; all: number[]; own: number[]; tex: number[]}[] = [];
for (const s of sets) {
	const own = s.files.filter(f => !shared.includes(f));
	perMap.push({map: s.map, all: await sum(s.files), own: await sum(own), tex: await sum(textures(s.files))});
}
const pick = (k: 'all' | 'own' | 'tex', q: number) => {
	const sorted = [...perMap].sort((a, b) => a[k][1] - b[k][1]);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
for (const [label, k] of [['A map, everything it needs', 'all'], ['A map, beyond the shared set', 'own'], ['A map\'s textures (GPU memory)', 'tex']] as const) {
	const med = pick(k, 0.5), max = pick(k, 0.999);
	row(`${label}: median (${med.map})`, med[k]);
	row(`${label}: largest (${max.map})`, max[k]);
}
mkdirSync(dirname(out), {recursive: true});
writeFileSync(out, JSON.stringify({maps: sets, shared, extras, perMap}, null, 1));
console.log(`\nwritten ${out}`);
