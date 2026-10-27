# SAR Run Viewer

Watch Portal 2 runs in the browser: a SAR proof (`.sarp`) or demos (`.dem`),
drawn as a 2D map of the route with everything the recording knows about it,
or replayed in 3D inside the real map, rendered as close to the game as the
browser allows.

Everything happens in the page. Recordings and game files are read locally and
nothing is uploaded.

- [Opening a run](#opening-a-run)
- [What you see](#what-you-see)
- [The 3D view](#the-3d-view)
- [Controls](#controls)
- [Running it](#running-it)
- [How it's built](#how-its-built)
- [Development tools](#development-tools)
- [Limitations](#limitations)

## Opening a run

Drop files on the page, or use **Open file**.

| File | What it is |
|---|---|
| `.sarp` | A SAR proof: the whole run with its hash chain and signature. |
| `.dem` | A demo. Open all of a run's demos at once and they play as one run, segment after segment. |

A run is split into **segments**, one per map load. The segment list sits at
the top. Click one to jump to its start.

## What you see

### The 2D views (Top, Side)

- **The path**, coloured by speed, with portal teleports dashed. **Follow**
  keeps the player in view and **Fit** shows the whole path.
- **View direction** and **inputs** (WASD, jump, duck, both fire buttons),
  taken from the recorded user commands.
- **Speed graph** of horizontal speed across the segment.
- **Side panels:**
  - **Events:** portal placements, pauses and splits.
  - **Console:** the commands run during the recording.
  - **Splits:** SAR's timer splits and category rules.
  - **File:** for proofs, the hash chain, signature and whether the recording
    stopped cleanly.

### The 3D view

The run replayed in the map from your own copy of Portal 2: see
[the 3D view](#the-3d-view) below.

## The 3D view

Works in Chrome and Edge. It reads the map, models, materials and textures from
**your own Portal 2 install**; nothing from the game ships with the viewer.
The first time you switch to 3D, pick your `Portal 2` folder (the one with
`portal2.exe`, usually under `steamapps/common`).

### What's drawn

- **World:** brushes, displacements, overlays and brush entities (doors,
  elevators, panels) from the BSP, with the map's baked HDR lightmaps, light
  styles, fog, and the 2D and 3D skyboxes.
- **Materials:** the game's own shaders reproduced: LightmappedGeneric,
  VertexLitGeneric with phong and rim light, env maps from the map's
  cubemaps, Refract, decals, $selfillum, detail textures and more.
- **Props and entities:**
  - Static props use vrad's per-vertex lighting.
  - Moving props, cubes, turrets, buttons and doors come from the entity
    data decoded from the recording. They're interpolated between server
    updates as the game's client does.
- **Players:** Chell, Atlas and P-body, animated from their recorded
  movement (sequences, gestures, aim), holding the portal gun.
- **Portals:** with the live view through their partner, opening animation,
  edge flames and placement sparks.
- **Gameplay:**
  - lasers, light bridges, excursion funnels and fizzlers, from their
    networked state with their own materials,
  - gel, painted from the paint map and paint messages,
  - Bink movie screens and chamber signs.
- **Effects:** the game's particle systems (PCF) simulated in the viewer:
  the portal gun's hold beam, sparks, steam, glows, ropes and sprites.
- **Camera and screen:**
  - the view model gun in first person,
  - auto exposure as the game's tonemap controller,
  - bloom,
  - the co-op partner's view in the corner (as autorender's co-op renders
    show it),
  - the challenge-mode HUD and on-screen titles.

### Cameras

- **Eyes:** the recording player's view, as the game showed it.
- **Orbit:** around the player. Drag to turn, scroll to zoom. Whatever
  stands between the camera and the player dissolves with a dither pattern.
- **Free:** fly anywhere. Drag to look, WASD to move, Q/E down/up, Shift
  faster, Ctrl slower.

In co-op, choose which player the camera follows.

### Toggles

| Toggle | What it does |
|---|---|
| **Path** | The run's route drawn through the map. |
| **Timer** | The challenge-mode HUD (portals and time), from the recording's own stats. |
| **Titles** | The game's on-screen text, such as chapter titles. |
| **Partner** | The co-op partner's view in the corner. |
| **Bright** | Brightens dark maps as autorender does (`mat_ambient_light 0.05`). It's on by default where autorender uses it. |

Toggles are remembered per browser.

### Loading

- **Ahead of time:** the map loads as soon as a segment is on screen, even
  in the 2D views, once the game folder is known. In 2D it starts after you
  stay on a segment for half a second, not for every segment you scrub past.
  Switching to 3D then finds the map ready.
- **First watch:** once a segment is loaded, everything it will show is
  preloaded:
  - every entity's model in each skin it takes,
  - the map's particle sprites,
  - the textures, uploaded to the GPU in small batches,
  - the shaders, including the variants portal views draw with.
- **Caching:** the last two maps stay cached, so going back and forth across
  a level change is instant. Textures and models are kept across maps while
  they're still in use.

## Controls

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Step one tick |
| Shift + ← / → | Step one second |
| Home | Back to the start of the segment |

Playback speed is the dropdown next to the play button. The timeline under
the view seeks; segment boundaries are marked on it.

## Running it

Needs Node 22 or newer.

```bash
npm install
```

```bash
npm run dev
```

That serves the viewer at http://localhost:5173.

```bash
npm run build
```

That typechecks and builds a static site into `dist/`, which can be hosted
anywhere. The built site reads the game through the browser's folder picker.

### Development conveniences

- **No folder picking.** In dev, the server serves your Portal 2 install at
  `/__game/` with byte-range support, so the 3D view works without picking
  the folder after each reload. It defaults to the Steam path; set `P2_DIR`
  to point it elsewhere:

  ```bash
  P2_DIR="D:/Games/Portal 2" npm run dev
  ```

- **Open a file from the address bar.** `#load=fixtures/<file>` opens a
  file from `fixtures/`, for example
  `http://localhost:5173/#load=fixtures/run.dem`.
- **`fixtures/` is git-ignored.** Keep test recordings there. They're the
  players' own runs, so they stay out of the repository.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck and build `dist/` |
| `npm run check` | Typecheck only |
| `npm run probe -- <files>` | Print what the readers get from a `.sarp` or `.dem` |

## How it's built

TypeScript, [three.js](https://threejs.org) for rendering and
[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) for ray casts
against the map. There's no framework; the UI is plain DOM.

```
src/
  core/    file readers: .dem and .sarp into one format-independent Run (model.ts)
  net/     the network data: data tables, string tables, packet entities,
           proofs' entity records → per-entity timelines; paint messages
  game/    the game's files: VPK, BSP (lightmaps, vis, ambient light), VMT/VTF,
           MDL/VVD/VTX models and animation, PCF particle systems, Bink
  player/  a Run turned into one timeline across its segments
  ui/      drawing: the 2D path view, charts and panels, and the 3D view
           (view3d.ts) with its shader hooks, particles, effects and paint
tools/     command-line probes and comparison scripts (see below)
```

**How a frame of the 3D view is made:**

1. Read the entity timelines at the current tick, then place, animate and
   light each object.
2. Draw the portal views, each a whole scene seen through its partner.
3. Draw the world into an HDR frame.
4. Expose it like the game's tonemap controller, add bloom, and draw the view
   model and first-person effects over it.

**Behaviour comes from the game.** It's matched against the shipped game's
code and against frames of the real game rendered from the same recordings.
The code comments name the engine functions and shader behaviour each part
follows.

## Development tools

### Probes

Command-line probes, run with `node --experimental-strip-types tools/<name>.ts`:

| Tool | What it prints |
|---|---|
| `probe.ts` | What the readers get from a recording |
| `entprobe.ts` | Entity decode summary |
| `bspprobe.ts <map>` | A map's materials and static props |
| `pcfprobe.ts <system>` | A particle system's full definition |
| `matinfo.ts`, `mdlinfo.ts` | A material or model as the viewer reads it |
| `texprofile.ts` | A texture's brightness profile |

### Comparing against the game

Comparison scripts (Python, with Pillow, numpy and ffmpeg):

| Tool | What it does |
|---|---|
| `shotdiff.py <before> <after> <out>` | Which viewer shots a change moved, scored before and after against the game's frame of the same moment |
| `boardcmp.py` | Side-by-side sheets of the viewer against autorender's renders of the same runs |
| `refshots.py` | Reference frames from the real game for a set of recordings |
| `refcompare.py` | Viewer shots against those frames |

In dev, the page has hooks on `window` for scripted captures and measurement:

| Hook | What it does |
|---|---|
| `shootAt(path, tick, name)` | Open a file, wait for loading to settle at a tick, save a shot to `fixtures/shots/` |
| `record(name, from, to)` | Frames of a tick range, for videos |
| `bench(tick)` | Load time and frame cost |
| `prof(tick)` | Frame cost by stage |
| `timings` | How long each loading step took |

## Limitations

- **Browser:** the 3D view needs Chrome or Edge, because it uses the File
  System Access API to read the game folder. The 2D views work in any
  modern browser.
- **Game content:** the 3D view finds maps in the game's own map folders.
  A map that isn't there (a mod's, or a workshop map you haven't
  downloaded) can't be shown in 3D.
- **Not every effect is matched yet.** Some particle systems and shaders are
  approximations of the game's. Where the viewer and the game differ, the
  game is right.
