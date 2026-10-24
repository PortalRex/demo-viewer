import {defineConfig} from 'vite';
import type {Plugin} from 'vite';
import {createReadStream, statSync} from 'node:fs';
import {join, normalize} from 'node:path';

// Dev only: serves the local Portal 2 install at /__game/ (with Range
// support), so the 3D view works without picking the folder each reload.
// Set P2_DIR to point it elsewhere. Production builds read the game through
// the browser's folder picker instead.
const P2_DIR = process.env.P2_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Portal 2';

function devGameFiles(): Plugin {
	return {
		name: 'dev-game-files',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use('/__game/', (req, res) => {
				const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
				if (rel.startsWith('..')) {
					res.statusCode = 403;
					return res.end();
				}
				const path = join(P2_DIR, rel);
				let size: number;
				try {
					const st = statSync(path);
					if (!st.isFile()) throw new Error('not a file');
					size = st.size;
				} catch {
					// "no content" rather than 404: lookups for loose files that
					// aren't there are normal, and 404s fill the console
					res.statusCode = 204;
					return res.end();
				}
				res.setHeader('Accept-Ranges', 'bytes');
				res.setHeader('Content-Type', 'application/octet-stream');
				const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
				if (req.method === 'HEAD') {
					res.setHeader('Content-Length', size);
					return res.end();
				}
				if (range) {
					const start = Number(range[1]);
					const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
					res.statusCode = 206;
					res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
					res.setHeader('Content-Length', end - start + 1);
					createReadStream(path, {start, end}).pipe(res);
				} else {
					res.setHeader('Content-Length', size);
					createReadStream(path).pipe(res);
				}
			});
		},
	};
}

export default defineConfig({
	plugins: [devGameFiles()],
});
