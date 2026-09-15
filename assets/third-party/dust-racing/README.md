# Art from Dust Racing 2D

The PNGs in this directory are from **[Dust Racing 2D](https://github.com/juzzlin/DustRacing2D)**
by Jussi Lind and contributors, taken from `data/images/`:

- the **ground** a track is made of — `grass.png`, `sand.png` and, since
  2026-09-15, `asphalt.png`. The road used to be drawn with tiles this repository
  generated itself, and a flat grey field with a red-and-white border is what that
  gets you; the pack's asphalt has real grain and is the single biggest difference
  between a road and a grey rectangle.
- the **things beside it** — `tree.png`, `rock.png`, `plant.png`, and now
  `bushArea.png`, `tire.png` (a tyre wall on the outside of every corner),
  `grandstand.png` (somewhere for the race to be watched from) and `brake.png`
  (the board before the tightest corner).

What was deliberately NOT taken is their track PIECES (`straight.png`,
`corner.png`, `corner45Left.png` …). Those are masks, not finished art — pure
green means "no road here", and Dust composites them over the asphalt at runtime.
This world states its road as a distance from a centreline instead, so it needs
the texture and not the stencil.

Its eight **cars** were here too and are not any more: the race went back to
hand-drawn karts on 2026-09-13 (`scripts/draw-karts.sh`), which owe Dust Racing
nothing, so the files and the script that cut them are gone with them. Nothing
derived from them survives in `assets/vehicles/`. Git still has them if the
question is ever reopened.

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
  - `assets/tiled/png/src/scenery.png` and `assets/tiled/scenery.tsj` — the ground
    a track is landscaped with, from `scripts/make-scenery.sh`
  - `assets/tiled/png/src/decal/RACE_*.png` and `assets/tiled/decal-race.tsj` —
    the trees, rocks, bushes, tyres, grandstands and signs beside it, from the
    same script
  - `assets/tiled/png/baked/atlas-furniture.png` insofar as it packs those decals

The rest of the repository is unaffected: a licence attaches to these image
files, not to the code that loads them.

**Dust Racing 2D's own CODE is GPLv3 and none of it is used here.** The handling
model in `shared/src/office/race/` was written from standard vehicle dynamics;
what was taken from that project is what this file lists — pictures of ground and
plants — and one idea that is not copyrightable (a camera that leads the car by
its speed).

## What was changed

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
