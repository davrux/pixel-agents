# Pet / NPC sprite sheets

`cat_0.png`, `cat_1.png` — and identically `dog_*.png`, `duck_*.png`. One file is
one NPC variant, and every bundled one has a name: `dog_0` **Emma** (beagle),
`dog_1` **Balu**, `cat_0` **Loui** (tuxedo), `cat_1` **Daisy** (tabby), `duck_0`
**Rudi** (the green-headed drake), `duck_1` **Frieda**. The display names live in
`PET_NAMES` (`server/src/assetOverrides.ts`), which fills them in the same place
bundled skins get theirs from `CHAR_NAMES`, so no UI shows the slot id; they are
fixed rather than generated, because a name is what a zone's NPC is picked by and
one that changed between restarts would make every list disagree with yesterday's.
A slot with no entry falls back to the generic `Duck 3`. The **id stays `dog_0`**: it is the key
`saveAsset`/`deleteAsset` and a zone's NPC selection are stored under, so a rename
is a label change and never a file rename. How
many variants load is capped by `CAT_COUNT` in
`server/src/core/assets/constants.ts:28`, and loading stops at the first missing
number, so variants must stay contiguous from `_0`.

## File format

**96×64 RGBA PNG — a 6 × 4 grid of 16×16 frames.** No margin, no extrusion, no
padding: frame `(col, row)` is exactly the rect at `(col*16, row*16)`. Nothing in
the file carries its own dimensions, so the size is not negotiable — `decodePetPng`
(`server/src/core/assets/pngDecoder.ts:188`) slices on those constants with no
bounds check, and gets it wrong in two different ways: a **wider** sheet is
silently cropped (measured: a 192×96 sheet decodes "fine", as a quarter of the intended
art), while a **narrower** one throws and is swallowed by `loadPetSprites`, which returns
null for the whole load — one short cat sheet and the dogs and ducks disappear too. A
sheet that is only three rows tall still decodes: the row count comes from the image
height, and the missing left row is filled by mirroring at the sprite store's door.

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
| 3 | **left** | real art; seeded by mirroring row 2 |

`PET_DIRECTIONS` (`constants.ts`). **Row 3 is left**, and it is real art like the
other three — no runtime mirroring any more. The bundled sheets got theirs by
mirroring row 2 once (`scripts/add-left-row.sh`), and the editor seeds a left row the
same way on save, so every sheet has four rows.

