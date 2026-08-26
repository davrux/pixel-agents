# Generating an agent character sheet

A ready-to-paste prompt for an image-generating AI, the format it has to hit, and
how to check what comes back. Characters are the avatars agents and players wear;
the dogs, cats and ducks are a different, smaller format with its own prompt in
[../pets/PROMPT.md](../pets/PROMPT.md).

There is no `README.md` in this directory, so the format is described here rather
than linked. Every claim below was checked by running the loader, not read off a
comment.

## The format

`char_0.png`, `char_1.png`, … — one file per skin. Loading scans `char_<n>.png` and
**stops at the first gap**, so the numbers must stay contiguous from `_0`
(`loadCharacterSprites`, `server/src/assetLoader.ts:180`).

**16×32 frames in 4 rows** by default. The bundled sheets are **112×128** — 7 frames
per row — but the frame size is per character, not a constant: a sheet may declare its
own up to 64×64 (see the manifest below). Unlike the pet sheets, the frame
*count* is not fixed either: it is derived from the image width
(`Math.floor(width / frameW)`, `pngDecoder.ts:174`), and the default track layout
declares **9** frames. So at 16×32 a **144×128** sheet is the better target — it fills
every track, needs no code change, and is the only way to get real `coffee` art.

The height decides how many facings are read — the longest present prefix of
(down, up, right, left), so a sheet should be **four rows tall**. A short one is not
fatal (three rows load and the left row is seeded by mirroring), but a sheet shorter
than one row throws inside the decoder, and `loadCharacterSprites` swallows the error
and returns null for **the whole directory** — every agent loses its art, not just the
broken skin.

Getting the width wrong fails silently instead, which is worse to diagnose. 128×96
loads happily and quietly turns `coffee` into a one-frame track, because the 9th
frame the spec wants is not there.

Alpha is per-pixel, not a mask: `a < 2` becomes transparent, and anything above
survives — semi-transparent values included, as `#RRGGBBAA`. Anti-aliased edges are
not cleaned up for you; they reach the renderer as translucent pixels and read as
blur. All six bundled sheets are strictly binary (0 or 255) and carry 24–43
colours.

An optional `char_N.json` manifest overrides the frame size and declares tracks
(`resolveCharacterSpec`); it never throws, so a malformed one silently falls back
to the default layout. Frames cap at 64×64.

### Rows are facings

| Row | Facing |
|-----|--------|
| 0 | **down** — toward the camera |
| 1 | **up** — away from the camera |
| 2 | **right** |

**Row 3 is left** — real art, not computed. A sheet may omit it (the row count comes
from the image height) and then the left row is seeded by mirroring row 2 once, but
marking on row 2 may be side-specific — no logo, badge, text, parting, or patch on
one flank only. It must read correctly flipped.

### Columns are animation tracks

Column meaning comes from the *order* of the tracks in `DEFAULT_CHARACTER_SPEC`
(`shared/src/office/sprites/characterSpec.ts:43`); each track claims the next N
columns:

| Cols | Track | Playback | Plays as |
|------|-------|----------|----------|
| 0,1,2 | `walk` | ping-pong | `0 → 1 → 2 → 1`, looping |
| 3,4 | `typing` | loop | `3 → 4` |
| 5,6 | `reading` | loop | `5 → 6` |
| 7,8 | `coffee` | loop | `7 → 8` — **absent on a 112-wide sheet** |

**Column 1 is the neutral standing frame.** It is the middle of the walk cycle, the
`idle` pose, and the fallback for every track the sheet does not carry. It is by far
the most-displayed frame — draw it as the one you would want if everything else
failed.

### Which pose the engine asks for

`getCharacterPose` (`shared/src/office/engine/characters.ts:341`) maps state to a
track name, and `spriteForPose` resolves the name to columns — falling back to the
`idle` track, then to the bare stand frame:

| Character state | Pose | Columns actually drawn |
|-----------------|------|------------------------|
| `walk` | `walk` | 0,1,2,1 |
| `type` with a normal tool | `typing` | 3,4 |
| `type` with a reading tool | `reading` | 5,6 |
| `idle` while standing at a station | `coffee` | 7,8 — or **col 1** on a 7-frame sheet |
| `idle` anywhere else | `idle` | **col 1** — there is no `idle` track |
| `sit` (player rest emote) | `sit` | **synthesized** — col 1 shifted down 9 px |

Two consequences worth drawing on purpose:

- **`typing` and `reading` are not always seated.** An agent with a desk sits at it
  and takes the seat's facing; an agent with no seat assigned types *in place*,
  standing wherever it is. Both frames have to work standing in the open.
- **`sit` has no art at all.** It is the stand frame pushed down 9 px, so the legs
  fold off the bottom of the frame. A real `sit` track can be authored in the
  character editor and takes precedence; a PNG on disk cannot carry one.

