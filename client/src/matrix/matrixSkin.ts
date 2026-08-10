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

/** Builds one `.mx-av` initials square. `label` is remote (a display name or an
 *  MXID) so it is only ever assigned via `textContent`/`title` property assignment
 *  — never interpolated into markup. */
export function mkAvatar(seed: string, label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'mx-av';
  el.textContent = initialsOf(label);
  el.title = label;
  el.style.boxShadow = 'inset 0 0 0 2px ' + avatarTint(seed);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Injects the panel's stylesheet exactly once per document. Safe to call from
 *  every entry point that might open the panel first. */
export function injectMatrixSkin(): void {
  if (document.getElementById('pa-mx-style')) return;
  const style = document.createElement('style');
  style.id = 'pa-mx-style';
  style.textContent = `
#pa-matrix-panel{overflow:hidden;display:flex;flex-direction:column;height:min(36rem,calc(100vh - 4.7rem))}
#pa-matrix-panel.pa-docked{width:26rem;height:calc(100vh - 4.7rem)}
#pa-matrix-panel .pa-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:0}

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
/* Every other view (encryption, members, …) stacks a lot more content than the panel's fixed height
   can show at once — without its own scroller here, .pa-panel's own overflow-y:auto (paSkin.ts) is
   overridden by #pa-matrix-panel/.pa-body's overflow:hidden above, and everything past the fold is
   simply clipped with no scrollbar (unreachable, not just unseen). */
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
  width:2.1rem;height:2.1rem;flex:0 0 auto;
  background:#141312;border:2px solid #0a0908;border-radius:0.35rem;
  color:#f1efec;display:flex;align-items:center;justify-content:center;
  font-size:0.8rem;font-weight:600;user-select:none;
}

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

.mx-msg{padding-left:0}
.mx-msg .mx-txt{
  color:#f1efec;font-size:0.95rem;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;
  font-family:'FS Pixel Sans',ui-monospace,monospace;
}
.mx-msg.pending{opacity:.55}
.mx-msg.failed{color:#f6cdd4;border-left:3px solid #7c2634;padding-left:0.5rem}
.mx-msg.deleted .mx-txt{color:#818586;font-style:italic}
.mx-msg.notice .mx-txt,.mx-msg.emote .mx-txt{color:#adb0b2}
.mx-retry{color:#4998c0;cursor:pointer;font-size:0.8rem;margin-left:0.4rem;text-decoration:underline}

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
/* A fingerprint is compared visually, so it must wrap onto more than one line rather than force a
   horizontal scroll inside a single-line <input> (where word-break has no effect at all). */
.mx-fp{
  font-family:'FS Pixel Sans',ui-monospace,monospace;letter-spacing:0.08em;
  white-space:normal;word-break:break-all;height:auto;line-height:1.5;padding:0.4rem 0.55rem;
}
`;
  document.head.appendChild(style);
}
