/**
 * Emoji reactions for the conference — the Jitsi model: you pick one of a small
 * fixed set, everyone in the call sees the same emoji sail up across the whole
 * window and hears a short jingle.
 *
 * Exactly **five** reactions, and that set is the wire protocol: a reaction
 * travels over the LiveKit data channel as an id, and both the sender and every
 * receiver look the emoji up here (`reactionById`). Nothing renders an emoji that
 * came off the network — a hostile client can only name one of these five ids, so
 * it can never inject markup or an arbitrary glyph into anyone's window (see
 * AGENTS.md rule 7 — data from another client is untrusted input).
 *
 * The effect itself is pure CSS animation on throwaway elements plus a WebAudio
 * motif (no sound files): particles rise from the bottom edge with a bit of drift
 * and rotation, and a big "hero" emoji pops in the middle with the name of
 * whoever sent it. Sound goes through client/src/sound.ts, so the viewer's
 * sound toggle and master volume apply to reactions too.
 */
import { playNotes, unlockAudio, type Note } from '../sound.js';

export interface Reaction {
  /** Wire id — never send the emoji itself; see the module comment. */
  id: string;
  emoji: string;
  /** Tooltip / accessible name. */
  label: string;
  /** The jingle, as offsets in seconds from "now". */
  notes: readonly Note[];
}

// Chiptune-ish motifs: square/triangle waves, quiet (they play over live audio)
// and short, each one recognisable without looking at the screen.
const V = 0.1; // shared peak level — reactions must never drown out speech

export const REACTIONS: readonly Reaction[] = [
  {
    id: 'up',
    emoji: '👍',
    label: 'Thumbs up',
    notes: [
      { freq: 523.25, start: 0, dur: 0.1, vol: V, type: 'triangle' }, // C5
      { freq: 783.99, start: 0.09, dur: 0.16, vol: V, type: 'triangle' }, // G5
    ],
  },
  {
    id: 'heart',
    emoji: '❤️',
    label: 'Love it',
    notes: [
      { freq: 659.25, start: 0, dur: 0.18, vol: V * 0.9, type: 'sine' }, // E5
      { freq: 987.77, start: 0.08, dur: 0.3, vol: V * 0.8, type: 'sine' }, // B5
    ],
  },
  {
    id: 'laugh',
    emoji: '😂',
    label: 'Funny',
    notes: [
      { freq: 880, start: 0, dur: 0.07, vol: V, type: 'square' }, // A5
      { freq: 1108.73, start: 0.08, dur: 0.07, vol: V, type: 'square' }, // C#6
      { freq: 880, start: 0.16, dur: 0.1, vol: V, type: 'square' },
    ],
  },
  {
    id: 'clap',
    emoji: '👏',
    label: 'Applause',
    notes: [
      { freq: 1500, start: 0, dur: 0.04, vol: V * 0.8, type: 'square' },
      { freq: 1300, start: 0.07, dur: 0.04, vol: V * 0.8, type: 'square' },
      { freq: 1600, start: 0.13, dur: 0.05, vol: V * 0.8, type: 'square' },
    ],
  },
  {
    id: 'party',
    emoji: '🎉',
    label: 'Celebrate',
    notes: [
      { freq: 523.25, start: 0, dur: 0.07, vol: V, type: 'triangle' }, // C5
      { freq: 659.25, start: 0.07, dur: 0.07, vol: V, type: 'triangle' }, // E5
      { freq: 783.99, start: 0.14, dur: 0.07, vol: V, type: 'triangle' }, // G5
      { freq: 1046.5, start: 0.21, dur: 0.22, vol: V, type: 'triangle' }, // C6
    ],
  },
];

/** Call from the gesture that opens the reaction picker: browsers only let an
 *  AudioContext start off a user gesture, and the reaction that follows is the
 *  first sound this window plays. */
export function primeReactionAudio(): void {
  unlockAudio();
}

/** Look up a reaction by wire id — the only way an id from the network becomes
 *  something we render. Unknown id → undefined → the message is dropped. */
export function reactionById(id: unknown): Reaction | undefined {
  return typeof id === 'string' ? REACTIONS.find((r) => r.id === id) : undefined;
}

/** Particles per reaction, and the ceiling on how many may be alive at once —
 *  a full call all reacting at once must not turn into thousands of nodes. */
const PARTICLES = 11;
const MAX_PARTICLES = 90;
/** Longest a particle can live (its animation + delay), for the safety cleanup. */
const PARTICLE_MS = 4200;
const HERO_MS = 1700;

