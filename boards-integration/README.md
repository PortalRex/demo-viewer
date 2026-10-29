# The boards site's side of the integration

The viewer built into the boards v2 site (PortalRex/portal2-cm-boards-v2) needs changes in the site itself: the
"Watch the replay" links, the `/replay` page, the Video / Replay switch in run details, the map page's Race Top 5 /
Race WR History / Swarm Top 100 / Pick Runs to Race, the nginx `/viewer/` location and its security headers. They're
kept here, as patches against that repo, and not in it.

| Patch | What it adds |
|---|---|
| `0001-…` | `/viewer/` served where the viewer is built in (`VITE_VIEWER`), its nginx location and headers, "Watch in the browser" links |
| `0002-…` | the Replay page, the Video / Replay switch, the map page's race and swarm buttons, framing the viewer |
| `0003-…` | the dev server passing `/__game` to `DEV_GAME_PROXY` (the 3D view without picking the game folder) |

They were made against the boards repo's `main` at 3c5ad1e (Oct 28, 2026). To try them on a local checkout (a branch,
never `main`):

```bash
git switch -c viewer-integration
git am <path to this folder>/000*.patch
node tools/build-boards.mjs <boards checkout>   # from this repo: the viewer into frontend/public/viewer
```

Later work on the boards may have moved the same lines, so `git am` may need conflicts resolved (`git am --3way`).
