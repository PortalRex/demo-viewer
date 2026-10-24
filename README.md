# SAR Run Viewer

Watch Portal 2 runs in the browser from a SAR proof (`.sarp`) or a demo (`.dem`).
Files are read in the page; nothing is uploaded.

Shows, per segment (map load): the player's path (top or side view, coloured by
speed, portal teleports dashed), view direction, inputs from the user commands,
horizontal speed, portal placements, pauses, SAR's timer splits and category
rules, console commands, and for proofs the hash chain, signature and whether
the recording stopped cleanly.

**3D view** (Chrome/Edge): the map is read from your own Portal 2 install (pick
the `Portal 2` folder; in dev the server reads it from `P2_DIR`, default the
Steam path). World geometry, displacements and brush entities (doors,
elevators, panels) come from the BSP; portals, props and the player come from
the entity data decoded from the run. White panels are portalable, dark ones
aren't (guessed from texture names); other surfaces use their texture's
average colour. Camera: the player's eyes, or orbit around the player.

    npm install
    npm run dev                     # http://localhost:5173
    npm run probe -- file.sarp      # print what the readers get from a file

In dev, `#load=fixtures/<file>` opens a file from `fixtures/` (git-ignored).

Layout: `src/core` reads the files into a format-independent `Run`
(`model.ts`); `src/net` decodes entities from the network data (data tables,
string tables, svc_PacketEntities, and proofs' ENTITIES records);
`src/game` reads the game files (BSP); `src/player` turns a run into one
timeline; `src/ui` draws it.

    node --experimental-strip-types tools/entprobe.ts file.sarp   # entity decode summary
    node --experimental-strip-types tools/bspprobe.ts sp_a1_intro1  # map geometry summary
