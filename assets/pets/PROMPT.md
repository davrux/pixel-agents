# Generating a pet sprite sheet from photos of a real animal

A ready-to-paste prompt for an image-generating AI, plus what to expect from it.
The format it targets is the one described in [README.md](README.md) — read that
first if you want to know *why* a column means what it means.

The prompt is written against four failures that have actually happened here, all
four of which produce a file that looks fine and imports badly:

1. **Anti-aliased output.** Smooth edges and partial alpha survive the import
   (alpha is per-pixel, not a mask), reach the renderer as translucent pixels and
   read as blur at 16×16.
2. **Art drawn larger than 16×16, then scaled down.** The worst one, because it is
   invisible until you measure it. A sheet whose native art was ~26×26 reduced to
   16×16 loses an eye off every front-facing face.
3. **Padding around the grid.** Two native pixels of margin made one sheet 158 px
   wide, which does not divide by 6, so no frame landed where the importer looked.
4. **A detail budget the format cannot hold.** A collar and a separate nose
   triangle need ~24 px of head. At 16 px they smear into the muzzle.

## The prompt

```
You are producing a pixel-art sprite sheet for a 2D top-down game, from
reference photos of one specific real cat that I provide.

STEP 1 — READ THE CAT FROM THE PHOTOS
From the photos, extract only these identity traits and carry them into the
sprite: base coat colour, coat pattern and where it sits on the body (e.g.
tuxedo chest blaze, tabby stripes, white paws, white muzzle), eye colour, and
whether the fur is long or short. Ignore the photos' lighting, background,
pose, camera angle and depth of field. You are not stylising a photo — you are
drawing a new 16x16 character that reads as this cat.

STEP 2 — THE FORMAT (non-negotiable)
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

STEP 3 — THE GRID
The 96 x 48 sheet is 6 columns x 3 rows of 16 x 16 frames, edge to edge, with
NO margin, NO padding, NO gutters and NO separator lines. Frame (col, row)
occupies exactly the 16x16 rect at (col*16, row*16).

Rows are the direction the cat faces:
  Row 0 — facing the camera (front view, you see the face)
  Row 1 — facing away (back view, you see the cat's back and the back of its head)
  Row 2 — facing RIGHT (side profile, head on the right, tail on the left)

There is no left-facing row: the game mirrors row 2 horizontally at runtime.
Therefore row 2 must contain NO left/right-specific marking — no patch that
appears on only one flank, no asymmetric face marking. It must read correctly
when flipped.

Columns are animation frames:
  Col 0 — walk, contact pose A
  Col 1 — walk, mid pose. ALSO the neutral standing frame the game falls back
          to. Draw it as a calm, upright, symmetrical cat standing still. This
          frame must look right in isolation.
  Col 2 — walk, contact pose B (legs opposite to col 0)
  Col 3 — resting/sitting pose A
  Col 4 — resting/sitting pose B. Identical to col 3 except ONE small change
          (tail tip moved, one ear flicked, or eyes closed), because cols 3-4
          loop as a two-frame idle. Do not make it a different pose.
  Col 5 — idle. A single static frame, calm and neutral, cat upright and alert.
          This is the most-displayed frame in the game, so make it the most
          appealing one.

Row 2 carries the real walk cycle — legs and tail clearly change across cols
0-2. Rows 0 and 1 barely move: a front or back view walking toward or away from
the camera differs only by a subtle weight shift or one paw forward.

STEP 4 — DETAIL BUDGET AT 16x16
This is a very small canvas. Be ruthless:
- The cat fills roughly 11-14 px wide and 13-14 px tall inside its 16x16 frame.
- Centre it horizontally. The feet must rest ON the bottom edge of the frame
  (pixel row 15) — the game anchors the sprite bottom-centre. Nothing may
  extend outside the frame, tail and ears included.
- Each eye is ONE pixel. The nose is ONE pixel, or omitted.
- Use a 1 px outline in a darker shade of the coat.
- OMIT entirely: collars, harnesses, tags, whiskers, individual toes,
  fur texture, claws, ground shadow, highlights, reflections.
- Total palette: at most 10 colours plus transparent, all sampled from the
  cat's real colouring. Reuse the same palette across all 18 frames.
- Keep the silhouette readable first. If a marking does not survive at 1-2 px,
  drop it rather than smearing it.

STEP 5 — WHAT NOT TO PUT IN THE IMAGE
No background, no ground, no scenery, no frame borders, no grid lines, no
labels, no captions, no row or column numbers, no watermark, no signature, and
no extra rows or columns beyond the 6 x 3 grid.

DELIVERABLE
One 1536 x 768 transparent PNG (or exactly 96 x 48), containing 18 frames in
the 6 x 3 arrangement above, all of the same cat, in one consistent palette.
```

Swap "cat" for "dog" or "duck" throughout for the other kinds; nothing else
changes, since all three share the sheet format.

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

## Verifying what comes back

Before a generated sheet is committed, confirm all four:

1. **It really is 16×16 art.** Collect the alpha-edge positions and score how
   tightly they cluster on a candidate scale; the true grid scores far above every
   other candidate. The sheets that failed scored ~0.04 against 16×16 and ~0.80
   against their real ~26 px grid — an unmistakable gap, and not something the eye
   catches on a magnified image.
2. **No frame is clipped.** Per-cell bounding boxes of opaque pixels must sit
   inside 0–15 on both axes, with feet at or near row 15.
3. **It decodes.** Run it through `loadPetSprites` and check all 3 directions × 6
   frames are 16×16 with content. Note that a sheet LARGER than 96×48 decodes
   silently as the top-left crop, so a clean decode alone proves nothing about size.
4. **Row 2 mirrors.** Flip it horizontally and look for a marking that changed
   sides.
