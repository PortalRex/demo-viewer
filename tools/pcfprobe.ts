// Particle systems in the manifest's .pcf files: counts of each operator
// function, or one system's full definition:
//   node --experimental-strip-types tools/pcfprobe.ts [system name]
import {nodeFS} from './nodefs.ts';
import {GameFiles} from '../src/game/files.ts';
import {readParticleSystems} from '../src/game/pcf.ts';
import type {ParticleSystemDef} from '../src/game/pcf.ts';

const files = new GameFiles(nodeFS);
await files.init('portal2');
const manifest = (await files.text('particles/particles_manifest.txt'))!;
const paths = [...manifest.matchAll(/"file"\s+"!?([^"]+)"/g)].map(m => m[1]).filter((p, i, a) => a.indexOf(p) === i);
const systems = new Map<string, ParticleSystemDef>();
for (const path of paths) {
	const b = await files.read(path);
	if (!b) continue;
	try {
		for (const s of readParticleSystems(b)) systems.set(s.name, s);
	} catch (e) {
		console.log(path, (e as Error).message);
	}
}
const want = process.argv[2];
if (want) {
	const s = systems.get(want);
	if (!s) console.log('no such system');
	else {
		console.log(`${s.name}: material ${s.material} max ${s.maxParticles} color ${s.color} radius ${s.radius} children ${s.children.map(c => c.name + '@' + c.delay).join(', ')}`);
		for (const kind of ['emitters', 'initializers', 'operators', 'renderers'] as const) {
			for (const o of s[kind]) {
				const ps = [...o.params].filter(([k]) => !['functionName', 'name'].includes(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
				console.log(`  ${kind.slice(0, -1)} ${o.fn}: ${ps}`);
			}
		}
	}
} else {
	console.log(`${systems.size} systems in ${paths.length} files`);
	const counts = new Map<string, number>();
	for (const s of systems.values()) for (const kind of ['emitters', 'initializers', 'operators', 'renderers'] as const) for (const o of s[kind]) counts.set(`${kind[0]} ${o.fn}`, (counts.get(`${kind[0]} ${o.fn}`) ?? 0) + 1);
	console.log([...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join('\n'));
}
