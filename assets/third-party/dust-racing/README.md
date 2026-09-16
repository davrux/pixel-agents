# Art from Dust Racing 2D

The PNGs in this directory are from **[Dust Racing 2D](https://github.com/juzzlin/DustRacing2D)**
by Jussi Lind and contributors, taken from `data/images/`:

- the **ground** a track is made of — `grass.png`, `sand.png` and, since
  2026-09-15, `asphalt.png`. The road used to be drawn with tiles this repository
  generated itself, and a flat grey field with a red-and-white border is what that
  gets you; the pack's asphalt has real grain and is the single biggest difference
  between a road and a grey rectangle.
- the **things beside it** — `tree.png`, `rock.png`, `plant.png`, and now
  `bushArea.png`, `tire.png` (a tyre wall on the outside of every corner) and
  `brake.png` (the board before the tightest corner).

`grandstand.png` was here for a day and is gone again: it is drawn for a world
whose road is 256 px wide, and at the scale that puts a kart at forty pixels a
stand came out as a six-cell rectangle of confetti. Scaling it up would only make
the spectators bigger than the cars. Git has it if the trackside ever gets
something to hang it on.

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

## The tracks

`monza.trk` is one of Dust Racing's sixteen **levels** from `data/levels/`. What
this world takes from it is the SHAPE of the lap and nothing else: the road's
width, its kerbs, the sand, the barrier, the gates, the grid, the landscape and
the paddock are all derived by `make-tracks.mts`, so an imported circuit is the
same kind of thing as a hand-drawn one.

Twelve of the sixteen fail the importer's own checks — the walk misses most of
the road, or the line zigzags, or a corner is tighter than a kart can take, or it
does not fit. See the refusal block in `make-tracks.mts` for what each check is
for.

**Three that passed are not here either**, and that is a decision rather than a
refusal: `figure8.trk`, `ring.trk` and `westernValley.trk` were imported, built
and raced, and were removed on 2026-09-16 because two circuits are enough to
have. They can be fetched again from `data/levels/` of the upstream repository —
`Figure 8.trk`, `ring.trk` and `Western Valley.trk` — and the generator takes
them unchanged: `fromDust('<file>', { scale: 5, pad: 9, smooth: 6, every: 2 })`
is all any of them needed. What they paid for is still in the code: the computer
driver's corner-speed cap was written for the Ring's sustained bends and is what
makes any circuit with a real corner raceable.

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
