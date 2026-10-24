# SAR Run Viewer

Watch Portal 2 runs in the browser from a SAR proof (`.sarp`) or a demo (`.dem`).
Files are read in the page; nothing is uploaded.

Shows, per segment (map load): the player's path (top or side view, coloured by
speed, portal teleports dashed), view direction, inputs from the user commands,
horizontal speed, portal placements, pauses, SAR's timer splits and category
rules, console commands, and for proofs the hash chain, signature and whether
the recording stopped cleanly.

    npm install
    npm run dev                     # http://localhost:5173
    npm run probe -- file.sarp      # print what the readers get from a file

In dev, `#load=fixtures/<file>` opens a file from `fixtures/` (git-ignored).

Layout: `src/core` reads the files into a format-independent `Run`
(`model.ts`); `src/player` turns it into one timeline; `src/ui` draws it.
