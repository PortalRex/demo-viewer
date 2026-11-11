import {defineConfig} from 'vite';
import type {Plugin} from 'vite';
import {createReadStream, mkdirSync, statSync, writeFileSync} from 'node:fs';
import {join, normalize} from 'node:path';
import {serveBoard, serveGame} from './server/local.mjs';

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
			// the hosted game files as tools/build-assets.ts builds them
			// (build/gameassets), served at /game/ as the boards site's nginx
			// serves them: each file's .gz sent gzipped, with CORS for the
			// boards site's dev server
			server.middlewares.use('/game/', (req, res, next) => {
				const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0])).replace(/^([/\\])+/, '');
				if (!rel || rel.startsWith('..')) return next();
				const file = join('build/gameassets', `${rel}.gz`);
				try {
					statSync(file);
				} catch {
					res.statusCode = 404;
					return res.end();
				}
				res.setHeader('Access-Control-Allow-Origin', '*');
				res.setHeader('Content-Encoding', 'gzip');
				res.setHeader('Content-Type', rel.endsWith('.json') ? 'application/json' : 'application/octet-stream');
				createReadStream(file).pipe(res);
			});
			// the game folder readable from other local dev servers too (the
			// boards site's, testing the viewer built into it)
			server.middlewares.use('/__game', (req, res, next) => {
				res.setHeader('Access-Control-Allow-Origin', '*');
				res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
				res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
				if (req.method === 'OPTIONS') {
					res.statusCode = 204;
					return res.end();
				}
				next();
			});
			// the game folder's files (server/local.mjs)
			server.middlewares.use('/__game', (req, res) => serveGame(P2_DIR, req, res, req.url ?? '/'));
		},
	};
}

// Dev only: the leaderboard (board.portal2.sr) at /__board/ (server/local.mjs)
function boardProxy(): Plugin {
	return {
		name: 'board-proxy',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use('/__board', (req, res) => serveBoard('Demo Viewer (dev)', req, res, req.url ?? ''));
		},
	};
}

export default defineConfig({
	plugins: [devGameFiles(), boardProxy()],
});