### Where the art sits in the frame

The sprite is anchored **bottom-centre** of the 16×32 frame, so where content sits
inside the frame is where it appears relative to the tile. The bundled sheets are
13–16 px wide and 22–28 px tall, with walk frames' feet at rows 29–30. They do not
keep one baseline across all columns — `char_0`'s down-row typing and reading frames
reach row 31 while its up-row ones stop at row 25 — because those usually play at a
desk.

### One thing that is done to your colours

Agents beyond the first round of skins get a **random hue rotation of at least 45°**
applied to every pixel (`pickDiverseSkin`, `officeState.ts:715`), so one sheet
serves many agents. Skin tone, hair and clothing all rotate together. Design so the
sheet survives that: rely on value contrast and silhouette for readability, not on
one specific hue being correct.

## Four failures worth writing against

All four produce a file that looks fine and loads badly:

1. **Anti-aliased output.** Partial alpha survives the import and reads as blur.
2. **Art drawn larger than 16×32, then scaled down.** The one that is invisible
   until measured. It cost this repo three rounds on the cat sheets; at 16×32 a
   whole head is about 8 px across, so a reduction takes the face with it.
3. **A wrong sheet size.** Too short kills every skin in the directory; too wide
   silently changes an animation's length; too tall is harmless. Only one of those
   three announces itself.
4. **A detail budget the format cannot hold.** Fingers, facial features beyond
   eyes, buttons, text on clothing, and shoelaces all smear.

## The prompt

```
You are producing a pixel-art character sprite sheet for a 2D top-down game,
from reference photos of one specific person that I provide.

STEP 1 — READ THE PERSON FROM THE PHOTOS
Extract only these identity traits and carry them into the sprite: hair colour,
hair length and silhouette, skin tone, facial hair, glasses (yes/no), and the
colour and rough shape of the clothing (shirt colour, whether there is a jacket,
trouser colour, shoe colour). Ignore the photos' lighting, background, pose,
camera angle and expression. You are not stylising a photo — you are drawing a
new 16x32 character who reads as this person at a glance.

STEP 2 — THE FORMAT (non-negotiable)
Output ONE image, 1152 x 768 pixels, with a fully transparent background.

That image is a magnified 144 x 96 pixel sprite sheet. Every art pixel is an
8 x 8 block of identical colour. This is the single most important rule:
- Each 8x8 block, aligned to the grid starting at (0,0), MUST be one flat
  uniform RGBA colour.
- No anti-aliasing, no gradients, no soft or feathered edges, no blur, no
  noise, no texture, no dithering, no partial transparency. A pixel is either
  fully opaque or fully transparent.
- Do not draw at a higher detail level and shrink it. Compose the artwork as
  144 x 96 actual pixels, then render each of those pixels as an 8x8 block.
If you cannot honour the block grid, output the sheet at exactly 144 x 96
pixels instead.

STEP 3 — THE GRID
The 144 x 96 sheet is 9 columns x 3 rows of 16 x 32 frames, edge to edge, with
NO margin, NO padding, NO gutters and NO separator lines. Frame (col, row)
occupies exactly the 16x32 rect at (col*16, row*32).

Rows are the direction the character faces:
  Row 0 — facing the camera (front view, you see the face)
  Row 1 — facing away (back view, you see the back of the head; no face)
  Row 2 — facing RIGHT (side profile, looking right)

Row 3 is the left-facing row. Leaving it out is allowed — it is then seeded from a
mirrored row 2 — but drawing it is what lets an asymmetric character turn around
correctly.
Row 2 must therefore contain NO left/right-specific detail — no logo or badge
on one side, no text, no hair parting on one side only, no item held in a
specific hand. It must read correctly when flipped.

Columns are animation frames. All nine columns show the SAME person in the
SAME clothes, with only the pose changing:
  Col 0 — walk, contact pose A (left leg forward, opposite arm forward)
  Col 1 — standing still, upright, weight even, arms relaxed at the sides.
          This is both the middle of the walk cycle AND the frame the game
          shows whenever nothing else applies, so it is the most-seen frame in
          the game. Make it the most appealing one, and make sure it reads
          correctly in isolation.
  Col 2 — walk, contact pose B (mirror of col 0's leg positions)
  Col 3 — working at a keyboard: forearms raised toward the viewer, hands in
          front of the body at about waist-to-chest height
  Col 4 — the same keyboard pose with ONE small change (hands one pixel lower,
          or the head tipped one pixel down), because cols 3-4 loop as a
          two-frame animation. Do not make it a different pose.
  Col 5 — reading: both hands holding a small flat object (a book or tablet) in
          front of the chest, head angled slightly down toward it
  Col 6 — the same reading pose with ONE small change, for the same reason as
          col 4
  Col 7 — holding a mug: one hand raised near the face, mug visible as a small
          block of 2-3 pixels
  Col 8 — the same mug pose with ONE small change (mug at the lips, or the
          head tipped)

Cols 3-8 must also read correctly standing in the open, not only seated at a
desk — the game plays them in both situations.

Row 2's walk cycle carries the real gait: legs and arms clearly change across
cols 0-2. Rows 0 and 1 barely move — a front or back view walking toward or
away from the camera differs only by a leg swap and a subtle weight shift.

STEP 4 — DETAIL BUDGET AT 16x32
This is a very small canvas. Be ruthless:
- The figure fills roughly 13-15 px wide and 24-29 px tall inside its 16x32
  frame. Centre it horizontally. In cols 0-2 the feet must rest on the bottom
  edge or within two pixels of it (pixel rows 29-31) — the game anchors the
  sprite bottom-centre.
- Nothing may extend outside the frame: no raised arm, hair, or held object
  past the edges.
- The head is about 8-10 px wide and 8-10 px tall, i.e. roughly a third of the
  figure. Each eye is ONE pixel. Draw no nose, no mouth, no ears, no
  individual fingers, no eyebrows.
- Glasses, if the person wears them, are a single horizontal line of 3-4 px.
- Use a 1 px dark outline around the silhouette, in a darker shade of the
  adjacent colour rather than pure black.
- OMIT entirely: text or logos on clothing, buttons, belts, watches,
  shoelaces, pockets, fabric folds, ground shadow, highlights, reflections.
- Total palette: at most 20 colours plus transparent. Reuse the exact same
  palette across all 27 frames.
- Readability first: a silhouette that reads at 100% zoom beats an accurate
  detail that turns to mud.

STEP 5 — WHAT NOT TO PUT IN THE IMAGE
No background, no ground, no scenery, no desk, no chair, no frame borders, no
grid lines, no labels, no captions, no row or column numbers, no watermark, no
signature, and no extra rows or columns beyond the 9 x 3 grid.

DELIVERABLE
One 1152 x 768 transparent PNG (or exactly 144 x 96), containing 27 frames in
the 9 x 3 arrangement above, all of the same person, in one consistent palette.
```

