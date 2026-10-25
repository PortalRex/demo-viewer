// Held objects: per player, when m_hAttachedObject points at something, the
// object's offset from the eye in view space and VM-grab state:
//   node --experimental-strip-types tools/holdprobe.ts <file>
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {loadRun} from '../src/core/load.ts';
import {decodeEntities, keyAt} from '../src/net/entities.ts';

for (const path of process.argv.slice(2)) {
	const run = await loadRun(new Uint8Array(readFileSync(path)), basename(path));
	const seg = run.segments[0];
	const tl = decodeEntities(seg, (seg.dataTables ?? run.dataTables)!);
	for (const p of tl.tracks.filter(t => t.className === 'CPortal_Player')) {
		let last = '';
		for (let tick = 0; tick <= (seg.views.at(-1)?.tick ?? 0); tick += 4) {
			const k = keyAt(p, tick);
			if (!k) continue;
			const h = Number(k.extra?.m_hAttachedObject ?? -1);
			const idx = h & 2047;
			if (h < 0 || idx === 2047) continue;
			const o = tl.tracks.find(t => t.index === idx && keyAt(t, tick));
			const ok = o && keyAt(o, tick);
			if (!ok) continue;
			const yaw = k.angles[1] * Math.PI / 180, pitch = k.angles[0] * Math.PI / 180;
			const eye = [k.origin[0], k.origin[1], k.origin[2] + (k.eyeZ ?? 64)];
			const d = [0, 1, 2].map(i => ok.origin[i] - eye[i]);
			const fwd = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
			const left = [-Math.sin(yaw), Math.cos(yaw), 0];
			const f = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2], l = d[0] * left[0] + d[1] * left[1];
			const line = `${p.model.split('/').pop()} holds ${o!.model.split('/').pop()} vm=${k.extra?.m_bUseVMGrab}/${k.extra?.m_bUsingVMGrabState} fwd ${f.toFixed(0)} left ${l.toFixed(0)} dz ${d[2].toFixed(0)}`;
			if (line !== last) console.log(`@${tick} ${line}`);
			last = line;
		}
	}
}