**Mirrored per CELL, never per row.** Flipping the whole 96-px strip also reverses the
order of the cells, so the walk columns end up holding the mirrored sit and idle frames —
a cat walking left sits down. It happened, it survived a screenshot (a dog's stand and
walk look alike in profile), and the check written at the time compared against the
whole-row mirror and therefore agreed with the bug. `server/src/leftRow.int.test.ts` now
asserts the property column by column, and includes a guard proving the two mirrors are
distinguishable on Daisy's sheet. Draw over it whenever the animal is not
symmetric: a marking that sits on one flank swaps sides in a mirror, which is exactly
why left stopped being computed. Neither cat has a side-specific marking (Loui's white
is on the chest, belly and paws, Daisy's stripes run across the body), so their mirrored
left rows are correct as they stand.

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

## What Emma's sheet draws (`dog_0`)

A tricolour beagle: tan head with a white blaze, dark saddle, white chest, legs and
tail tip. Column by column, as the contract requires:

| Col | Row 0 (down) | Row 1 (up) | Row 2 (right) |
|-----|--------------|------------|---------------|
| 0 | standing, front paws together | walking away | mid-stride, front leg forward |
| 1 | standing — **the stand frame** | walking away | mid-stride, legs gathered |
| 2 | standing, weight shifted | walking away | mid-stride, opposite legs |
| 3 | sitting upright | sitting, seen from behind | sitting, facing right |
| 4 | sitting, eyes closed | sitting, tail to the side | sitting, eyes closed |
| 5 | standing | standing away | **standing** — not the `cat_1` gap |

Row 2 mirrors safely: the saddle and the white legs are symmetric, and nothing on the
flank marks one side.

Emma was reduced from a 1774×887 source (`tmp/emma.png`, not committed — the same
situation as the cats), one 16×16 frame per ~19×19 source pixels. Three things about
that reduction are worth knowing before repeating it:

- **The 6×3 grid cannot be assumed.** The longest dog is 326 px wide against a
  295.67 px nominal cell, so slicing on the grid cuts one animal and glues part of it
  onto its neighbour. The frames were taken as connected components instead — exactly
  18, one per cell.
- **One scale for all 18 frames**, as large as fits without any frame leaving its
  cell. Per-frame fitting makes the dog change size when it turns.
- **A median beats a mean, and the face needs a rule of its own.** At 19:1 a mean
  turns everything to mush. Eyes, nose and outlines are all near-black (measured: 1st
  luminance percentile 7 in the head, 22 in the legs), so darkness cannot separate
  them — **density** can: an eye fills a whole source block, an outline is a thin
  line. Ink wins the pixel at ≥30 % coverage; at 12 % the outlines bled and turned the
  white chest and legs dark.

## What the cat sheets draw

Both cats follow the contract above; described down each column:

| Col | Row 0 (down) | Row 1 (up) | Row 2 (right) |
|-----|--------------|------------|---------------|
| 0 | standing, tail raised behind | walking away, tail raised | mid-stride, tail raised |
| 1 | standing — **the stand frame** | walking away | mid-stride, legs gathered |
| 2 | standing, weight shifted | walking away | mid-stride, opposite legs |
| 3 | sitting upright | sitting, seen from behind | sitting, facing right |
| 4 | sitting, eyes closed | sitting, seen from behind | sitting, eyes closed |
| 5 | standing, tail raised | standing away, tail raised | Loui standing; **Daisy sitting** |

Note that the cats' `walk` frames for rows 0 and 1 are near-static — a
front-facing walk barely moves at 16×16 — while row 2 carries the real gait. Every
generation of this art has been arranged that way, the orange cats these replaced
included.

**Known gap in `cat_1`:** Daisy's row 2 column 5 is a *sitting* pose where it
should be a stand. Column 5 is the `idle` frame and also stands in for `drink` and
`talk` (see the table above), so a Daisy waiting at a coffee station facing left or
right reads as seated. Loui's column 5 is a stand in all three rows. Fixing it
means redrawing that one frame; nothing in code can compensate, because the engine
has no other frame to ask for.

## Editing

Regenerate or repaint at **96×64**, keep the grid, keep the column meanings, and
keep left/right symmetry in mind for row 2. The art must be **drawn at 16×16**, not
drawn larger and scaled down — art composed at ~24–26 px loses an eye off every
front-facing face when it is reduced, and the loss is invisible until you compare
frames side by side. For generating a sheet from photos of a real animal, see
[PROMPT.md](PROMPT.md), which also lists how to verify one before committing it.

**A saved override shadows the file.** An NPC edited in the in-game editor is stored
in the database (`assets`, type `pet`, keyed `dog_0`) and `buildMerged`
(`server/src/assetOverrides.ts`) puts that row in place of the whole bundled entry —
art, spec and spawn config. So in any world where somebody once pressed Save on a
variant, dropping a new PNG here changes **nothing** until that override is reset
(NPC editor → Reset, i.e. `deleteAsset`), and the symptom is silent: the file is
correct, the sheet decodes, and the old animal still walks around. Emma hit exactly
this on the dev world. Note that a reset also drops that variant's spawn config back
to the default (60–180 s, max 1) — re-set it in the editor if it was tuned.

There is no bake step and no committed artifact: `loadPetSprites` (`server/src/assetLoader.ts:237`) reads these
PNGs at startup and the frames are sent to clients as sprite data, so a change is
live on the next server start. These files are **not** part of the Tiled pipeline
and never enter the furniture atlas.

The two cats on disk did not arrive drawn at 16×16. They were generated at roughly
32 px per cell and reduced 2:1, which is why their fur is mottled where the orange
cats before them were flat: halving pixel art aliases every 1 px stripe, and no
resampling rule recovers a detail that lands between two output pixels. What did
survive — eye, nose, ear pink — survived because the reduction let a rare,
chromatically distant colour outvote the local average in its block; a plain area
average dissolves all three. Treat that as a rescue, not a pipeline: drawing at
16×16 remains the only way to get a clean sheet.
