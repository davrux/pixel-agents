# Pet sprite sheets

`cat_0.png`, `cat_1.png` — and identically `dog_*.png`, `duck_*.png`. One file is
one pet variant, and every bundled one has a name: `dog_0` **Emma** (beagle),
`dog_1` **Balu**, `cat_0` **Loui** (tuxedo), `cat_1` **Daisy** (tabby), `duck_0`
**Rudi** (the green-headed drake), `duck_1` **Frieda**. The display names live in
`PET_NAMES` (`server/src/assetOverrides.ts`), which fills them in the same place
bundled skins get theirs from `CHAR_NAMES`, so no UI shows the slot id; they are
fixed rather than generated, because a name is what a zone's pet is picked by and
one that changed between restarts would make every list disagree with yesterday's.
A slot with no entry falls back to the generic `Duck 3`. The **id stays `dog_0`**: it is the key
`saveAsset`/`deleteAsset` and a zone's pet selection are stored under, so a rename
is a label change and never a file rename. How
many variants load is capped by `CAT_COUNT` in
`server/src/core/assets/constants.ts:28`, and loading stops at the first missing
number, so variants must stay contiguous from `_0`.

## File format

**128×64 RGBA PNG — an 8 × 4 grid of 16×16 frames.** No margin, no extrusion, no
padding: frame `(col, row)` is exactly the rect at `(col*16, row*16)`. It was 96×64 (six
columns) until a `talk` track was added 2026-08-27.

**The WIDTH is negotiable now; it was not when this file was written.** The paragraph here used to
say the size was fixed, because `decodePetPng` sliced these files at boot on the constants
`PET_FRAMES_PER_ROW` × `PET_FRAME_W` with no bounds check, and got a wider sheet wrong silently
(measured: a 192×96 sheet decoded "fine", as a quarter of the intended art). That decoder is no
longer in the path — art travels as a PNG, `loadPetSprites` reads the bytes without decoding, and
the column count is derived from the image width by the client's sheet store and by
`posePlaybackLength` through the spec. So a 7- or 8-column sheet is drawable; what it needs is a
matching track in `PET_SPRITE_SPEC` (see *Closing an art gap* below). `decodePetPng` still exists
as the reference implementation the frame-index test measures against, and still crops — do not
reintroduce it into a load path.