/** The overlay + particle animations. Appended to the conference stylesheet. */
export const REACTION_CSS = `
  /* Full-window effect layer: covers the whole conference window (which is the
     whole page), sits above every tile and the side panel, and never eats clicks. */
  #pa-conf .pa-conf-fx{position:absolute;inset:0;z-index:200;overflow:hidden;pointer-events:none;}
  #pa-conf .pa-conf-fx .em{position:absolute;bottom:-2rem;line-height:1;will-change:transform,opacity;
    filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));animation:pa-react-rise linear forwards;}
  #pa-conf .pa-conf-fx .hero{position:absolute;left:50%;top:44%;display:flex;flex-direction:column;
    align-items:center;gap:0.4rem;transform:translate(-50%,-50%);animation:pa-react-pop ease-out forwards;}
  #pa-conf .pa-conf-fx .hero .big{font-size:5.5rem;line-height:1;filter:drop-shadow(0 4px 6px rgba(0,0,0,.6));}
  #pa-conf .pa-conf-fx .hero .who{font-size:1rem;color:#fff;background:#1c1a19;border:2px solid #0a0908;
    border-radius:0.5rem;padding:0.2rem 0.6rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
  @keyframes pa-react-rise{
    0%{transform:translate3d(0,0,0) rotate(0deg);opacity:0;}
    12%{opacity:1;}
    75%{opacity:1;}
    100%{transform:translate3d(var(--dx,0px),calc(-100vh - 4rem),0) rotate(var(--rot,20deg));opacity:0;}
  }
  @keyframes pa-react-pop{
    0%{transform:translate(-50%,-50%) scale(0.3);opacity:0;}
    18%{transform:translate(-50%,-50%) scale(1.15);opacity:1;}
    34%{transform:translate(-50%,-50%) scale(1);opacity:1;}
    100%{transform:translate(-50%,-140%) scale(0.9);opacity:0;}
  }
  /* Reaction badge that pops on the reactor's own tile (LiveKitConference adds it). */
  #pa-conf .pa-conf-tile .pa-conf-react{position:absolute;left:0.4rem;top:0.4rem;z-index:2;font-size:1.6rem;
    line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.7));animation:pa-react-badge 2.2s ease-out forwards;}
  @keyframes pa-react-badge{
    0%{transform:scale(0.4);opacity:0;}
    15%{transform:scale(1.25);opacity:1;}
    30%{transform:scale(1);opacity:1;}
    80%{opacity:1;}
    100%{transform:scale(1) translateY(-0.6rem);opacity:0;}
  }
  @media (prefers-reduced-motion:reduce){
    #pa-conf .pa-conf-fx .em{display:none;}
  }
`;

/** A deterministic-enough spread without caring about exact randomness. */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Play one reaction over the whole conference window: a rising burst of the
 * emoji, a hero emoji naming who sent it, and the reaction's jingle.
 * `host` is the overlay layer (`.pa-conf-fx`).
 */
export function playReactionEffect(host: HTMLElement, reaction: Reaction, who: string): void {
  void playNotes(reaction.notes);
  const room = MAX_PARTICLES - host.querySelectorAll('.em').length;
  for (let i = 0; i < Math.min(PARTICLES, room); i++) {
    const em = document.createElement('span');
    em.className = 'em';
    em.textContent = reaction.emoji;
    em.style.left = `${rand(3, 94)}%`;
    em.style.fontSize = `${rand(1.6, 3.1).toFixed(2)}rem`;
    em.style.setProperty('--dx', `${rand(-90, 90).toFixed(0)}px`);
    em.style.setProperty('--rot', `${rand(-40, 40).toFixed(0)}deg`);
    em.style.animationDuration = `${rand(2.4, 3.4).toFixed(2)}s`;
    em.style.animationDelay = `${rand(0, 0.5).toFixed(2)}s`;
    fadeAndDrop(host, em, PARTICLE_MS);
  }
  // One hero emoji at a time — a second reaction replaces the caption rather
  // than stacking unreadable names on top of each other.
  host.querySelector('.hero')?.remove();
  const hero = document.createElement('div');
  hero.className = 'hero';
  hero.style.animationDuration = `${HERO_MS}ms`;
  const big = document.createElement('span');
  big.className = 'big';
  big.textContent = reaction.emoji;
  const name = document.createElement('span');
  name.className = 'who';
  name.textContent = who; // textContent, never innerHTML — `who` is a remote name
  hero.append(big, name);
  fadeAndDrop(host, hero, HERO_MS + 300);
}

/** Append a one-shot animated element and make sure it goes away again, even if
 *  the animation never fires (background tab, reduced motion, display:none). */
function fadeAndDrop(host: HTMLElement, el: HTMLElement, maxMs: number): void {
  el.addEventListener('animationend', () => el.remove());
  host.appendChild(el);
  window.setTimeout(() => el.remove(), maxMs);
}
