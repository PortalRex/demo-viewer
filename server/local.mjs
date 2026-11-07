// What a local server hands the viewer that a plain static site can't: the
// Portal 2 install's files at /__game/ (with ranges), and the leaderboard
// (board.portal2.sr) passed through at /__board/, as its demo files aren't
// served for other sites to read. Used by the dev server (vite.config.ts)
// and by the desktop app (electron/main.mjs). Plain JavaScript, so both load
// it as it is.
import {closeSync, createReadStream, openSync, readdirSync, readSync, statSync} from 'node:fs';
import {join, normalize} from 'node:path';

// a path under the game folder, or null where it would leave it
function inside(path) {
	const rel = normalize(path).replace(/^([/\\])+/, '');
	return !rel || rel === '.' || rel.startsWith('..') ? null : rel;
}

// Requests for the game folder `gameDir`: `rest` is the part after /__game
// (with its query). `/__list?dir=` lists a game folder's loose asset files
// (so the viewer doesn't probe for each), `/__ranges` (POST [[path, offset,
// length], ...]) answers many small ranges at once, each as a 4-byte length
// (-1 = missing) and its bytes, and any other path is that file, with ranges
export function serveGame(gameDir, req, res, rest) {
	const [path, query = ''] = rest.split('?');
	if (path === '/__list') {
		const dir = inside(decodeURIComponent(/(?:^|&)dir=([^&]*)/.exec(query)?.[1] ?? ''));
		if (!dir) {
			res.statusCode = 403;
			return res.end();
		}
		const out = [];
		for (const sub of ['materials', 'models', 'particles', 'scripts', 'maps']) {
			try {
				for (const e of readdirSync(join(gameDir, dir, sub), {recursive: true, withFileTypes: true})) {
					if (e.isFile()) out.push(join(e.parentPath, e.name).slice(join(gameDir, dir).length + 1).replace(/\\/g, '/'));
				}
			} catch {
				// no such folder
			}
		}
		res.setHeader('Content-Type', 'application/json');
		return res.end(JSON.stringify(out));
	}
	if (path === '/__ranges') {
		const parts = [];
		req.on('data', c => parts.push(c));
		req.on('end', () => {
			let list;
			try {
				list = JSON.parse(Buffer.concat(parts).toString());
			} catch {
				res.statusCode = 400;
				return res.end();
			}
			const fds = new Map();
			const out = [];
			try {
				for (const [file, offset, length] of list) {
					const rel = inside(String(file));
					let fd = fds.get(rel);
					if (fd === undefined) {
						try {
							fd = rel ? openSync(join(gameDir, rel), 'r') : null;
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
		return;
	}
	const rel = inside(decodeURIComponent(path));
	if (!rel) {
		res.statusCode = 403;
		return res.end();
	}
	const file = join(gameDir, rel);
	let size;
	try {
		const st = statSync(file);
		if (!st.isFile()) throw new Error('not a file');
		size = st.size;
	} catch {
		// "no content" rather than 404: lookups for loose files that aren't
		// there are normal, and 404s fill the console
		res.statusCode = 204;
		return res.end();
	}
	res.setHeader('Accept-Ranges', 'bytes');
	res.setHeader('Content-Type', 'application/octet-stream');
	if (req.method === 'HEAD') {
		res.setHeader('Content-Length', size);
		return res.end();
	}
	const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
	if (range) {
		const start = Number(range[1]);
		const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		res.statusCode = 206;
		res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
		res.setHeader('Content-Length', end - start + 1);
		createReadStream(file, {start, end}).pipe(res);
	} else {
		res.setHeader('Content-Length', size);
		createReadStream(file).pipe(res);
	}
}

// The leaderboard passed through: `rest` is the part after /__board. Just a
// chamber's scores and a run's demo pass, and a chamber's world records and
// a player's personal bests (the demo's name in X-File-Name, from where it
// redirects)
const BOARD = 'https://board.portal2.sr';
export async function serveBoard(userAgent, req, res, rest) {
	if (!/^\/(chamber\/\d+\/json|changelog\/json\?chamber=\d+&(wr=1|profileNumber=\d+)|getDemo\?id=\d+)$/.test(rest)) {
		res.statusCode = 404;
		return res.end();
	}
	try {
		const up = await fetch(BOARD + rest, {headers: {'User-Agent': userAgent}});
		res.statusCode = up.status;
		res.setHeader('Content-Type', up.headers.get('content-type') ?? 'application/octet-stream');
		res.setHeader('X-File-Name', decodeURIComponent(new URL(up.url).pathname.split('/').pop() ?? ''));
		res.end(Buffer.from(await up.arrayBuffer()));
	} catch (e) {
		res.statusCode = 502;
		res.end(String(e));
	}
}
