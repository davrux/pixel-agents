---
name: tiled-asset-import
description: Bring a new art pack into the world as Tiled tilesets — deciding what each piece IS (floor, decal, furniture), whether it becomes a sheet or a collection, and how to bake, verify and wire it without breaking existing maps. Use when importing or re-importing any art pack, adding a tileset, or changing how art reaches the client.
---

# Getting new art into the world

This is the procedure for turning a downloaded art pack into tilesets a mapper can
paint from. It exists because the same three decisions and the same four traps come
back every single time, and getting one of them wrong is cheap to do and expensive
to notice: art that looks right in Tiled and renders wrong, or renders right and
silently kills every placement in a saved map.

Read this before writing an importer. The scripts in `server/scripts/gen-*.mts` are
worked examples of it — `gen-decal-roads.mts` for a sheet, `gen-metro-outdoor.mts`
for a split, `gen-overworld.mts` for both at once.

---

## Step 0 — Look at the sheet, with measurements

```bash
scripts/inspect-sheet.sh tmp/gfx/Overworld.png --contact /tmp/contact.png
```

This proposes, per cell, which of the answers in Step 1 it probably is, and prints
the evidence it used: how much of the cell is painted, whether the art continues
across the cell's own seam (a lawn does, a house wall does not), whether it runs
into its neighbours, whether it repeats art from earlier in the sheet, and where the
painted mass sits. `--contact` writes a magnified sheet with a coloured frame per
cell so your eyes get the last word.

Use it to turn "study 1440 cells" into "confirm 1440 proposals", and to answer
Step 2 with a number rather than a feeling: **many BLOCK cells mean the arrangement
is the content**, so the pack wants to be a sheet. On the Overworld pack it reports
364 of them.

What it cannot decide, and will tell you so: whether a piece needs BEHAVIOUR — only
then is it furniture — and what it depicts. A puddle is ground; a well is not.

One honest limit, worth knowing before you trust a label: separating ground from a
building is the weakest part, because a lawn and a plank wall are equally opaque.
The tool distinguishes them by whether the art continues across the cell's own seam,
tolerating a quarter of the edge (hand-drawn terrain varies pixel by pixel — an exact
test found 29 terrain cells where there are visibly hundreds). Corners, beams and
window frames break that continuity, which is why houses come out as BLOCK. Expect to
overrule it at shorelines and cliff edges, where both are true at once.

## Step 1 — Decide what each piece IS

Nothing about this can be derived from the pixels. It takes eyes, and the answer
belongs in the importer **as a written-down list**, not in the head of whoever ran
it. There are four possible answers, and they differ in what they cost:

| It is | Becomes | Costs | Can it |
|---|---|---|---|
| **Ground you walk on** — grass, paving, water, dirt | a **floor set** (baked sheet, painted on `GroundLayer`) | two numbers per cell in the layout | never block, never be an obstacle |
| **Flat art lying on the ground** — a puddle, a shadow, tufts, road markings | a **decal** on a flat `DecalLayer` | one gid per cell, travels with the map | not block (paint `CollisionLayer` if it must) |
| **Standing art you can walk behind** — a tree, a fence, a lamp post | a **decal** on a layer with `occludes` | the same | not block, not be interacted with |
| **A thing with behaviour** — a chair, a coffee machine, a portal, anything switchable | **furniture** (`FurnitureTile` + an object placement) | a `FurnitureSync` with fifteen synced fields, visited by eleven linear scans | everything |

The rule of thumb: **if it only needs to be seen, it is not furniture.** A map of a
street is mostly ground and decoration, and paying a chair's price for a patch of
grass is what makes a large map expensive. Conversely, do not make something a decal
because it is cheaper if a player has to sit on it — a decal has no behaviour at
all, and there is nowhere to add one later.

`docs/design.md`'s "Two homes for a picture" explains the cost difference; the
README chapter on decals is what a mapper reads.

---

## Step 2 — Sheet or collection?

