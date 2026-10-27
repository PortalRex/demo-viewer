# Portal 2 demos in Blender

The viewer exports a run, or part of one, as a Blender scene, and the
**Portal 2 Demo** add-on imports it looking as the 3D view draws it. The
recorded camera, every entity's movement and animation, portals, lasers,
particles, screens and gel all play back in Blender's timeline like the run
itself.

## 1. Export from the viewer

1. Open the run (`.dem` files or a `.sarp`) and switch to **3D**, with your
   Portal 2 folder picked, so the maps load.
2. Press **Export**, choose **As: Blender scene**, and pick the part:
   - this segment,
   - from here to the end of the segment,
   - or the whole run.
3. Pick the size and frame rate. The size sets the camera's aspect, and
   60 fps is one frame per game tick.
4. Pick a folder. The export plays the run frame by frame and writes
   `<run>_blender/` there, with a folder per map and `run.json` listing them
   in order.

This needs Chrome or Edge, which can write into a folder. It takes longer
than the run itself: about 10–15 frames a second, plus the textures at the
end.

## 2. Install the add-on

Blender 4.2 or newer.

```bash
python tools/pack_blender_addon.py
```

This writes `dist/io_import_p2demo.zip`. To install it, drag the zip onto
Blender, or use *Edit > Preferences > Get Extensions > Install from Disk*.

## 3. Import

Use *File > Import > Portal 2 Demo (run.json / scene.json)* and pick the
export's `run.json`. Each map becomes a scene of its own. The scene named
**Run …** plays them one after another in its sequencer: play or render
that one. A map's own scene (`01 sp_a2_column_blocker`…) plays and
renders on its own too.

| Option | |
| --- | --- |
| Scale | Blender units per game unit (0.0254: one inch, so a player is 1.83 m) |
| Render engine | **Cycles** for the real look: portals show the view through them (Ray Portal BSDF), projected lights cast shadows. **Eevee** for quick previews. |
| Samples | antialiasing samples per pixel (everything is emission, so even 16 renders clean) |
| Projected lights | sunlight through windows and flashlights as real lights with ray-traced shadows |

## What's in the scene

- **The map**: brushes, displacements, overlays and static props, lit by the
  map's own light maps (bumped ones too) and vertex lighting. Materials are
  node trees that work as the viewer's shaders do: detail textures, blended
  displacements, envmap reflections, `$selfillum`, Refract (`$localrefract`
  light covers too) and DecalModulate.
- **Entities**: keyframed where they move, show and hide. Animated models
  (players, panels, turrets) have armatures with every bone keyed, and
  moving models are lit by their ambient cube and three local lights. These
  are kept as keyframed object properties (`p2_c0`…, `p2_l0p`…).
- **The camera** (*P2 Eyes*): the runner's view, with its field of view.
- **The view model**: the gun, PotatOS, held objects. It's in its own scene
  with its own field of view and layered over the world, as the game draws
  it. First-person effects (the gun's lights, the hold beam) go with it.
- **Portals**: the live view through each one in Cycles, and the flames,
  opening and static from the portal shader.
- **Effects**: particles, sprites, glows, lasers, light bridges, funnels,
  fizzlers and ropes. Geometry the game remakes every frame is kept per
  frame, with a *Frames* geometry-nodes modifier that shows the current
  frame's.
- **Moving textures**: Bink screens, signs and the gel are image sequences.
- **The sky**: the 2D sky, and the 3D skybox as its own scene layered
  under the world.
- **The final picture**, in the compositor:
  - the frame's auto exposure (in the materials, keyframed in *P2 Globals*),
  - clamped to the Standard view transform,
  - the engine's bloom,
  - the screen fades,
  - and the game's on-screen text (chapter titles, `game_text`).

## Files

`run.json` lists the maps. In each map's folder:

| File | |
| --- | --- |
| `scene.json` | the scene: geometry, materials, objects and their tracks, cameras, frame-wide values |
| `data.bin` | the numbers `scene.json` points into |
| `textures/` | at the game's full size: DXT as `.dds`, others `.png`, light maps and cubemaps as `.exr` |
| `hud/` | the on-screen text, a picture each time it changes |
| `reference/` | (dev only) the viewer's own frames, for comparing |

The add-on reads exports from the same version of the viewer. It names the
version when one doesn't match: export the run again.

## Not carried over

- **Sound**: the viewer doesn't play the demo's audio.
- **The co-op partner's picture-in-picture**: an autorender overlay, not
  part of the game's view.
- **Eevee portals**: the Ray Portal BSDF is Cycles-only. In Eevee a
  portal's opening shows black.
