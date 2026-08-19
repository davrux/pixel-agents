# Pet / NPC sprite sheets

`cat_0.png`, `cat_1.png` — and identically `dog_*.png`, `duck_*.png`. One file is
one NPC variant. `cat_0` is **Loui** (tuxedo), `cat_1` is **Daisy** (tabby); how
many variants load is capped by `CAT_COUNT` in
`server/src/core/assets/constants.ts:28`, and loading stops at the first missing
number, so variants must stay contiguous from `_0`.

## File format

**96×48 RGBA PNG — a 6 × 3 grid of 16×16 frames.** No margin, no extrusion, no
padding: frame `(col, row)` is exactly the rect at `(col*16, row*16)`. Nothing in
the file carries its own dimensions, so the size is not negotiable — `decodePetPng`
(`server/src/core/assets/pngDecoder.ts:188`) slices on those constants with no
bounds check, and gets it wrong in two different ways: a **larger** sheet is
silently cropped to the top-left 96×48 (measured: a 192×96 sheet decodes "fine",
as a quarter of the intended art), while a **smaller** one throws and is swallowed
by `loadPetSprites`, which returns null for the whole load — one short cat sheet
and the dogs and ducks disappear too.

Alpha is per-pixel, not a hard mask: `a < 2` becomes transparent (`''`), and
anything above that is kept, semi-transparent values included (they survive as
`#RRGGBBAA` — measured: 50 % red round-trips to `#FF000080`). Anti-aliased edges
therefore do **not** get cleaned up for you; they reach the renderer as translucent
pixels and read as blur at 16×16, so keep the art hard-edged.

## Rows are facings

| Row | Facing | Notes |
|-----|--------|-------|
| 0 | **down** — toward the camera | |
| 1 | **up** — away from the camera | the animal's back |
| 2 | **right** | |

`PET_DIRECTIONS` (`constants.ts:23`). **There is no left row.** Left is produced
at runtime by mirroring row 2 horizontally (`buildCharacterSprites`,
`spriteData.ts:337`), which is the one real authoring constraint here: any marking
on row 2 that is not left/right symmetric will swap sides when the animal turns
around. Neither cat carries a side-specific marking — Loui's white is on the
chest, belly and paws, Daisy's stripes run across the body — so both mirror safely.

## Columns are animation tracks

Columns are **not** free slots — their meaning comes from the *order* of the
tracks in `PET_SPRITE_SPEC` (`shared/src/office/sprites/characterSpec.ts:56`).
Each track claims the next N columns (`trackSlots`, `spriteData.ts:277`):

| Cols | Track | Playback | Plays as |
|------|-------|----------|----------|
| 0,1,2 | `walk` | ping-pong | `0 → 1 → 2 → 1`, looping (4 steps) |
| 3,4 | `sit` | loop | `3 → 4` |
| 5 | `idle` | loop | `5` — a single static frame |

Consequences of that layout:

- **Column 1 is the neutral standing pose.** `standIdx = walk.start + 1`
  (`spriteData.ts:343`) makes it both the middle of the walk cycle and the
  fallback frame for any pose with no art. Draw it as the pose you would want to
  see if everything else failed.
- **Columns 3 and 4 must read as a two-frame loop, not a progression** — a
  settled animal with one thing moving (tail, ear, a blink). They are also the
  only pair, so a resting pose that needs three frames does not fit.
- **Column 5 does four jobs at once** (see below). It is the most-seen frame in
  the sheet.

## Which pose the engine asks for

`petPose` (`shared/src/office/engine/pets.ts:422`) maps the pet FSM state to a
track *name*; `spriteForPose` (`spriteData.ts:221`) then resolves the name to
columns, **falling back to the `idle` track when no track of that name exists**:

| Pet state | Pose asked for | Columns actually drawn |
|-----------|----------------|------------------------|
| `wander` | `walk` | 0,1,2,1 |
| `sit` (resting at a seat or desk) | `sit` | 3,4 |
| `drink` (standing at a coffee station) | `drink` | **5** — no `drink` track in the bundled spec |
| `talk` (standing beside an agent) | `talk` | **5** — no `talk` track either |
| `spawn`, `idle`, `despawn` | `idle` | 5 |

So the bundled sheets have three tracks but five behaviours, and column 5 covers
standing around, fading in, fading out, drinking and chatting. `sleep`, `drink`
and `talk` are real track names (`NPC_TRACK_NAMES`) that the NPC editor can add
frames for per variant — a sheet on disk simply never has them.

Chasing and fleeing (dogs chase cats, cats flee dogs) are not poses: they are
directed movement inside `wander`, so they animate as `walk`.

## What the cat sheets draw

Both cats follow the contract above; described down each column:

| Col | Row 0 (down) | Row 1 (up) | Row 2 (right) |
|-----|--------------|------------|---------------|
| 0 | sitting upright, tail out to one side | back, upright | mid-stride, tail raised |
| 1 | sitting upright — **the stand frame** | back, upright | mid-stride, legs gathered |
| 2 | head tilted, one ear folded | back, weight shifted | mid-stride, opposite legs |
| 3 | loafed down, paws tucked | back, settled low | lying down, tail low |
| 4 | loafed, paws tucked further | back, settled low | lying down, head up, eye and nose visible |
| 5 | sitting upright, tail visible | back, upright | standing, tail up |

Note that the cats' `walk` frames for rows 0 and 1 are near-static — a
front-facing walk barely moves at 16×16 — while row 2 carries the real gait. The
orange cats these replaced were arranged the same way.

## Editing

Regenerate or repaint at **96×48**, keep the grid, keep the column meanings, and
keep left/right symmetry in mind for row 2. The art must be **drawn at 16×16**, not
drawn larger and scaled down — art composed at ~24–26 px loses an eye off every
front-facing face when it is reduced, and the loss is invisible until you compare
frames side by side. For generating a sheet from photos of a real animal, see
[PROMPT.md](PROMPT.md), which also lists how to verify one before committing it.
There is no bake step and no
committed artifact: `loadPetSprites` (`server/src/assetLoader.ts:237`) reads these
PNGs at startup and the frames are sent to clients as sprite data, so a change is
live on the next server start. These files are **not** part of the Tiled pipeline
and never enter the furniture atlas.
