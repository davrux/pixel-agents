# Generating a pet sprite sheet from photos of a real animal

A ready-to-paste prompt for an image-generating AI, plus what to expect from it.
Covers all three pet kinds — **cat, dog and duck** — because they share one sheet
format exactly; only the animal differs. The format is described in
[README.md](README.md), which is worth reading first if you want to know *why* a
column means what it means. The agent avatars are a different format, with their own
prompt in [../characters/PROMPT.md](../characters/PROMPT.md).

Paste **two** blocks into the generator: the shared prompt below, then the one
"STEP 5" block for the animal you want.

The prompt is written against four failures that have actually happened here, all
four of which produce a file that looks fine and imports badly:

1. **Anti-aliased output.** Smooth edges and partial alpha survive the import
   (alpha is per-pixel, not a mask), reach the renderer as translucent pixels and
   read as blur at 16×16.
2. **Art drawn larger than 16×16, then scaled down.** The worst one, because it is
   invisible until you measure it. It took three rounds to catch on the cat sheets:
   art at ~26 px lost an eye off every front-facing face, and the ~32 px version
   that shipped had to be reduced 2:1, which is why those two cats have mottled fur
   where the flat ones before them did not.
3. **Padding around the grid.** Two native pixels of margin made one sheet 158 px
   wide, which does not divide by 6, so no frame landed where the importer looked.
4. **A detail budget the format cannot hold.** A collar and a separate nose
   triangle need ~24 px of head. At 16 px they smear into the muzzle.

## The shared prompt

```
You are producing a pixel-art sprite sheet for a 2D top-down game, from
reference photos of one specific real animal that I provide. STEP 5, which
follows this message, says which animal and what to take from the photos.

STEP 1 — THE FORMAT (non-negotiable)
Output ONE image, 1536 x 768 pixels, with a fully transparent background.

That image is a magnified 96 x 48 pixel sprite sheet. Every art pixel is a
16 x 16 block of identical colour. This is the single most important rule:
- Each 16x16 block, aligned to the grid starting at (0,0), MUST be one flat
  uniform RGBA colour.
- No anti-aliasing, no gradients, no soft or feathered edges, no blur, no
  noise, no texture, no dithering, no partial transparency. A pixel is either
  fully opaque or fully transparent.
- Do not draw at a higher detail level and shrink it. Compose the artwork as
  96 x 48 actual pixels, then render each of those pixels as a 16x16 block.
If you cannot honour the block grid, output the sheet at exactly 96 x 48
pixels instead.

STEP 2 — THE GRID
The 96 x 48 sheet is 6 columns x 3 rows of 16 x 16 frames, edge to edge, with
NO margin, NO padding, NO gutters and NO separator lines. Frame (col, row)
occupies exactly the 16x16 rect at (col*16, row*16).

Rows are the direction the animal faces:
  Row 0 — facing the camera (front view, you see the face)
  Row 1 — facing away (back view, you see its back and the back of its head)
  Row 2 — facing RIGHT (side profile, head on the right)

There is no left-facing row: the game mirrors row 2 horizontally at runtime.
Therefore row 2 must contain NO left/right-specific MARKING — no patch that
appears on only one flank, no asymmetric face marking, no text. Facing itself
is fine, because the whole animal flips together. It must read correctly when
mirrored.

Columns are animation frames. All 18 frames show the SAME animal with the same
markings and the same palette:
  Col 0 — walk, contact pose A
  Col 1 — walk, mid pose. ALSO the neutral standing frame the game falls back
          to. Draw it as a calm, upright, symmetrical animal standing still.
          This frame must look right in isolation.
  Col 2 — walk, contact pose B (legs opposite to col 0)
  Col 3 — resting pose A (STEP 5 says what resting looks like for this animal)
  Col 4 — resting pose B. Identical to col 3 except ONE small change, because
          cols 3-4 loop as a two-frame idle. Do not make it a different pose.
  Col 5 — idle. A single static frame, calm and neutral, the animal upright and
          alert. The game also shows this frame when the animal is drinking at
          a machine and when it stands beside a person, so it is by far the
          most-displayed frame in the sheet. Make it the most appealing one,
          and draw it STANDING, never resting.

Row 2 carries the real walk cycle — legs and tail clearly change across cols
0-2. Rows 0 and 1 barely move: a front or back view walking toward or away
from the camera differs only by a subtle weight shift or one limb forward.

STEP 3 — DETAIL BUDGET AT 16x16
This is a very small canvas. Be ruthless:
- The animal fills roughly 11-14 px wide and 12-15 px tall inside its 16x16
  frame. Centre it horizontally. The feet must rest ON the bottom edge of the
  frame (pixel row 15) — the game anchors the sprite bottom-centre. Nothing may
  extend outside the frame, tail and ears included.
- Each eye is ONE pixel.
- OMIT entirely: collars, harnesses, tags, individual toes, claws, fur or
  feather texture, ground shadow, highlights, reflections.
- Keep the silhouette readable first. If a marking does not survive at 1-2 px,
  drop it rather than smearing it.
- Reuse one palette across all 18 frames, sampled from the animal's real
  colouring. STEP 5 gives the colour budget.

STEP 4 — WHAT NOT TO PUT IN THE IMAGE
No background, no ground, no scenery, no frame borders, no grid lines, no
labels, no captions, no row or column numbers, no watermark, no signature, and
no extra rows or columns beyond the 6 x 3 grid.

DELIVERABLE
One 1536 x 768 transparent PNG (or exactly 96 x 48), containing 18 frames in
the 6 x 3 arrangement above, all of the same animal, in one consistent palette.
```

