/**
 * Matrix chat panel: the one injected stylesheet for every pixel it draws.
 *
 * This mirrors the `MumbleUI.injectStyles()` / zone-chat `pa-chat-style` pattern
 * (one idempotent `<style>` tag, appended once, never removed) rather than pulling
 * in a bundler CSS import — the panel lives inside a lazily-imported chunk and must
 * not add anything to the eagerly-loaded main bundle. Every selector is scoped under
 * `#pa-mx`, `#pa-matrix-panel` or `#pa-matrix-btn` so this file can never leak a rule
 * onto chrome it does not own (that belongs to `client/src/ui/paSkin.ts`).
 *
 * All colours/borders/bevels below are the app's one pixel-menu look, copied from
 * the token table AGENTS.md and the design doc point to — do not invent new ones.
 */

/** Fixed accent set for avatar tints — the same eight hues already used elsewhere
 *  in the chrome. A new palette here would make the panel visibly not-our-app. */
export const MX_AVATAR_TINTS: readonly string[] = [
  '#c51a1b',
  '#7c2634',
  '#a86a2e',
  '#5aa348',
  '#4998c0',
  '#e7da00',
  '#37342f',
  '#818586',
];

/** Stable, non-cryptographic FNV-1a hash over `seed`'s code points, folded into
 *  the fixed tint set — the same MXID always paints the same colour, with no
 *  server round-trip and no new palette. */
export function avatarTint(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const idx = (h >>> 0) % MX_AVATAR_TINTS.length;
  return MX_AVATAR_TINTS[idx]!;
}

/** Initials for an avatar / a `title` fallback: strips a leading sigil (`@`/`#`/`!`),
 *  takes the first alphanumeric of up to two whitespace-separated words, uppercased,
 *  capped at two characters, `'?'` when there is nothing usable. */
export function initialsOf(label: string): string {
  const stripped = label.replace(/^[@#!]/, '').trim();
  if (!stripped) return '?';
  const words = stripped.split(/\s+/).filter(Boolean).slice(0, 2);
  let out = '';
  for (const w of words) {
    const m = w.match(/[A-Za-z0-9]/);
    if (m) out += m[0];
  }
  if (!out) {
    const m = stripped.match(/[A-Za-z0-9]/);
    out = m ? m[0] : '?';
  }
  return out.slice(0, 2).toUpperCase();
}

/** How a caller supplies a real profile picture to `mkAvatar`. `load` is the
 *  store's cached mxc -> blob: URL resolver; the square is built and returned
 *  synchronously either way, and the picture (if any) fades in when it
 *  arrives. */
export interface MxAvatarPicture {
  mxc: string | null;
  load(mxc: string, sizePx: number): Promise<string>;
}

/** CSS box is 2.1rem; ask for a bit more than that so the square stays sharp
 *  on a HiDPI screen without fetching a different size per device. */
const AVATAR_FETCH_PX = 64;

/** Builds one `.mx-av` square: initials over a per-identity tint, plus the
 *  real profile picture when there is one. `label` is remote (a display name or
 *  an MXID) so it is only ever assigned via `textContent`/`title` property
 *  assignment — never interpolated into markup.
 *
 *  The initials are always built, never replaced: the picture is layered over
 *  them, so a slow, missing, or non-image avatar degrades to exactly what this
 *  function returned before profile pictures existed. */
export function mkAvatar(seed: string, label: string, picture?: MxAvatarPicture): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'mx-av';
  el.title = label;
  el.style.boxShadow = 'inset 0 0 0 2px ' + avatarTint(seed);
  el.setAttribute('aria-hidden', 'true');

  const initials = document.createElement('span');
  initials.className = 'mx-av-i';
  initials.textContent = initialsOf(label);
  el.appendChild(initials);

  const mxc = picture?.mxc;
  if (picture && mxc) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    picture
      .load(mxc, AVATAR_FETCH_PX)
      .then((url) => {
        // Painted unconditionally, with no "is this element still in the
        // document" guard: rows are rebuilt constantly, and a cached avatar
        // resolves in a microtask that can run before the caller has finished
        // appending its row. Skipping those would leave permanently blank
        // squares for exactly the avatars that were already loaded.
        img.src = url;
        el.appendChild(img);
        el.classList.add('has-img');
      })
      .catch(() => {
        /* keep the initials — an unreachable or non-image avatar is not an error the reader can act on */
      });
  }
  return el;
}

/** Injects the panel's stylesheet exactly once per document. Safe to call from
 *  every entry point that might open the panel first. */
