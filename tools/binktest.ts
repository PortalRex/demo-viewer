// Checks the Bink decoder against a reference decode: frames of a movie
// against raw yuv420p frames (e.g. made by ffmpeg into the scratch folder):
//   node --experimental-strip-types tools/binktest.ts media/x.bik reference.yuv [frames]
import {readFileSync} from 'node:fs';
import {ROOT} from './nodefs.ts';
import {BinkVideo, binkTablesFromDll} from '../src/game/bink.ts';

const [movie, reference, count] = process.argv.slice(2);
const tables = binkTablesFromDll(new Uint8Array(readFileSync(`${ROOT}/bin/binkw32.dll`)));
if (!tables) throw new Error('no Bink tables in binkw32.dll');
const video = new BinkVideo(new Uint8Array(readFileSync(`${ROOT}/portal2/${movie}`)), tables);
console.log(movie, video.width, 'x', video.height, video.frames, 'frames at', video.fps.toFixed(3), 'fps');
const ref = readFileSync(reference);
const w = video.width, h = video.height, frameBytes = w * h * 3 / 2;
const n = Math.min(Number(count ?? 10), video.frames, Math.floor(ref.length / frameBytes));
for (let i = 0; i < n; i++) {
	const f = video.decode(i);
	const base = i * frameBytes;
	let diff = 0, worst = 0;
	const where: string[] = [];
	const cmp = (name: string, plane: Uint8Array, stride: number, pw: number, ph: number, offset: number) => {
		let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
		for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
			const d = Math.abs(plane[y * stride + x] - ref[offset + y * pw + x]);
			if (!d) continue;
			n++;
			worst = Math.max(worst, d);
			x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
		}
		diff += n;
		if (n) where.push(`${name} ${n} in ${x0},${y0}..${x1},${y1}`);
	};
	cmp('y', f.y, f.yStride, w, h, base);
	cmp('u', f.u, f.cStride, w / 2, h / 2, base + w * h);
	cmp('v', f.v, f.cStride, w / 2, h / 2, base + w * h * 5 / 4);
	console.log('frame', i, 'pixels off', diff, 'worst', worst, where.join('; '));
}
