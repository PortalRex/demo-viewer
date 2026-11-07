// The viewer as a desktop app: the built page (dist/) in a window, served by
// a server of its own on a private loopback port that also hands it the
// Portal 2 install's files (/__game/) and passes the leaderboard through
// (/__board/), as the dev server does (server/local.mjs). Demos given on the
// command line ("Open with", or dropped on the exe) open straight away.
import {app, BrowserWindow, dialog, Menu, shell} from 'electron';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createReadStream, existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveBoard, serveGame} from '../server/local.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const USER_AGENT = `SAR Run Viewer (desktop ${app.getVersion()})`;

// ---- settings (the game folder), kept in the app's user data folder ----
const settingsFile = () => join(app.getPath('userData'), 'settings.json');
function readSettings() {
	try {
		return JSON.parse(readFileSync(settingsFile(), 'utf8'));
	} catch {
		return {};
	}
}
function writeSettings(s) {
	writeFileSync(settingsFile(), JSON.stringify(s, null, '\t'));
}

// ---- finding Portal 2 ----
const isGameDir = dir => !!dir && existsSync(join(dir, 'portal2', 'pak01_dir.vpk'));
// Steam's libraries (its install folder's libraryfolders.vdf), each one's
// copy of Portal 2 if it has one
function steamGameDirs() {
	const roots = [];
	try {
		const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {encoding: 'utf8', windowsHide: true});
		const path = /SteamPath\s+REG_SZ\s+(.+)/.exec(out)?.[1]?.trim();
		if (path) roots.push(normalize(path));
	} catch {
		// no Steam in the registry
	}
	roots.push('C:\\Program Files (x86)\\Steam');
	const libraries = new Set(roots);
	for (const root of roots) {
		try {
			const vdf = readFileSync(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
			for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(normalize(m[1].replace(/\\\\/g, '\\')));
		} catch {
			// no library list there
		}
	}
	return [...libraries].map(l => join(l, 'steamapps', 'common', 'Portal 2'));
}
function findGameDir() {
	const saved = readSettings().gameDir;
	if (isGameDir(saved)) return saved;
	return steamGameDirs().find(isGameDir) ?? null;
}
async function pickGameDir(win) {
	const {canceled, filePaths} = await dialog.showOpenDialog(win, {
		title: 'Your Portal 2 folder (the one with portal2.exe)',
		properties: ['openDirectory'],
		defaultPath: gameDir ?? undefined,
	});
	if (canceled || !filePaths[0]) return false;
	if (!isGameDir(filePaths[0])) {
		await dialog.showMessageBox(win, {type: 'warning', message: 'That isn’t a Portal 2 folder', detail: 'Pick the folder that has portal2.exe and the portal2 folder in it.'});
		return false;
	}
	gameDir = filePaths[0];
	writeSettings({...readSettings(), gameDir});
	return true;
}

// ---- the local server ----
// Demos opened from the command line, served at /__open/<n>/<name>
const opened = [];
const openUrl = file => {
	opened.push(file);
	return `/__open/${opened.length - 1}/${encodeURIComponent(basename(file))}`;
};
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm'};

let gameDir = null;
let origin = null;

function sendFile(res, file, type) {
	let size;
	try {
		const st = statSync(file);
		if (!st.isFile()) throw new Error('not a file');
		size = st.size;
	} catch {
		res.statusCode = 404;
		return res.end();
	}
	res.setHeader('Content-Type', type);
	res.setHeader('Content-Length', size);
	createReadStream(file).pipe(res);
}