The **height** is still four rows of 16 (a three-row sheet decodes too: the row count comes from
the image height, and the missing left row is filled by mirroring at the sprite store's door), and
the frame SIZE is still 16×16 — that one really is fixed, since the bundled sheets carry no spec
and `PET_SPRITE_SPEC` supplies `frame: {w:16,h:16}`.

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
| 6,7 | `talk` | loop | `6 → 7` — the stand frame and the same pixels 1 px higher |

Consequences of that layout:

- **Column 1 is the neutral standing pose.** `standIdx = walk.start + 1`
  (`spriteData.ts:343`) makes it both the middle of the walk cycle and the
  fallback frame for any pose with no art. Draw it as the pose you would want to
  see if everything else failed.
- **Columns 3 and 4 must read as a two-frame loop, not a progression** — a
  settled animal with one thing moving (tail, ear, a blink). They are also the
  only pair, so a resting pose that needs three frames does not fit.
- **Column 5 does three jobs at once** (see below) — idle, spawn/despawn and `drink`. It is
  still the most-seen frame in the sheet. It used to do five: `talk` has its own columns now.
- **Columns 6 and 7 are a bounce, not a drawn talk pose.** They were derived from column 1 by
  `scripts/add-talk-track.sh`, which is honest but plain; redraw them (head up, muzzle open)
  whenever somebody wants to, the format does not care where the pixels came from.

## Which pose the engine asks for

`petPose` (`shared/src/office/engine/pets.ts:422`) maps the pet FSM state to a
track *name*; `spriteForPose` (`spriteData.ts:221`) then resolves the name to
columns, **falling back to the `idle` track when no track of that name exists**:

| Pet state | Pose asked for | Columns actually drawn |
|-----------|----------------|------------------------|
| `wander` | `walk` | 0,1,2,1 |
| `sit` (resting at a seat or desk) | `sit` | 3,4 |
| `drink` (standing at a coffee station) | `drink` | **5** — no `drink` track in the bundled spec |
| `talk` (standing beside an agent) | `talk` | 6,7 |
| `spawn`, `idle`, `despawn` | `idle` | 5 |

So the sheets have four tracks and column 5 still covers standing around, fading in, fading out
and drinking. `drink` is the one pose the engine asks for that nothing answers; the pet editor can
add a track for it per variant, and the sheets on disk have none.

`sleep` used to be on that list and is not any more: there is no sleep state anywhere in
`engine/pets.ts`, so frames drawn into a sleep track could never appear in the world. The editor
stopped offering it 2026-08-27 (it still RECOGNISES the name, so a sheet saved with one is not
re-derived underneath its author — see `TOLERATED_TRACK_NAMES`).

Two footnotes on that list, both measured 2026-08-27. `talk` and `drink` are poses the ENGINE
really asks for (`petPose`), so art drawn for them animates: at
`PET_TALK_FRAME_DURATION_SEC`/`PET_DRINK_FRAME_DURATION_SEC`, both 0.4 s. **`sleep` is not** —
there is no sleep state anywhere in `engine/pets.ts`, so frames drawn into a sleep track can never
appear in the world, however correct the sheet is.

### Closing an art gap

`talk` was closed this way on 2026-08-27 and `drink` is still open; the recipe is the same, and it
is two commits in either order, neither of which breaks the world on its own:

1. **Widen the sheets** and draw the frames. Every variant of every kind, or the ones without it
   keep falling back to column 5.
2. **Append a track** to `PET_SPRITE_SPEC` (`shared/src/office/sprites/characterSpec.ts`):
   `{ name: 'drink', frames: 2, play: 'loop' }` — and **append it to `PET_TRACKS` in the editor at
   the same position**, because that list's ORDER is what `deriveSpecTracks` hands the columns to.
   Getting those two out of step is not theoretical: `sleep` sat fourth in `PET_TRACKS` with two
   default frames, so the first 8-column sheet would have had columns 6-7 derived as SLEEP and
   talk left with nothing. `poseFrames.int.test.ts` compares the two lists now.

**Append, never insert.** A track claims the next free columns, so appending leaves walk 0-2,
sit 3-4 and idle 5 exactly where they are; inserting one renumbers every column after it and every
sheet already drawn animates the wrong pictures. And the order does not matter because a spec that
claims art the file does not have yet falls back to the idle frame rather than drawing a gap. Both
properties are pinned by `server/src/poseFrames.int.test.ts` ("a pet track can be APPENDED…").

A saved override is the other route and needs no format change at all: the pet editor's
`＋ Talk track` button adds the frames for one variant, and a stored sheet carries its own spec and
frame count, so it may be any width (`encodeDirectionalSheet` treats the pet column count as a
minimum, not a cap).

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
| 6,7 | derived from col 1 | derived from col 1 | derived from col 1 |

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
| 6,7 | derived from col 1 | derived from col 1 | derived from col 1 |

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

Regenerate or repaint at **128×64**, keep the grid, keep the column meanings, and
keep left/right symmetry in mind for row 2. The art must be **drawn at 16×16**, not
drawn larger and scaled down — art composed at ~24–26 px loses an eye off every
front-facing face when it is reduced, and the loss is invisible until you compare
frames side by side. For generating a sheet from photos of a real animal, see
[PROMPT.md](PROMPT.md), which also lists how to verify one before committing it.

**A saved override shadows the file.** An pet edited in the in-game editor is stored
in the database (`assets`, type `pet`, keyed `dog_0`) and `buildMerged`
(`server/src/assetOverrides.ts`) puts that row in place of the whole bundled entry —
art, spec and spawn config. So in any world where somebody once pressed Save on a
variant, dropping a new PNG here changes **nothing** until that override is reset
(pet editor → Reset, i.e. `deleteAsset`), and the symptom is silent: the file is
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