Tiled tilesets come in two shapes, and both are in this repo. This is not a matter
of taste: it follows from whether the art's **arrangement** carries meaning.

**A collection of images** — each tile names its own PNG file
(`furniture-decor.tsj`, `decal.tsj`). Tile sizes may differ freely: a 16×16 bush
beside a 32×64 tree beside an 80×80 ground patch. Tiled's palette shows them in
tile-id order and wraps by panel width, so their arrangement is arbitrary.

> Choose it for **standalone objects placed one at a time**.

**A grid tileset ("sheet")** — the tileset has ONE image plus grid geometry
(`columns`, `tilewidth`, `tileheight`, `spacing`, `margin`), and a tile *is* a
position in it (`decal-roads.tsj`, `decal-overworld.tsj`, every floor and wall set).
All cells are the same size. Tiled shows the sheet exactly as drawn, so a mapper can
rubber-band a 3×3 junction or a whole house and stamp it as one block.

> Choose it when the art only makes sense **next to its neighbours** — terrain,
> roads, walls, a building drawn across several cells — or when the source is a
> collage. Slicing a collage needs a long table of hand-judged rectangles and
> destroys the very arrangement you paint from.

**Where an import writes — this is not a preference, it is the rule:**

| Goes to | What | Why there |
|---|---|---|
| `png/src/furniture/…` | a collection's per-tile PNGs | art, even though a script cut it |
| `png/src/decal/…` | per-tile decal PNGs | same |
| `png/src/sheets/…` | a grid tileset's own PNG | art: the pack it came from is outside the repo, so a checkout can never regenerate it |
| `png/src/floors/`, `png/src/walls/` | patterns and wall geometry the sheet bake reads | art, hand-drawn or cut |
| `png/src/images/…` | background images | art |
| `png/baked/…` | **nothing you write** | only what a build reproduces from `png/src` alone: the palette-baked floor/wall sheets and the furniture atlas |

An import NEVER writes to `png/baked/`. The test for a new file is one question:
*could a fresh checkout rebuild this from `png/src` alone?* If no — and that is true
of everything cut from a pack in `tmp/` — it is source, however generated it looks.
Getting this backwards means "clean out baked/ and re-bake" deletes art for good.

You also do not bake the atlas: the server does that itself whenever the source art
changed (`ensureFurnitureAtlas`).

Consequences either way, so nothing surprises you later:

- A collection's tiles get packed into the furniture atlas and travel to the client
  as one image. You do not bake it: the server does, at startup and on a tileset
  save, whenever the source art has changed
  (`ensureFurnitureAtlas`). `scripts/bake-atlas.sh --check` is the CI question.
- **A sheet already IS an atlas.** It is served as its own PNG and drawn from by
  frame — which is why Step 3's gap is mandatory for it.
- A sheet loses no expressiveness: its cells can carry `tiles[]` entries with
  labels and behaviour just like a collection's.

---

## Step 3 — The four mechanics that have each cost us a bug

### Gap and extrusion, on every sheet

Bake **2 px of gap between cells, and extrude each cell's border 1 px into that
gap** (`composeSheet` in `bake-floor-wall-tiled.mts` does both; copy it).

Why: the client draws a cell as a *frame of one texture*, and at a fractional
camera zoom the GPU can sample one texel outside the frame. Touching cells then
bleed a stripe of the neighbour between every tile — reported from a real GPU as
"Rillen" and invisible in headless software rendering. A gap alone is not enough: it
only changes that stripe's colour to "background", which on a floor still reads as a
groove. Repeating the edge pixel makes the stray sample land on the cell's own
colour, so the seam has nothing to show.

Record the gap in the `.tsj` (`spacing`) and have every reader take it **from
there** — `sets.json` hands it to the client for exactly this reason. A constant in
the reader is how a re-baked sheet and its reader drift apart.

### Ids are identity — never renumber them

A catalog id is what a saved map's placements point at. Change the scheme and every
placement of it silently draws nothing.

