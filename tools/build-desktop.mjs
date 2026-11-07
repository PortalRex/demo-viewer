// The page built for the desktop app (electron/main.mjs): into dist/, with
// VITE_DESKTOP set, so the 3D view reads the install the app found (at
// /__game/) and the leaderboard goes through the app (/__board/), as with the
// dev server
//   node tools/build-desktop.mjs
import {build} from 'vite';

process.env.VITE_DESKTOP = '1';
await build({base: '/'});
