// The viewer built for the boards v2 site (PortalRex/portal2-cm-boards-v2):
// served there at /viewer/, reading the site's own API (/api/v1) for boards
// and demos. Written into that checkout's frontend/public/viewer (git-ignored
// there: the viewer stays out of the boards repo), which its build copies in.
//   node tools/build-boards.mjs [boards checkout, default ../portal2-cm-boards-v2]
import {build} from 'vite';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';

const boards = resolve(process.argv[2] ?? '../portal2-cm-boards-v2');
if (!existsSync(resolve(boards, 'frontend/package.json'))) {
	console.error(`No boards checkout at ${boards}`);
	process.exit(1);
}
process.env.VITE_BOARDS_API = '/api/v1';
await build({
	base: '/viewer/',
	build: {outDir: resolve(boards, 'frontend/public/viewer'), emptyOutDir: true},
});