export function injectMatrixSkin(): void {
  if (document.getElementById('pa-mx-style')) return;
  const style = document.createElement('style');
  style.id = 'pa-mx-style';
  style.textContent = `
/* The panel is a docked application window (ui/dockWindow.ts owns its column:
   full height, width, the resize grip, and — through its fill option — a body
   that is a flex column and never scrolls as a whole, so every view inside can
   manage its own scroller and the composer and top strip stay put). All this
   adds is that the body carries no gutter of its own: those pinned strips have
   to reach the panel's edges, so each view pads itself instead. */
#pa-matrix-panel .pa-body{padding:0}

#pa-mx{display:flex;flex-direction:column;flex:1;min-height:0;position:relative;font-family:'FS Pixel Sans',ui-monospace,monospace}

/* Every view is a plain <section data-view="…">; without this it is a flex
   *item* of #pa-mx, not a flex *container* itself, and every flex:1/flex:0 0
   auto declared on its children (the two scrollers, the composer, the rooms
   footer) is inert. The room view's own children already carry their own
   padding (subhead/timeline/composer), so it gets zero — every other view
   gets the panel's usual ~0.7rem gutter. */
#pa-mx > section{display:flex;flex-direction:column;flex:1;min-height:0;gap:0.5rem}
/* room + encryption both pin a subhead above their own scroller, so the section
   itself must not pad or scroll — see .mx-encbody below. */
#pa-mx > section[data-view="room"],#pa-mx > section[data-view="encryption"]{padding:0;gap:0}
#pa-mx > section:not([data-view="room"]):not([data-view="encryption"]){padding:0.6rem 0.7rem 0.8rem}
/* Every other view (encryption, members, …) stacks more content than the window's height can show
   at once — without its own scroller here, the body's overflow:hidden above (which outranks the
   docked window's own overflow-y:auto, ui/dockWindow.ts) simply clips everything past the fold
   with no scrollbar: unreachable, not just unseen. */
#pa-mx > section:not([data-view="room"]):not([data-view="encryption"]){overflow-y:auto;overscroll-behavior:contain}
/* The encryption view stacks the most content of any view; scrolling it inside the section (rather
   than scrolling the section) is what keeps its ◀ reachable from the bottom of the device list. */
.mx-encbody{
  display:flex;flex-direction:column;gap:0.5rem;flex:1;min-height:0;
  overflow-y:auto;overscroll-behavior:contain;padding:0.6rem 0.7rem 0.8rem;
}

#pa-mx .pa-input,#pa-mx .mx-input{width:100%}
#pa-mx .pa-seg,#pa-mx .mx-filter{flex:0 0 auto}

#pa-mx-top{
  display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.6rem;overflow:hidden;
  background:#242220;border:2px solid #0a0908;border-radius:0.45rem;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
  margin:0.5rem 0.6rem;
}
#pa-mx-top button{flex:0 0 auto}
.mx-me{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-dot{width:0.55rem;height:0.55rem;border-radius:50%;background:#525556;flex:0 0 auto;display:inline-block}
.mx-dot.live{background:#5aa348;box-shadow:0 0 4px 1px #5aa348}
.mx-dot.warn{background:#a86a2e}
.mx-dot.off{background:#7c2634}

.mx-av{
  width:2.1rem;height:2.1rem;flex:0 0 auto;position:relative;overflow:hidden;
  background:#141312;border:2px solid #0a0908;border-radius:0.35rem;
  color:#f1efec;display:flex;align-items:center;justify-content:center;
  font-size:0.8rem;font-weight:600;user-select:none;
}
/* The picture is layered over the initials rather than replacing them, so a
   transparent PNG still reads and a failed load needs no cleanup. */
.mx-av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.mx-av.has-img .mx-av-i{visibility:hidden}
/* A slot is an in-place holder for one square (the room header, the status
   strip) — see paintAvatarSlot; list rows build theirs inline instead. */
.mx-av-slot{display:inline-flex;flex:0 0 auto}
/* The strip is a single short line, so its own square rides smaller. It is
   also a button (click to change your picture), so the button chrome has to be
   stripped back to just the square. */
.mx-me-av{padding:0;margin:0;border:0;background:none;cursor:pointer}
.mx-me-av:disabled{cursor:progress;opacity:.6}
.mx-me-av:focus-visible{outline:2px solid #4998c0;outline-offset:2px}
.mx-me-av .mx-av{width:1.5rem;height:1.5rem;border-width:2px;font-size:0.6rem;border-radius:0.3rem}
.mx-subhead .mx-av{width:1.7rem;height:1.7rem;font-size:0.7rem}

.mx-room.unread .nm{color:#f5f3f0;font-weight:600}
.mx-room.here .nm{color:#e7da00}
.mx-room-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:0.1rem;overflow:hidden}
#pa-mx .pa-list-row small{flex:0 0 auto;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-badge{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:1.2rem;height:1.2rem;padding:0 0.3rem;border-radius:0.6rem;
  background:#37342f;color:#adb0b2;font-size:0.7rem;line-height:1;
}
.mx-badge.hl{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a, inset 0 -3px 0 #5c0f10}

.mx-prev{
  color:#818586;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:'FS Pixel Sans',ui-monospace,monospace;
}

.mx-subhead{
  display:flex;align-items:center;gap:0.5rem;
  border-bottom:2px solid #0a0908;box-shadow:inset 0 -1px 0 #2c2a28;padding:0.5rem 0.6rem;
}
.mx-subhead button,.mx-subhead > span{flex:0 0 auto}
.mx-room-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

#pa-mx-list,#pa-mx-tl{overflow-y:auto;overscroll-behavior:contain;flex:1;min-height:0}
#pa-mx-tl,#pa-mx-tl .mx-day,#pa-mx-tl .mx-grp{overflow-anchor:none}
#pa-mx-tl{padding:0.5rem 0.6rem;display:flex;flex-direction:column;gap:0.55rem}

.mx-day{
  color:#818586;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;
  text-align:center;display:flex;align-items:center;gap:0.5rem;
}
.mx-day::before,.mx-day::after{content:'';flex:1;border-top:1px solid #2c2a28}

.mx-grp{display:flex;flex-direction:column;gap:0.15rem}
.mx-grp-head{display:flex;align-items:baseline;gap:0.5rem;margin-bottom:0.15rem}
.mx-grp-head .nm{
  color:#f0eeea;font-weight:600;
  font-family:'FS Pixel Sans',ui-monospace,monospace;
}
.mx-grp-head .mx-time{color:#818586;font-size:0.78rem}

/* position:relative anchors the floating ⋯ button below. */
.mx-msg{padding-left:0;position:relative}
.mx-msg .mx-txt{
  color:#f1efec;font-size:0.95rem;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;
  font-family:'FS Pixel Sans',ui-monospace,monospace;
}
.mx-msg.pending{opacity:.55}
.mx-msg.failed{color:#f6cdd4;border-left:3px solid #7c2634;padding-left:0.5rem}
.mx-msg.deleted .mx-txt{color:#818586;font-style:italic}
.mx-msg.notice .mx-txt,.mx-msg.emote .mx-txt{color:#adb0b2}
.mx-retry{color:#4998c0;cursor:pointer;font-size:0.8rem;margin-left:0.4rem;text-decoration:underline}

/* ---- message actions (timeline.ts buildMsgRow) ------------------------------
   The ⋯ button floats over the row's top-right corner, Element-style: a 26rem
   column has no width to spare for a permanent gutter. Hidden by opacity rather
   than display so it keeps its place in the tab order — pointer-events:none is
   what stops the invisible button from swallowing clicks meant for the text
   under it, and :focus-within reveals it for anyone arriving by keyboard. */
.mx-actions{position:absolute;top:-0.2rem;right:0;opacity:0;pointer-events:none;transition:opacity .08s linear}
.mx-actions[hidden]{display:none}
.mx-msg:hover .mx-actions,.mx-msg:focus-within .mx-actions,.mx-msg.mx-menu-open .mx-actions{
  opacity:1;pointer-events:auto;
}
.mx-msg-menu{
  padding:0 0.35rem;line-height:1.15;font-size:0.95rem;font-family:inherit;cursor:pointer;
  color:#adb0b2;background:#242220;border:2px solid #0a0908;border-radius:0.35rem;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
.mx-msg-menu:hover{color:#f1efec}
.mx-msg-menu:focus-visible{outline:2px solid #4998c0;outline-offset:1px}

/* An edit marker, inline at the end of the message it belongs to. */
.mx-edited{color:#818586;font-size:0.72rem;margin-left:0.35rem;white-space:nowrap}

/* The quoted message above a reply. Two lines at most: who, and a one-line
   preview — the full message is one click away (it scrolls to it). The stacking
   lives on .mx-quote-in, not on the <button>; see buildMsgRow for why. */
.mx-quote{
  display:block;width:100%;text-align:left;margin-bottom:0.2rem;
  padding:0.15rem 0 0.15rem 0.45rem;border:0;border-left:3px solid #4a4744;border-radius:0;
  background:none;box-shadow:none;cursor:pointer;font-family:inherit;overflow:hidden;
}
.mx-quote[hidden]{display:none}
.mx-quote-in{display:flex;flex-direction:column;gap:0.05rem;min-width:0;overflow:hidden}
.mx-quote .who{color:#adb0b2;font-size:0.78rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-quote .what{color:#818586;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-quote:hover{border-left-color:#4998c0}
.mx-quote:hover .what{color:#adb0b2}
.mx-quote.missing{cursor:default}
.mx-quote.missing .what{font-style:italic}
.mx-quote:focus-visible{outline:2px solid #4998c0;outline-offset:1px}

/* Where a reply lands after jumping to it from a quote. Deliberately brief and
   colour-only: the row must not change size, or the jump would move the very
   thing it just scrolled to. */
.mx-msg.mx-flash{animation:mx-flash 1.1s ease-out}
@keyframes mx-flash{
  0%{background:rgba(231,218,0,.22)}
  100%{background:transparent}
}

/* Reaction chips. Same chip tokens as .mx-chip, sized down: a row of them has
   to fit under a message in a narrow column, and wrap when it doesn't. */
.mx-reacts{display:flex;flex-wrap:wrap;gap:0.25rem;margin-top:0.25rem}
.mx-reacts[hidden]{display:none}
.mx-react{
  display:inline-flex;align-items:center;cursor:pointer;
  padding:0.05rem 0.35rem;border-radius:0.6rem;border:2px solid #0a0908;
  background:#37342f;color:#adb0b2;font:0.78rem/1.5 'FS Pixel Sans',ui-monospace,monospace;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
.mx-react .k{font-size:0.85rem}
/* A margin rather than the flex gap property, so the emoji and its count stay
   apart even if a browser declines to make this <button> a flex container. */
.mx-react .n{margin-left:0.25rem}
.mx-react:hover{color:#f1efec}
/* Mine reads "active", which in this palette is the primary red — the same
   meaning it carries on a toggled button elsewhere in the app. */
.mx-react.mine{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a, inset 0 -3px 0 #5c0f10}
.mx-react.pending{opacity:.6;cursor:progress}
.mx-react:focus-visible{outline:2px solid #4998c0;outline-offset:1px}

/* Delivery gutter (timeline.ts setStatus): a check on your newest confirmed
   message, replaced by the pictures of whoever has read up to that message.
   Right-aligned under the row rather than in a column of its own — Element can
   afford a dedicated gutter, a 26rem panel cannot. */
.mx-status{display:flex;justify-content:flex-end;align-items:center;gap:0.15rem;margin-top:0.1rem}
.mx-status[hidden]{display:none}
/* The green of the live/connected dot, so "it got there" reads the same here as
   it does in the status strip. */
.mx-status-check{color:#7fbf6a;font-size:0.8rem;line-height:1}
/* Small enough that three fit beside each other at the compact width, and with
   the border dropped to a ring so they don't read as list rows. */
.mx-status .mx-av{width:1.05rem;height:1.05rem;font-size:0.5rem;border-width:2px;border-radius:0.25rem}
.mx-status-more{color:#818586;font-size:0.7rem;line-height:1;margin-left:0.1rem}

/* ---- formatted (org.matrix.custom.html) bodies ------------------------------
   The panel is ~26rem wide, so the rule that matters here is that nothing may
   widen the column: a long code line scrolls inside its own <pre>, and the
   timeline itself never gains a horizontal scrollbar. */
.mx-rich{white-space:normal}
.mx-rich > :first-child{margin-top:0}
.mx-rich > :last-child{margin-bottom:0}
.mx-rich p{margin:0 0 0.4rem}
.mx-rich h1,.mx-rich h2,.mx-rich h3,.mx-rich h4,.mx-rich h5,.mx-rich h6{
  margin:0.5rem 0 0.3rem;font-size:1rem;color:#f5f3f0;font-weight:600;
}
.mx-rich h1{font-size:1.15rem}
.mx-rich h2{font-size:1.08rem}
.mx-rich ul,.mx-rich ol{margin:0.2rem 0 0.4rem;padding-left:1.3rem}
.mx-rich li{margin:0.1rem 0}
.mx-rich blockquote{
  margin:0.3rem 0;padding:0.2rem 0 0.2rem 0.6rem;
  border-left:3px solid #4a4744;color:#adb0b2;
}
.mx-rich hr{border:0;border-top:2px solid #0a0908;margin:0.5rem 0}
.mx-rich a{color:#4998c0}
.mx-rich del{color:#818586}
/* Inline code: an inset chip, breakable so a long identifier can't push the
   column wider. */
.mx-rich code{
  background:#141312;border:2px solid #0a0908;border-radius:0.25rem;
  padding:0 0.2rem;font-family:ui-monospace,'FS Pixel Sans',monospace;font-size:0.88em;
  overflow-wrap:anywhere;
}
/* Block code: the one place text must NOT wrap — a wrapped snippet is a
   misleading snippet — so it scrolls sideways in its own well instead. */
.mx-rich pre{
  margin:0.35rem 0;padding:0.45rem 0.55rem;
  background:#141312;border:2px solid #0a0908;border-radius:0.35rem;
  box-shadow:inset 0 2px 0 #2c2a28, inset 0 -3px 0 #050505;
  overflow-x:auto;overscroll-behavior-x:contain;max-width:100%;
}
.mx-rich pre code{
  display:block;background:none;border:0;border-radius:0;padding:0;
  white-space:pre;overflow-wrap:normal;font-size:0.85rem;line-height:1.45;color:#f1efec;
}
/* The copy-button wrapper timeline.ts puts around every <pre>: it takes over
   the pre's own block margin so the wrapped block sits exactly where a bare
   one did, and it is the positioning context for the button. */
.mx-codewrap{position:relative;margin:0.35rem 0}
.mx-codewrap pre{margin:0}
/* Hidden by opacity, not display, for the same reason as .mx-actions: the
   button keeps its place in the tab order, and :focus-within reveals it for
   anyone arriving by keyboard. user-select:none keeps its glyph out of a
   drag-select across the snippet. */
.mx-codecopy{
  position:absolute;top:0.25rem;right:0.25rem;opacity:0;pointer-events:none;
  transition:opacity .08s linear;user-select:none;
  padding:0 0.3rem;line-height:1.2;font-size:0.85rem;font-family:inherit;cursor:pointer;
  color:#adb0b2;background:#242220;border:2px solid #0a0908;border-radius:0.35rem;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
.mx-codewrap:hover .mx-codecopy,.mx-codewrap:focus-within .mx-codecopy{opacity:1;pointer-events:auto}
/* A code block that *opens* the message has its top-right corner directly
   under the row's floating ⋯ button (worst on a one-line block, where the two
   fully cover each other) — step that block's copy button left of the ⋯.
   Blocks further down the message keep the corner position. */
.mx-txt > .mx-codewrap:first-child .mx-codecopy{right:2rem}
.mx-codecopy:hover{color:#f1efec}
.mx-codecopy:focus-visible{outline:2px solid #4998c0;outline-offset:1px}
.mx-codecopy.ok{color:#7fbf6a}
.mx-codecopy.failed{color:#f6cdd4}
/* Tables are rare in chat but must not be the thing that breaks the column. */
.mx-rich table{display:block;overflow-x:auto;max-width:100%;border-collapse:collapse;margin:0.35rem 0}
.mx-rich th,.mx-rich td{border:2px solid #0a0908;padding:0.15rem 0.35rem;text-align:left}
.mx-rich th{background:#262422}
.mx-rich details{margin:0.3rem 0}
.mx-rich summary{cursor:pointer;color:#adb0b2}
/* An inline emote/sticker this client doesn't render as a picture, shown as its
   alt text so an emote-only message is never a blank bubble. */
.mx-inline-img{color:#818586}
.mx-rich-cut{color:#a86a2e;font-size:0.8rem;margin-top:0.2rem}

/* A picture row. The button is sized from the event's own w/h (an
   aspect-ratio set inline by timeline.ts) *before* the bytes arrive, so the
   timeline doesn't lurch when one pops in; the deep-inset well is what the
   reader sees in the meantime. */
.mx-img{
  display:block;width:100%;max-width:18rem;max-height:16rem;margin-top:0.3rem;padding:0;
  background:#141312;border:2px solid #0a0908;border-radius:0.45rem;overflow:hidden;cursor:zoom-in;
  box-shadow:inset 0 2px 0 #2c2a28, inset 0 -3px 0 #050505;
}
/* An author display rule beats the UA sheet's [hidden]{display:none}, so
   without this a non-picture row would show an empty well. */
.mx-img[hidden]{display:none}
/* No image-rendering:pixelated: with the box capped at the picture's own
   width (timeline.ts sets max-width from info.w) nothing is ever upscaled, so
   the only effect left would be nearest-neighbour *downscaling* — which is
   exactly what makes a shared photo look crunchy. */
.mx-img img{display:block;width:100%;height:100%;object-fit:contain}
.mx-img.loading{cursor:progress;animation:mx-img-pulse 1.4s ease-in-out infinite}
.mx-img.failed{cursor:pointer;border-color:#7c2634}
@keyframes mx-img-pulse{0%,100%{opacity:.55}50%{opacity:.85}}
.mx-msg.mx-has-img .mx-txt{font-size:0.8rem;color:#818586}

/* Full-size viewer (MatrixUI.openImageViewer). Deliberately not a .pa-panel:
   it is a picture with a toolbar, not a form, and the panel's fixed 22rem
   would shrink-wrap every screenshot to thumbnail size. */
.mx-lightbox{
  position:fixed;inset:0;margin:auto;padding:0.6rem;border:2px solid #0a0908;border-radius:0.6rem;
  background:#1c1a19;color:#f1efec;max-width:min(94vw,80rem);max-height:92vh;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
.mx-lightbox::backdrop{background:rgba(0,0,0,.72)}
.mx-lightbox img{display:block;max-width:100%;max-height:calc(92vh - 4rem);margin:0 auto}
.mx-lightbox-bar{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem}
.mx-lightbox-bar .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.85rem}
.mx-lightbox-bar .pa-b{text-decoration:none}

/* A file row (timeline.ts's file path): a name, a size and a download. Sized
   like .mx-img so a timeline of both doesn't look like two different clients,
   but a raised control rather than an inset well — there is nothing to preview
   in it, it is a thing you press. */
.mx-file{
  display:flex;align-items:center;gap:0.5rem;width:100%;max-width:18rem;margin-top:0.3rem;
  padding:0.4rem 0.5rem;text-align:left;cursor:pointer;
  background:#242220;border:2px solid #0a0908;border-radius:0.45rem;color:#f1efec;
  font:0.85rem 'FS Pixel Sans',ui-monospace,monospace;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
/* Same reason as .mx-img[hidden] — an author display rule beats the UA sheet. */
.mx-file[hidden]{display:none}
.mx-file .i{flex:0 0 auto;font-size:1rem;line-height:1}
.mx-file-main{display:flex;flex-direction:column;flex:1;min-width:0}
/* Both lines clamp: a filename is remote text and may be 120 characters, and
   the panel column must never widen. */
.mx-file .nm,.mx-file .sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-file .sub{color:#818586;font-size:0.75rem}
.mx-file.loading{cursor:progress}
.mx-file.failed{border-color:#7c2634}
.mx-file.failed .sub{color:#f6cdd4}

/* The "send this file?" gate (MatrixUI.confirmAttachment). A native <dialog>
   wrapping a .pa-panel, so it needs the same position/display reset that
   ui/paDialog.ts applies to the panel it puts in one. */
.mx-confirm{
  position:fixed;inset:0;margin:auto;padding:0;border:0;background:transparent;color:inherit;
  max-width:calc(100vw - 2rem);max-height:calc(100vh - 2rem);
}
.mx-confirm::backdrop{background:rgba(0,0,0,.55)}
.mx-confirm .pa-panel{position:static;display:block;width:22rem}
.mx-confirm .pa-foot{display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.8rem}
.mx-confirm-row{display:flex;gap:0.7rem;align-items:flex-start}
/* A fixed square: the preview is there to confirm *which* picture, so a tall
   screenshot and a wide one should both land in the same box. */
.mx-confirm-prev{
  flex:0 0 auto;width:5.5rem;height:5.5rem;display:flex;align-items:center;justify-content:center;
  background:#141312;border:2px solid #0a0908;border-radius:0.45rem;overflow:hidden;
  box-shadow:inset 0 2px 0 #2c2a28, inset 0 -3px 0 #050505;
}
.mx-confirm-prev.generic{font-size:2rem}
.mx-confirm-prev img{display:block;max-width:100%;max-height:100%;object-fit:contain}
.mx-confirm-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:0.15rem}
.mx-confirm-meta .nm{overflow-wrap:anywhere;font-size:0.95rem}
.mx-confirm-meta .sub{color:#818586;font-size:0.78rem;overflow-wrap:anywhere}
.mx-confirm-meta .sub.warn{color:#a86a2e}

/* An undecryptable ("Unable to Decrypt") row: still-arriving or genuinely
   unreadable, but never blank and never the SDK's raw error string (design
   doc §4.3/§4.7). .working (mid-decryption) reads subtler than a settled
   failure, since it usually resolves itself within a second. */
.mx-utd{color:#818586;opacity:.75}
.mx-utd.working{opacity:.55}
.mx-utd .act{color:#4998c0;cursor:pointer;text-decoration:underline;font-size:0.8rem;margin-left:0.4rem}

.mx-notice{
  background:#262422;border:2px solid #0a0908;color:#adb0b2;border-radius:0.45rem;
  padding:0.5rem 0.6rem;font-size:0.85rem;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
.mx-err{
  color:#f6cdd4;background:#7c2634;border:2px solid #0a0908;border-radius:0.45rem;padding:0.4rem 0.6rem;
  box-shadow:inset 0 2px 0 #b34a5a, inset 0 -3px 0 #45111a;font-size:0.85rem;
}
.mx-more{color:#818586;text-align:center;font-size:0.8rem;padding:0.3rem 0;cursor:pointer;flex:0 0 auto}
.mx-more[aria-disabled="true"]{cursor:default}

.mx-composer{
  /* wrap so the full-width status rows below (.muted, .mx-upload) actually
     get their own line instead of being squeezed in beside the send button */
  display:flex;flex-wrap:wrap;align-items:flex-end;gap:0.5rem;
  border-top:2px solid #0a0908;background:#1c1a19;padding:0.5rem 0.6rem;flex:0 0 auto;
}
.mx-input{resize:none;line-height:1.5;max-height:7.5rem;flex:1;min-width:0}
/* The 😊/📎/➤ column beside the input. Bottom-aligned with it (the container's
   own align-items:flex-end), equal-width so the stack reads as one control. */
.mx-composer-btns{display:flex;flex-direction:column;gap:0.3rem;flex:0 0 auto}
.mx-composer-btns .pa-b{width:100%}
.mx-composer .muted{flex-basis:100%}
/* Upload progress / failure. Full-width row under the composer controls —
   a picture send has no local echo to fail into until the bytes are up. */
.mx-upload{flex-basis:100%;font-size:0.8rem;color:#adb0b2}
.mx-upload.err{color:#f6cdd4}
/* Drop target feedback, on the whole room view (see buildRoomView). */
#pa-mx > section[data-view="room"].mx-dropping{outline:2px dashed #7fbf6a;outline-offset:-4px}

.mx-link{color:#4998c0;cursor:pointer}

#pa-mx .pa-b.on{background:#c51a1b;color:#fff;box-shadow:inset 0 2px 0 #e2585a, inset 0 -3px 0 #5c0f10}

.mx-rooms-foot{display:flex;flex-direction:column;gap:0.5rem;flex:0 0 auto;padding-top:0.3rem}
.mx-rooms-foot-row{display:flex;gap:0.5rem}
.mx-rooms-foot-row .pa-b{flex:1}

/* ---- message options menu (messageMenu.ts) ----------------------------------
   A panel-shaped popover, positioned by script inside #pa-mx. Panel tokens
   (the deeper bevel + drop shadow), because that is what every other floating
   surface in the app uses. */
.mx-menu{
  position:absolute;z-index:6;min-width:9.5rem;max-width:calc(100% - 0.75rem);
  display:flex;flex-direction:column;gap:0.25rem;padding:0.35rem;
  background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;
  box-shadow:inset 0 2px 0 #292725, inset 0 -3px 0 #030303, 0 12px 28px rgba(0,0,0,.55);
}
.mx-menu-emoji{display:flex;flex-wrap:wrap;gap:0.15rem;margin-bottom:0.15rem}
.mx-menu-e{
  padding:0.15rem 0.25rem;min-width:1.6rem;cursor:pointer;font:1rem/1.3 'FS Pixel Sans',ui-monospace,monospace;
  color:#f1efec;background:#262422;border:2px solid #0a0908;border-radius:0.35rem;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
.mx-menu-e.other{color:#adb0b2}
.mx-menu-e:hover{background:#37342f}
.mx-menu-e:focus-visible,.mx-menu-row:focus-visible{outline:2px solid #4998c0;outline-offset:1px}
.mx-menu-row{
  display:flex;align-items:center;gap:0.45rem;padding:0.4rem 0.5rem;cursor:pointer;text-align:left;
  color:#f1efec;background:#242220;border:2px solid #0a0908;border-radius:0.45rem;
  font:0.9rem/1.3 'FS Pixel Sans',ui-monospace,monospace;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
.mx-menu-row:hover{background:#37342f}
.mx-menu-row.danger{background:#7c2634;color:#f1d0d6;box-shadow:inset 0 2px 0 #b34a5a, inset 0 -3px 0 #45111a}

/* ---- emoji picker (emojiPicker.ts) -------------------------------------------
   Same panel-shaped popover as .mx-menu, sized for a grid: 8 columns
   (emojiPicker.ts's COLS must match) and its own scrolling body, so the
   popover itself never outgrows the panel. */
.mx-emoji{
  position:absolute;z-index:6;width:min(19rem,calc(100% - 0.75rem));
  display:flex;flex-direction:column;gap:0.35rem;padding:0.4rem;
  background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;
  box-shadow:inset 0 2px 0 #292725, inset 0 -3px 0 #030303, 0 12px 28px rgba(0,0,0,.55);
}
#pa-mx .mx-emoji-q{width:100%;font-size:0.85rem}
.mx-emoji-body{max-height:13rem;overflow-y:auto;overscroll-behavior:contain}
.mx-emoji-h{color:#818586;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;margin:0.35rem 0 0.15rem}
.mx-emoji-h:first-child{margin-top:0}
.mx-emoji-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:0.15rem}
.mx-emoji-b{
  padding:0.15rem 0;cursor:pointer;font:1.05rem/1.3 'FS Pixel Sans',ui-monospace,monospace;
  color:#f1efec;background:none;border:2px solid transparent;border-radius:0.35rem;
  overflow:hidden;
}
.mx-emoji-b:hover{background:#37342f;border-color:#0a0908}
.mx-emoji-b:focus-visible{outline:2px solid #4998c0;outline-offset:1px}
.mx-emoji-none{color:#818586;font-size:0.8rem;padding:0.3rem 0.1rem}

/* ---- composer context bar (MatrixUI: replying to / editing) -----------------
   Its own line above the composer controls (which is why it takes the full
   basis of the wrapping flex row), shaped like the inset controls beside it. */
.mx-ctx{
  flex-basis:100%;display:flex;align-items:center;gap:0.45rem;min-width:0;
  padding:0.3rem 0.45rem;border:2px solid #0a0908;border-radius:0.45rem;background:#262422;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
.mx-ctx[hidden]{display:none}
.mx-ctx .mx-ctx-i{flex:0 0 auto;color:#4998c0}
.mx-ctx-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:0.05rem;overflow:hidden}
.mx-ctx-main .who{color:#adb0b2;font-size:0.76rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-ctx-main .what{color:#818586;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-ctx .pa-b{flex:0 0 auto;padding:0.2rem 0.45rem}

.mx-toast{
  position:absolute;left:50%;bottom:4.2rem;transform:translateX(-50%);
  background:#242220;border:2px solid #0a0908;border-radius:0.45rem;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
  color:#f1efec;padding:0.4rem 0.7rem;font-size:0.85rem;z-index:5;
}

#pa-matrix-btn{position:relative}
#pa-matrix-btn .mx-badge{position:absolute;top:0.15rem;right:0.15rem;background:#c51a1b;color:#fff}

/* The room-list lock marker and the room-header lock icon share this warn
   tint (design doc §4.5): a room is still marked encrypted normally, this
   only fires when this device genuinely cannot decrypt it yet. */
.mx-lock.warn{color:#a86a2e}

/* The 🔐 status-strip button's attention dot — cryptoState !== 'ready'. */
#pa-mx-top .mx-encbtn{position:relative}
#pa-mx-top .mx-encbtn.attn::after{
  content:'';position:absolute;top:0.05rem;right:0.05rem;
  width:0.42rem;height:0.42rem;border-radius:50%;
  background:#c51a1b;box-shadow:0 0 0 1px #0a0908;
}

.mx-warn{
  color:#a86a2e;background:#262422;border:2px solid #0a0908;border-radius:0.45rem;
  padding:0.5rem 0.6rem;font-size:0.85rem;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}

/* A status chip, not the clickable filter chip .pa-chip already is (cursor:pointer, an .on toggle
   state) — same border/bevel tokens as every other bordered control (AGENTS.md: border ALWAYS 2px
   solid #0a0908), not the deprecated 1px inset-ring-with-no-border look. */
.mx-chip{
  display:inline-flex;align-items:center;gap:0.3rem;
  padding:0.15rem 0.5rem;border-radius:0.6rem;border:2px solid #0a0908;
  background:#37342f;color:#adb0b2;font-size:0.75rem;line-height:1.4;
  box-shadow:inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505;
}
.mx-chip.ok{color:#5aa348}
.mx-chip.warn{color:#a86a2e}

/* Mirrors MumbleSettingsUI's certificate row (a full-width readonly field + a two-button row + a
   paired passphrase field + a one-line hint), restyled onto .pa-input/.pa-b instead of Mumble's
   private CSS. Used for the two rows carrying the longest strings in the feature (the recovery key
   reveal, the key-file name) — 1fr on the field/auto on the trailing button, not the other way
   round, or a 48+ char recovery key shows ~20 characters at a time next to an over-stretched button. */
.mx-keyrow{display:grid;grid-template-columns:1fr auto;gap:0.4rem 0.6rem;align-items:center}
.mx-btns{display:flex;gap:0.5rem}
.mx-btns .pa-b{flex:1}
.mx-hint{font-size:0.8rem;color:#818586}
.mx-lbl{display:block;color:#818586;font-size:0.85rem;margin:0.5rem 0 0.15rem}
/* A checkbox row (the notifications view). The <label> wraps its own input so
   the text is part of the hit target; same accent and same dimmed-when-inert
   treatment as Mumble's .chk, so a checkbox reads identically across panels. */
.mx-chk{
  display:flex;align-items:center;gap:0.5rem;cursor:pointer;
  color:#f1efec;font-size:0.9rem;line-height:1.4;margin:0.2rem 0;
}
.mx-chk input{accent-color:#c51a1b;width:0.95rem;height:0.95rem;flex:0 0 auto;cursor:pointer}
.mx-chk.off{opacity:.45;cursor:default}
.mx-chk.off input{cursor:default}
/* Notifications turned off: the bell says so without opening the view, the same
   way the 🔐 button carries its own attention dot. */
#pa-mx-top .mx-notifybtn.off{opacity:.5}

/* ---- compact column ---------------------------------------------------------
   ui/dockWindow.ts puts .pa-compact on the panel below ~23rem of width. Note
   what is NOT here: not one font-size, avatar box, or button size changes. Text
   that resized as you dragged the window is the defect this replaced, so a
   narrow column earns its room back from gutters and from the two rows that
   repeat something already on screen — the same content, same size, less of it.

   Reached through the class rather than #pa-matrix-panel so the rules hold
   wherever the panel is mounted; dockWindow owns the class, this owns what it
   means for chat. */
.pa-compact #pa-mx-top{margin:0.4rem;padding:0.3rem 0.4rem;gap:0.35rem}
/* Your own MXID: the one line in the strip that never changes, and it is still
   on the avatar's tooltip. First to go. */
.pa-compact .mx-me{display:none}
.pa-compact #pa-mx > section{gap:0.4rem}
.pa-compact #pa-mx > section:not([data-view="room"]):not([data-view="encryption"]){padding:0.45rem 0.5rem 0.6rem}
.pa-compact .mx-encbody{padding:0.45rem 0.5rem 0.6rem;gap:0.4rem}
.pa-compact .mx-subhead{padding:0.4rem 0.45rem;gap:0.35rem}
.pa-compact #pa-mx-tl{padding:0.4rem 0.45rem;gap:0.45rem}
.pa-compact .mx-composer{padding:0.4rem 0.45rem;gap:0.4rem}
/* The room list's second line costs every row twice its height to preview a
   message the timeline shows in full the moment you open the room. */
.pa-compact .mx-prev{display:none}
/* 18rem of picture in a ~20rem column would be the panel's whole width minus
   its gutters; let it use what there is instead. */
.pa-compact .mx-img{max-width:100%}
/* A room name has more to lose from truncation than a timestamp does. */
.pa-compact #pa-mx .pa-list-row small{max-width:28%}
.pa-compact .mx-rich pre{padding:0.35rem 0.4rem}
/* Tightened so all nine reaction buttons still fit on one line of the message
   menu — a lone ＋ wrapping onto a second row reads like a mistake. */
.pa-compact .mx-menu-e{padding:0.1rem 0.15rem;min-width:1.4rem}
.pa-compact .mx-keyrow{gap:0.35rem 0.45rem}

/* A fingerprint is compared visually, so it must wrap onto more than one line rather than force a
   horizontal scroll inside a single-line <input> (where word-break has no effect at all). */
.mx-fp{
  font-family:'FS Pixel Sans',ui-monospace,monospace;letter-spacing:0.08em;
  white-space:normal;word-break:break-all;height:auto;line-height:1.5;padding:0.4rem 0.55rem;
}
`;
  document.head.appendChild(style);
}
