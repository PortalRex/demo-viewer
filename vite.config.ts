import {defineConfig} from 'vite';
import type {Plugin} from 'vite';
import {closeSync, createReadStream, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync} from 'node:fs';
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
			// debugging: POST a data URL (PNG; ext=jpg or ext=mp4 for those) to /__shot?name=x to save it in fixtures/shots
			server.middlewares.use('/__shot', (req, res) => {
				const name = (/name=([\w/-]+)/.exec(req.url ?? '')?.[1]) ?? 'shot';
				const ext = /ext=(jpg|mp4)/.exec(req.url ?? '')?.[1] ?? 'png';
				const parts: Buffer[] = [];
				req.on('data', (c: Buffer) => parts.push(c));
				req.on('end', () => {
					mkdirSync(`fixtures/shots/${name}`.replace(/\/[^/]*$/, ''), {recursive: true});
					const data = Buffer.concat(parts).toString().replace(/^data:\w+\/[\w-]+;base64,/, '');
					writeFileSync(`fixtures/shots/${name}.${ext}`, Buffer.from(data, 'base64'));
					res.end('ok');
				});
			});
			// a game folder's loose asset files (so the viewer doesn't probe for each)
			server.middlewares.use('/__game/__list', (req, res) => {
				const dir = normalize(decodeURIComponent(/dir=([^&]*)/.exec(req.url ?? '')?.[1] ?? '')).replace(/^([/\\])+/, '');
				if (!dir || dir.startsWith('..')) {
					res.statusCode = 403;
					return res.end();
				}
				const out: string[] = [];
				for (const sub of ['materials', 'models', 'particles', 'scripts', 'maps']) {
					try {
						for (const e of readdirSync(join(P2_DIR, dir, sub), {recursive: true, withFileTypes: true})) {
							if (e.isFile()) out.push(join(e.parentPath, e.name).slice(join(P2_DIR, dir).length + 1).replace(/\\/g, '/'));
						}
					} catch {
						// no such folder
					}
				}
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify(out));
			});
			// many small ranges in one request (POST [[path, offset, length], ...]):
			// each answered as a 4-byte length (-1 = missing) and its bytes
			server.middlewares.use('/__game/__ranges', (req, res) => {
				const parts: Buffer[] = [];
				req.on('data', (c: Buffer) => parts.push(c));
				req.on('end', () => {
					let list: [string, number, number][];
					try {
						list = JSON.parse(Buffer.concat(parts).toString());
					} catch {
						res.statusCode = 400;
						return res.end();
					}
					const fds = new Map<string, number | null>();
					const out: Buffer[] = [];
					try {
						for (const [file, offset, length] of list) {
							const rel = normalize(file).replace(/^([/\\])+/, '');
							let fd = fds.get(rel);
							if (fd === undefined) {
								try {
									fd = rel.startsWith('..') ? null : openSync(join(P2_DIR, rel), 'r');
								} catch {
									fd = null;
								}
								fds.set(rel, fd);
							}
							const head = Buffer.alloc(4);
							if (fd === null) {
								head.writeInt32LE(-1);
								out.push(head);
								continue;
							}
							const buf = Buffer.alloc(Math.max(0, length));
							const n = readSync(fd, buf, 0, buf.length, offset);
							head.writeInt32LE(n);
							out.push(head, buf.subarray(0, n));
						}
					} finally {
						for (const fd of fds.values()) if (fd !== null && fd !== undefined) closeSync(fd);
					}
					res.setHeader('Content-Type', 'application/octet-stream');
					res.end(Buffer.concat(out));
				});
			});
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

// Dev only: the leaderboard (board.portal2.sr) at /__board/, as its demo
// files aren't served for other sites to read. Just a chamber's scores and
// a run's demo pass, and a chamber's world records (the demo's name in
// X-File-Name, from where it redirects)
const BOARD = 'https://board.portal2.sr';
function boardProxy(): Plugin {
	return {
		name: 'board-proxy',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use('/__board', async (req, res) => {
				const path = req.url ?? '';
				if (!/^\/(chamber\/\d+\/json|changelog\/json\?chamber=\d+&wr=1|getDemo\?id=\d+)$/.test(path)) {
					res.statusCode = 404;
					res.end();
					return;
				}
				try {
					const up = await fetch(BOARD + path, {headers: {'User-Agent': 'SAR Run Viewer (dev)'}});
					res.statusCode = up.status;
					res.setHeader('Content-Type', up.headers.get('content-type') ?? 'application/octet-stream');
					res.setHeader('X-File-Name', decodeURIComponent(new URL(up.url).pathname.split('/').pop() ?? ''));
					res.end(Buffer.from(await up.arrayBuffer()));
				} catch (e) {
					res.statusCode = 502;
					res.end(String(e));
				}
			});
		},
	};
}

export default defineConfig({
	plugins: [devGameFiles(), boardProxy()],
});
