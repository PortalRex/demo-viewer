# SAR Run Viewer

Watch Portal 2 runs in the browser from a SAR proof (`.sarp`) or demos (`.dem`;
open all of a run's demos at once and they play as one run).
Files are read in the page; nothing is uploaded.

Shows, per segment (map load): the player's path (top or side view, coloured by
speed, portal teleports dashed), view direction, inputs from the user commands,
horizontal speed, portal placements, pauses, SAR's timer splits and category
rules, console commands, and for proofs the hash chain, signature and whether
the recording stopped cleanly.

**3D view** (Chrome/Edge): the map is read from your own Portal 2 install (pick
the `Portal 2` folder; in dev the server reads it from `P2_DIR`, default the
Steam path). World geometry, displacements and brush entities (doors,
elevators, panels) and static props come from the BSP; portals, moving props
and the player come from the entity data decoded from the run. Models are read
from the game's VPKs (and the map's own pak file) without bones, so animated
ones show in their reference pose. Surfaces use their real textures (VTF) and the map's
baked HDR lighting (lightmaps packed into one atlas, tone mapped); static props
use their textures, skins and vrad's per-vertex lighting from the map's pak
(`sp_hdr_N.vhv`, matched to the hardware vertex order); fog comes from the
map's fog controller; the 2D skybox and the 3D skybox (`sky_camera`, drawn in
its own pass at 1/scale with its own fog) are drawn behind the map. Without
textures (before they load) surfaces are light where portals can go and dark
where they can't, from each material's `%noportal`.
Camera: the player's eyes, or orbit around the player.

    npm install
    npm run dev                     # http://localhost:5173
    npm run probe -- file.sarp      # print what the readers get from a file

In dev, `#load=fixtures/<file>` opens a file from `fixtures/` (git-ignored).

Layout: `src/core` reads the files into a format-independent `Run`
(`model.ts`); `src/net` decodes entities from the network data (data tables,
string tables, svc_PacketEntities, and proofs' ENTITIES records);
`src/game` reads the game files (VPK, BSP, materials, models); `src/player` turns a run into one
timeline; `src/ui` draws it.

    node --experimental-strip-types tools/entprobe.ts file.sarp   # entity decode summary
    node --experimental-strip-types tools/bspprobe.ts sp_a1_intro1  # map, materials, static props
