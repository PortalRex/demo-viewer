// The leaderboard passed through for a hosted viewer, as the dev server
// does (vite.config.ts): board.portal2.sr doesn't serve its demo files for
// other sites to read. Just a chamber's scores, its world records and a
// run's demo pass, with the demo's name in X-File-Name (from where the
// board redirects to it).
// Demos don't change once submitted, so they're kept in Cloudflare's cache.
//   wrangler deploy   (see wrangler.toml; set the viewer's VITE_BOARD_PROXY to its URL)
const BOARD = 'https://board.portal2.sr';
const ALLOWED = /^\/(chamber\/\d+\/json|changelog\/json\?chamber=\d+&wr=1|getDemo\?id=\d+)$/;
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Expose-Headers': 'X-File-Name',
};

export default {
	async fetch(request, env, ctx) {
		if (request.method === 'OPTIONS') return new Response(null, {headers: CORS});
		const url = new URL(request.url);
		const path = url.pathname + url.search;
		if (request.method !== 'GET' || !ALLOWED.test(path)) return new Response('Not found', {status: 404, headers: CORS});
		const demo = path.startsWith('/getDemo');
		const cache = caches.default;
		if (demo) {
			const hit = await cache.match(request);
			if (hit) return hit;
		}
		const up = await fetch(BOARD + path, {headers: {'User-Agent': 'SAR Run Viewer (board proxy)'}});
		const headers = new Headers(CORS);
		headers.set('Content-Type', up.headers.get('Content-Type') ?? 'application/octet-stream');
		headers.set('X-File-Name', decodeURIComponent(new URL(up.url).pathname.split('/').pop() ?? ''));
		// (scores change: a minute; a demo never does)
		headers.set('Cache-Control', demo && up.ok ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
		const res = new Response(up.body, {status: up.status, headers});
		if (demo && up.ok) ctx.waitUntil(cache.put(request, res.clone()));
		return res;
	},
};