## STEP 5 — for a cat

```
STEP 5 — THE ANIMAL: A CAT

From the photos, extract only these identity traits: base coat colour, coat
pattern and where it sits on the body (tuxedo chest blaze, tabby stripes, white
paws, white muzzle), eye colour, and whether the fur is long or short. Ignore
the photos' lighting, background, pose, camera angle and depth of field. You
are not stylising a photo — you are drawing a new 16x16 character that reads as
this cat.

Resting (cols 3-4) is a cat sitting upright with its tail curled beside it, or
loafed down with the paws tucked under. The one small change between the two
frames: the tail tip moved one pixel, one ear flicked, or the eyes closed.

Idle (col 5) is the cat standing four-square, alert, tail up and visible.

Detail budget: the nose is ONE pixel or omitted. Use a 1 px outline in a darker
shade of the coat. Also omit whiskers. Palette: at most 10 colours plus
transparent.

Ears and tail are what say "cat" at this size — keep both as clear silhouette
shapes rather than colour changes inside the body.
```

## STEP 5 — for a dog

```
STEP 5 — THE ANIMAL: A DOG

From the photos, extract only these identity traits: coat colour and the
position of any patches, ear shape (floppy or pricked), snout length, tail
shape (curled, straight, or a stub), coat length, and overall build (stocky or
slender). Ignore the photos' lighting, background, pose, camera angle and depth
of field. You are not stylising a photo — you are drawing a new 16x16 character
that reads as this dog.

Resting (cols 3-4) is a dog sitting on its haunches with the front legs
straight, or lying down with its head up. The one small change between the two
frames: the tail moved one pixel, one ear flicked, or the eyes closed.

Idle (col 5) is the dog standing four-square, alert, tail up.

The walk frames are also used when the dog is moving fast — it chases cats in
this game — so cols 0-2 must read as a purposeful trot, not a stroll.

Detail budget: the nose is ONE pixel, darker than the muzzle. Use a 1 px
outline in a darker shade of the coat. Also omit the tongue, whiskers and any
harness. Palette: at most 8 colours plus transparent.

Ear shape and tail shape are what distinguish one dog from another at this
size — the body is barely more than a rectangle, so spend the pixels there.
```

## STEP 5 — for a duck