This is not hypothetical: `uponu.tmj` carries 17 overworld placements naming
`OW_ROCKS_MOSSY`, `OW_08` and friends, from a slicing importer that was later
replaced by a grid one with positional ids (`OW_0_0`). Nothing errored. The art
simply stopped appearing.

So: pick a scheme once, prefer **position-derived** ids for a sheet
(`ROAD_R05C07` — stable as long as the sheet's layout is, and readable in a diff),
keep them when re-importing, and if you must change them, expect to re-author the
maps that used them.

### Deterministic output

Sort before writing, never stamp a time, and check that running the importer twice
produces identical bytes (`md5sum`). These artifacts are committed; an importer
whose output depends on directory order makes every contributor's re-run a diff.

### Appending must not disturb what exists

When adding to a hand-maintained tileset, copy existing tiles through byte for byte
and give new ones ids after the highest — that leaves every gid in every saved map
pointing where it did. Adding or removing a tileset **does** shift the global gid
table; then run `scripts/sync-furniture-properties.sh --fix-gids` and **prove** the
repair by importing before and after and comparing the placement list. (That script
once corrupted every flipped placement through signed 32-bit arithmetic; the fix is
in, the lesson is that a wholesale gid rewrite deserves a diff you can read.)

---

## Step 4 — Wire it, in this order

1. **Properties**: a new tile class or property goes in `Pixels.tiled-project`
   *and* its definition (`furnitureProps.ts` / `decalProps.ts`), then
   `scripts/sync-furniture-properties.sh` distributes it. Every tile carries every
   property with its default filled in — a property a mapper must remember to add is
   one they will forget.
2. **Bake** whatever needs baking: `bake-floor-wall-tiled.mts` for floor/wall sets,
   `bake-furniture-atlas.mts` after any change to collection art.
3. **Check**: `scripts/sync-furniture-properties.sh --check` must be clean, and it
   also reports a stale gid table.
4. **Tests + build**: `pnpm -r run check-types`, `pnpm build`, `cd server && pnpm test`.
5. **Tell the mapper**: the README's Tiled chapter is the manual — a new set or
   property that is not in it does not exist as far as anyone else is concerned.

---

## Step 5 — Verify what cannot be seen

The failure mode of every importer here is the same: **art that is present but
wrong**, because a rect is off by one cell. A misplaced road piece still looks like a
road, and a misplaced chair still looks like a chair. Screenshots do not catch it.

So verify mechanically, and say what you verified:

- **Pixel-compare every frame against its source.** For a sheet, crop each cell out
  of the baked PNG and compare to the source cell; for an atlas, compare each rect
  in the manifest to the file it came from. This is cheap (a few seconds for
  hundreds of tiles) and it is the only check that catches an off-by-one.
- **Count what the renderer holds**: the perf overlay (**F8**, or `?perf=1`) shows
  `tex/p/f` — live textures, atlas pages, packed frames. A sheet that loaded adds
  one texture; art drawn from a fetched image adds no packed frames.
- **Check the map still imports the same**: run the import before and after and
  compare the placement list, not just the count.
- **Both browsers**, per AGENTS.md invariant 9. Firefox no longer speaks CDP —
  drive it over WebDriver BiDi (`--remote-debugging-port`, `session.new` with
  `acceptInsecureCerts`).
- **Restart the dev server after touching `shared/`.** `tsx watch` does not reload
  it, and a stale server against a fresh bundle produces decode errors that look
  like a bug in your change.

---

## Where things live

- **The pack itself stays out of git** — `tmp/` is gitignored. Only derived art is
  committed: the sheet copy or the sliced PNGs, the `.tsj`, and any baked output.
- Importers live in `server/scripts/gen-*.mts`, one per pack, with the judgement
  calls written into the header. Anything a human runs gets a `.sh` wrapper in
  `scripts/` (see `scripts/push-zones.sh` for the house style).
- Credit the artist in the README. It is their work.