function handle(req, res) {
	// (only this app's own page: not another site rebinding a name to the
	// loopback address)
	if (req.headers.host !== new URL(origin).host) {
		res.statusCode = 403;
		return res.end();
	}
	const url = req.url ?? '/';
	if (url.startsWith('/__game/') || url === '/__game') {
		if (!gameDir) {
			res.statusCode = 204;
			return res.end();
		}
		return serveGame(gameDir, req, res, url.slice('/__game'.length) || '/');
	}
	if (url.startsWith('/__board/')) return serveBoard(USER_AGENT, req, res, url.slice('/__board'.length));
	const open = /^\/__open\/(\d+)\//.exec(url);
	if (open) {
		const file = opened[Number(open[1])];
		if (!file) {
			res.statusCode = 404;
			return res.end();
		}
		return sendFile(res, file, 'application/octet-stream');
	}
	// the page's own files; anything else is the page
	let rel = normalize(decodeURIComponent(url.split(/[?#]/)[0])).replace(/^([/\\])+/, '');
	if (rel.startsWith('..')) {
		res.statusCode = 403;
		return res.end();
	}
	if (!rel || rel === '.' || !existsSync(join(DIST, rel))) rel = 'index.html';
	sendFile(res, join(DIST, rel), TYPES[extname(rel)] ?? 'application/octet-stream');
}

function startServer() {
	return new Promise((resolve, reject) => {
		const server = createServer(handle);
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			origin = `http://127.0.0.1:${server.address().port}`;
			resolve(server);
		});
	});
}

// ---- the window ----
let win = null;
// SAR_VIEWER_BACKGROUND=1: no window shown and no questions asked, the page's
// address printed instead (for testing the app beside a game being played)
const background = process.env.SAR_VIEWER_BACKGROUND === '1';

// the demos named on a command line (the app's own arguments left out)
const demosIn = argv => argv.slice(app.isPackaged ? 1 : 2).filter(a => /\.(dem|sarp)$/i.test(a) && existsSync(a));
// (a demo's own address, so opening another loads the page afresh rather
// than only changing the part after #)
const pageUrl = demo => {
	if (!demo) return `${origin}/`;
	const at = openUrl(demo);
	return `${origin}/?open=${opened.length - 1}#load=${at}`;
};

function buildMenu() {
	Menu.setApplicationMenu(Menu.buildFromTemplate([
		{
			label: 'File',
			submenu: [
				{
					label: 'Open demo…',
					accelerator: 'CmdOrCtrl+O',
					click: async () => {
						const {canceled, filePaths} = await dialog.showOpenDialog(win, {properties: ['openFile'], filters: [{name: 'Demos and SAR proofs', extensions: ['dem', 'sarp']}]});
						if (!canceled && filePaths[0]) win.loadURL(pageUrl(filePaths[0]));
					},
				},
				{
					label: 'Game folder…',
					click: async () => {
						if (await pickGameDir(win)) win.reload();
					},
				},
				{type: 'separator'},
				{role: 'quit'},
			],
		},
		{
			label: 'View',
			submenu: [
				{role: 'reload'},
				{role: 'togglefullscreen'},
				{type: 'separator'},
				{role: 'resetZoom'},
				{role: 'zoomIn'},
				{role: 'zoomOut'},
				{type: 'separator'},
				{role: 'toggleDevTools'},
			],
		},
	]));
}

async function createWindow(demo) {
	win = new BrowserWindow({
		width: 1500,
		height: 950,
		backgroundColor: '#0f1217',
		title: 'SAR Run Viewer',
		show: !background,
		webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true},
	});
	// links out of the page open in the browser; the page itself stays put
	win.webContents.setWindowOpenHandler(({url}) => {
		if (/^https?:/.test(url)) shell.openExternal(url);
		return {action: 'deny'};
	});
	win.webContents.on('will-navigate', (e, url) => {
		if (!url.startsWith(origin)) {
			e.preventDefault();
			if (/^https?:/.test(url)) shell.openExternal(url);
		}
	});
	win.on('closed', () => (win = null));
	await win.loadURL(pageUrl(demo));
	if (background) {
		console.log(`SAR Run Viewer at ${origin}/ (game folder: ${gameDir ?? 'not found'})`);
		return;
	}
	if (!gameDir) {
		const {response} = await dialog.showMessageBox(win, {
			type: 'question',
			message: 'Where is Portal 2 installed?',
			detail: 'The 3D view reads the game’s own files from your install. It wasn’t found in your Steam libraries: pick its folder (the one with portal2.exe). You can change it later under File › Game folder….',
			buttons: ['Pick the folder', 'Not now'],
		});
		if (response === 0 && await pickGameDir(win)) win.reload();
	}
}

// one window: a demo opened while the app runs ("Open with") goes to it
if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on('second-instance', (_e, argv) => {
		if (!win) return;
		const [demo] = demosIn(argv);
		if (demo) win.loadURL(pageUrl(demo));
		if (win.isMinimized()) win.restore();
		win.focus();
	});
	app.whenReady().then(async () => {
		gameDir = findGameDir();
		await startServer();
		buildMenu();
		await createWindow(demosIn(process.argv)[0]);
	});
	app.on('window-all-closed', () => app.quit());
}
