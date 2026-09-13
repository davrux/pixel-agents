# Art from Dust Racing 2D

The PNGs in this directory are from **[Dust Racing 2D](https://github.com/juzzlin/DustRacing2D)**
by Jussi Lind and contributors, taken from `data/images/`:

- the eight **cars** (`car*.png`), and
- the **scenery** this world's tracks are landscaped with — `grass.png`, `sand.png`,
  `tree.png`, `rock.png`, `plant.png`.

## Licence — read this before touching them

> All image files, except where otherwise noted, are licensed under
> **[CC BY-SA 3.0](http://creativecommons.org/licenses/by-sa/3.0/)**.

That is **not** this repository's licence. pixel-agents is MIT; these files and
anything derived from them are CC BY-SA 3.0, which means two obligations that
travel with them:

- **Attribution.** Dust Racing 2D and its authors must be credited wherever the
  art is used or redistributed. This file is that credit; keep it beside them.
- **Share-alike.** A modified version stays CC BY-SA 3.0. Everything generated
  from these files IS a modified version and carries the same licence, and so
  would any repaint of them:
  - `assets/vehicles/car-*.png` — `scripts/make-vehicles.sh`
  - `assets/tiled/png/src/scenery.png` and `assets/tiled/scenery.tsj` — the ground
    a track is landscaped with, from `scripts/make-scenery.sh`
  - `assets/tiled/png/src/decal/race-*.png` and `assets/tiled/decal-race.tsj` —
    the trees and rocks beside it, from the same script

The rest of the repository is unaffected: a licence attaches to these image
files, not to the code that loads them.

**Dust Racing 2D's own CODE is GPLv3 and none of it is used here.** The handling
model in `shared/src/office/race/` was written from standard vehicle dynamics;
what was taken from that project is what this file lists — pictures of cars — and
one idea that is not copyrightable (a camera that leads the car by its speed).

## What was changed

**Cars** — `scripts/make-vehicles.sh` turns each 175×93 source into a game-scale
sprite:

- **The pure green (0, 255, 0) is replaced with dark glass.** It is a mask in the
  original — exactly 2864 pixels of it in every car, identical across colours —
  and left alone it renders as a bright green windscreen.
- **Scaled down by area average** to roughly two tiles long, because this world
  is 16 px tiles and a 175 px car is eleven of them.
- The sprite points EAST at heading 0, which is the convention the kart model
  uses (`race/kart.ts`).

**Scenery** — `scripts/make-scenery.sh` cuts the ground textures into 16 px tiles
and the plants into decals:

- `grass.png` and `sand.png` are 256×256 and tile seamlessly, so several
  DIFFERENT 16 px cells are cut from each: one repeated cell reads as wallpaper
  at this size, and four cut from different parts of the same texture read as a
  field.
- `tree.png`, `rock.png` and `plant.png` are scaled to a cell and kept as
  collection art, which is what a decal is here.
- Nothing is recoloured. The palette is theirs, which is the point — it is what
  makes the surroundings look like somewhere rather than like a diagram.
