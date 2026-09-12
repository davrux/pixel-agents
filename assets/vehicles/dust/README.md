# Car sprites from Dust Racing 2D

These eight PNGs are the car sprites from **[Dust Racing 2D](https://github.com/juzzlin/DustRacing2D)**
by Jussi Lind and contributors, taken from `data/images/`.

## Licence — read this before touching them

> All image files, except where otherwise noted, are licensed under
> **[CC BY-SA 3.0](http://creativecommons.org/licenses/by-sa/3.0/)**.

That is **not** this repository's licence. pixel-agents is MIT; these files and
anything derived from them are CC BY-SA 3.0, which means two obligations that
travel with them:

- **Attribution.** Dust Racing 2D and its authors must be credited wherever the
  art is used or redistributed. This file is that credit; keep it beside them.
- **Share-alike.** A modified version stays CC BY-SA 3.0. The game-scale sprites
  in `assets/vehicles/car-*.png` ARE modified versions — generated from these by
  `scripts/make-vehicles.sh` — so they carry the same licence, and so would any
  repaint of them.

The rest of the repository is unaffected: a licence attaches to these image
files, not to the code that loads them.

**Dust Racing 2D's own CODE is GPLv3 and none of it is used here.** The handling
model in `shared/src/office/race/` was written from standard vehicle dynamics;
what was taken from that project is what this file lists — pictures of cars — and
one idea that is not copyrightable (a camera that leads the car by its speed).

## What was changed

`scripts/make-vehicles.sh` turns each 175×93 source into a game-scale sprite:

- **The pure green (0, 255, 0) is replaced with dark glass.** It is a mask in the
  original — exactly 2864 pixels of it in every car, identical across colours —
  and left alone it renders as a bright green windscreen.
- **Scaled down by area average** to roughly two tiles long, because this world
  is 16 px tiles and a 175 px car is eleven of them.
- The sprite points EAST at heading 0, which is the convention the kart model
  uses (`race/kart.ts`).