```
STEP 5 — THE ANIMAL: A DUCK

From the photos, extract only these identity traits: plumage colour, bill
colour, foot colour, any head or neck marking, and overall build (a compact
round duckling or a longer-bodied adult duck). Ignore the photos' lighting,
background, pose, camera angle and depth of field. You are not stylising a
photo — you are drawing a new 16x16 character that reads as this duck.

A duck has no front legs and no tail to speak of, so the walk (cols 0-2) is a
WADDLE: the body rocks from side to side by one pixel and the two feet
alternate. Rows 0 and 1 change even less than they would for a four-legged
animal — a one-pixel body tilt is enough.

Resting (cols 3-4) is the duck settled down onto its feet so the feet are
hidden, body low and round. The one small change between the two frames: the
eyes closed, the bill shifted one pixel, or one wing lifted.

Idle (col 5) is the duck standing upright on both feet, bill forward, alert.

Detail budget: the bill is 1-2 px of one flat colour and the feet are 1-2 px
each — these two features are the only things that say "duck", so protect them
before anything else. No outline is needed; the plumage colour reads fine
against transparency. Omit individual feathers, wing detail beyond a single
darker shade, webbing and nostrils. Palette: at most 6 colours plus
transparent.
```

## Notes on using it

- **Why 1536×768** and not 960×480: it is 16× on both axes and a power of two, so
  "every art pixel is a 16×16 block" is a rule the model can hold onto, and it is
  the property that makes recovery exact rather than a reconstruction. 96×48
  directly is better still if the tool will write it.
- **Send 3–4 photos of the same animal** — front, side, and one full body. The
  likeness comes from the references far more than from the wording.
- **Use a pixel-art or nearest-neighbour output mode if the tool has one.**
- **Expect to check, not to trust.** Current image generators rarely hold a pixel
  grid, and none reliably compose *at* 16×16 — which is exactly how failures 1 and
  2 above got into this repo. A near-miss is still recoverable; a sheet whose
  native grid does not divide by 6 is not.
- **Column 5 does five jobs**, which is why the prompt insists it be a standing
  pose: it is `idle`, `spawn`, `despawn`, `drink` (at a coffee station) and `talk`
  (beside an agent). A resting pose there makes the animal look asleep on its feet
  at a machine — `cat_1` has exactly that bug in its right-facing row.
- **The kind decides behaviour, not the sheet.** Dogs chase cats, cats flee dogs,
  ducks do neither; all three rest, drink and talk. None of that changes a frame,
  so a sheet for one kind is structurally a sheet for any of them.

## Verifying what comes back

Before a generated sheet is committed, confirm all five:

1. **The size is exact — 96×48.** A sheet LARGER than that decodes silently as the
   top-left crop, and how badly depends only on what happens to be up there: a
   1024×506 export gave nine empty frames plus fragments of one magnified ear, and a
   1774×887 one gave **18 empty frames**, because the top-left 96×48 of that sheet is
   nothing but transparent background. A SMALLER sheet throws instead, and the error
   is swallowed by `loadPetSprites`, which returns null for the whole load — one short
   cat sheet and the dogs and ducks disappear too.
2. **It really is 16×16 art.** Collect the alpha-edge positions and score how
   tightly they cluster on a candidate scale; the true grid scores far above every
   other candidate. The sheets that failed scored ~0.04 against 16×16 and ~0.80
   against their real ~26 px grid — an unmistakable gap, and not something the eye
   catches on a magnified image.
3. **Alpha is binary.** Every pixel 0 or 255. Partial alpha is kept, not cleaned up.
4. **No frame is clipped.** Per-cell bounding boxes of opaque pixels must sit
   inside 0–15 on both axes, with feet at or near row 15.
5. **It decodes, and the other kinds still do.** Run it through `loadPetSprites` and
   check all 3 directions × 6 frames have content — and that dogs, cats and ducks
   all still load. Then flip row 2 horizontally and look for a marking that changed
   sides.