## Notes on using it

- **Why 1152×768:** 8× on both axes, a power of two, so "every art pixel is an 8×8
  block" is a rule the model can hold onto — and it is what makes recovery exact
  rather than a reconstruction. Exactly 144×96 is better still if the tool will
  write it.
- **Ask for 9 columns even if you only care about 7.** Columns 7–8 are the only way
  to get `coffee` art, and a 112×96 sheet is not "smaller" — it is a sheet where
  standing at the coffee machine looks identical to standing anywhere else.
- **Why a tighter palette than the bundled sheets.** Those carry 24–43 colours, but
  they were drawn by hand at 16×32 where every shade was placed deliberately. A
  generator spends a loose budget on shading that turns to mud at this size, so the
  prompt asks for 20.
- **Send 3–4 photos of the same person** — face, upper body, and one full-length.
  The likeness comes from the references far more than from the wording.
- **A text description works too.** Replace STEP 1 with the description; nothing
  else changes.
- **Expect to check, not to trust.** Image generators rarely hold a pixel grid, and
  none reliably compose *at* 16×32.

## Verifying what comes back

1. **The size is exact.** 144×96 (or 112×96). A short sheet is fatal for every skin
   in the directory and a wrong width silently changes an animation — see the format
   section. Check this first; it is the cheapest check and the most damaging miss.
2. **It really is 16×32 art.** Collect the alpha-edge positions and score how
   tightly they cluster on a candidate pixel scale; the true grid scores far above
   every other candidate. A sheet that was composed larger and reduced scores near
   zero against the grid it claims — and nothing about that is visible on a
   magnified preview.
3. **Alpha is binary.** Every pixel 0 or 255. Partial alpha is kept, not cleaned.
4. **No frame is clipped, and the walk frames stand on the ground.** Per-cell bounding
   boxes of opaque pixels must sit inside 0–15 and 0–31. The feet rule is no longer only
   advice: `server/src/sheetBaseline.int.test.ts` requires every bundled sheet's WALK
   frames (the columns its spec gives that track, in every facing) to reach within four
   pixels of the cell's bottom edge, because the renderer draws with origin (0.5, 1) — the
   bottom edge IS the tile, and art drawn higher floats, with its name tag too high, in
   every zone. Measured on the roster: characters sit 1–2 px above the edge, pets 0–3.
   Seated columns are exempt on purpose — a sitter legitimately sits higher.
5. **It loads, and the others still do.** Run `loadCharacterSprites` and confirm it
   returns all the skins, not null — a broken sheet takes the whole directory with
   it. Then check 3 directions × 9 frames have content.
6. **Row 2 mirrors.** Flip it horizontally and look for anything that changed sides.
