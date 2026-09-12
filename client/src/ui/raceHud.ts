/**
 * What a race looks like from the driver's seat: the lights, the lap counter, the board.
 *
 * DOM over the canvas, like every other overlay here, for the reason the rest of them are: this
 * is text that must stay upright and crisp while the world turns underneath it, and the driving
 * camera rotates the canvas. A Phaser text object would have to be counter-rotated, re-rasterised
 * per zoom, and kept out of the depth sort.
 *
 * It renders from a plain model the scene assembles out of synced state and owns no truth of its
 * own — the phase, the timer, the places and the times are all decisions, and all of them are the
 * server's. The one thing it decides is what to SHOW: nothing at all when there is no race, which
 * is the normal state of a track and is why the panel is created lazily and hidden rather than
 * rebuilt.
 */
import { RACE_PHASES, type RacePhase } from '@pixel/shared/office/race/raceState.js';

export interface RaceHudDriver {
  name: string;
  place: number;
  lap: number;
  /** Total race time in ms once finished, else 0. */
  finishedMs: number;
  bestLapMs: number;
  /** This viewer's own kart. */
  me: boolean;
}

export interface RaceHudModel {
  phase: RacePhase;
  timerMs: number;
  laps: number;
  entries: number;
  /** Lamps lit, 0-3, and whether it is green. Computed from the same clock the engine releases
   *  the karts on, so the light and the launch cannot disagree. */
  lit: number;
  go: boolean;
  /** This viewer, when they are in the race. */
  own: { lap: number; place: number; lastLapMs: number; bestLapMs: number } | null;
  /** Everyone, for the board at the end. */
  drivers: RaceHudDriver[];
}

/** mm:ss.mmm, or a dash for "no time yet" — a board full of 0:00.000 reads as a bug. */
export function raceTime(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const CSS = `
.pa-race-lights{position:absolute;left:50%;top:14%;transform:translateX(-50%);display:flex;gap:0.6rem;
  z-index:48;pointer-events:none;}
.pa-race-lights i{width:2.2rem;height:2.2rem;border-radius:50%;border:2px solid #0a0908;background:#141312;
  box-shadow:inset 0 2px 0 #37342f;display:block;}
.pa-race-lights i.on{background:#c51a1b;box-shadow:inset 0 2px 0 #e2585a,0 0 12px rgba(197,26,27,.7);}
.pa-race-lights i.go{background:#5aa348;box-shadow:inset 0 2px 0 #7fbf6a,0 0 14px rgba(127,191,106,.8);}
.pa-race-info{position:absolute;left:50%;top:calc(14% + 3.2rem);transform:translateX(-50%);z-index:48;
  pointer-events:none;font:1.4rem 'FS Pixel Sans',monospace;color:#f5f3f0;text-shadow:0 0 4px #000,0 0 4px #000;}
.pa-race-hud{position:absolute;right:0.8rem;top:4.2rem;z-index:47;pointer-events:none;
  background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:0.5rem 0.7rem;
  box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;font:0.95rem 'FS Pixel Sans',monospace;color:#f1efec;}
.pa-race-hud b{color:#e7da00;font-weight:normal;}
.pa-race-hud .dim{color:#adb0b2;}
.pa-race-board{position:absolute;left:50%;top:22%;transform:translateX(-50%);z-index:49;pointer-events:none;
  background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:0.7rem 1rem;min-width:16rem;
  box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);
  font:1rem 'FS Pixel Sans',monospace;color:#f1efec;}
.pa-race-board h4{margin:0 0 0.5rem;font-weight:normal;color:#e7da00;}
.pa-race-board div{display:flex;justify-content:space-between;gap:1.2rem;padding:0.12rem 0;}
.pa-race-board div.me{color:#e7da00;}
`;

export class RaceHud {
  private lights: HTMLDivElement | null = null;
  private info: HTMLDivElement | null = null;
  private hud: HTMLDivElement | null = null;
  private board: HTMLDivElement | null = null;

  constructor(private readonly host: HTMLElement) {
    if (!document.getElementById('pa-race-style')) {
      const style = document.createElement('style');
      style.id = 'pa-race-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
  }

  /** Everything the overlay owns, gone. Called when the scene tears down a zone. */
  destroy(): void {
    for (const el of [this.lights, this.info, this.hud, this.board]) el?.remove();
    this.lights = this.info = this.hud = this.board = null;
  }

  update(m: RaceHudModel | null): void {
    if (!m || m.phase === 'idle') {
      this.hide();
      return;
    }
    this.renderLights(m);
    this.renderHud(m);
    this.renderBoard(m);
  }

  private hide(): void {
    for (const el of [this.lights, this.info, this.hud, this.board]) if (el) el.style.display = 'none';
  }

  private el(current: HTMLDivElement | null, cls: string): HTMLDivElement {
    if (current) return current;
    const el = document.createElement('div');
    el.className = cls;
    this.host.appendChild(el);
    return el;
  }

  private renderLights(m: RaceHudModel): void {
    this.lights = this.el(this.lights, 'pa-race-lights');
    this.info = this.el(this.info, 'pa-race-info');
    if (m.phase !== 'countdown') {
      this.lights.style.display = 'none';
      this.info.style.display = 'none';
      return;
    }
    this.lights.style.display = '';
    this.info.style.display = '';
    // Rebuilt only when the count changes — this runs every frame otherwise.
    const want = `${m.lit}${m.go ? 'g' : ''}`;
    if (this.lights.dataset.state !== want) {
      this.lights.dataset.state = want;
      this.lights.textContent = '';
      for (let i = 0; i < 3; i++) {
        const lamp = document.createElement('i');
        if (m.go) lamp.className = 'go';
        else if (i < m.lit) lamp.className = 'on';
        this.lights.appendChild(lamp);
      }
    }
    this.info.textContent = m.go ? 'GO!' : `${m.laps} laps`;
  }

  private renderHud(m: RaceHudModel): void {
    this.hud = this.el(this.hud, 'pa-race-hud');
    if (m.phase !== 'racing' || !m.own) {
      this.hud.style.display = 'none';
      return;
    }
    this.hud.style.display = '';
    const lap = Math.min(m.own.lap + 1, m.laps);
    this.hud.innerHTML =
      `<div>Lap <b>${lap}/${m.laps}</b> &nbsp; P<b>${m.own.place || '–'}</b>` +
      `<span class="dim">/${m.entries}</span></div>` +
      `<div><b>${raceTime(m.timerMs)}</b></div>` +
      `<div class="dim">last ${raceTime(m.own.lastLapMs)} · best ${raceTime(m.own.bestLapMs)}</div>`;
  }

  private renderBoard(m: RaceHudModel): void {
    this.board = this.el(this.board, 'pa-race-board');
    if (m.phase !== 'done') {
      this.board.style.display = 'none';
      return;
    }
    this.board.style.display = '';
    const rows = [...m.drivers].sort((a, b) => (a.place || 99) - (b.place || 99));
    this.board.innerHTML =
      '<h4>Result</h4>' +
      rows
        .map(
          (d) =>
            `<div class="${d.me ? 'me' : ''}"><span>${d.place ? `${d.place}.` : '—'} ${escapeHtml(d.name)}</span>` +
            `<span>${d.finishedMs ? raceTime(d.finishedMs) : `lap ${d.lap}`}</span></div>`,
        )
        .join('');
  }
}

/** Names come from other accounts, so they are text and never markup. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The phase for a synced index — anything this build does not know reads as no race at all. */
export function racePhaseOf(index: number): RacePhase {
  return RACE_PHASES[index] ?? 'idle';
}
