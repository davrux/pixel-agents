/**
 * What a race looks like from the driver's seat: lights, position, times, the field, the flag.
 *
 * DOM over the canvas, like every other overlay here, for the reason the rest of them are: this is
 * text that must stay upright and crisp while the world turns underneath it, and the driving
 * camera rotates the canvas. A Phaser text object would have to be counter-rotated, re-rasterised
 * per zoom, and kept out of the depth sort.
 *
 * It renders from a plain model the scene assembles out of synced state and owns no truth of its
 * own — the phase, the timer, the places, the times and the records are all decisions, and all of
 * them are the server's. The one thing it decides is what to SHOW, and that is where most of the
 * thinking is:
 *
 *  - **Position first and biggest.** It is the one number a driver looks at mid-corner, and a race
 *    where you cannot see yourself losing is a time trial with extra cars in it.
 *  - **The field is a table, not a list of names.** Place, who, and the GAP — how far behind the
 *    leader, in seconds where a lap time exists to scale it, and in laps once somebody is lapped.
 *    A running order with no gaps says who is ahead but never how hard they are to catch.
 *  - **A banner is one line, centred, and short-lived.** "GO!", "FINAL LAP", a new record. Anything
 *    that has to be read while driving competes with the corner.
 *  - **Nothing at all when there is no race**, which is the normal state of a track — so the panel
 *    is created lazily and hidden rather than rebuilt.
 */
import { TYRE_WARN } from '@pixel/shared/office/constants.js';
import { raceClock } from '@pixel/shared/office/race/raceState.js';
import { RACE_PHASES, type RacePhase } from '@pixel/shared/office/race/raceState.js';

export interface RaceHudDriver {
  name: string;
  place: number;
  lap: number;
  /** Total race time in ms once finished, else 0. */
  finishedMs: number;
  bestLapMs: number;
  /** How far round the whole race, in laps — used for the gap and for the order. */
  progress: number;
  /** This viewer's own car. */
  me: boolean;
  /** A computer driver. */
  bot: boolean;
  /** Tyre left, 0…1. */
  tyre: number;
}

export interface RaceHudModel {
  phase: RacePhase;
  timerMs: number;
  laps: number;
  entries: number;
  /** Lamps lit, 0-3, and whether it is green. */
  lit: number;
  go: boolean;
  finalLap: boolean;
  /** The track's standing records and who holds them. */
  recordLapMs: number;
  recordLapBy: string;
  recordRaceMs: number;
  recordRaceBy: string;
  /** This viewer, when they are in the race. */
  own: {
    lap: number;
    place: number;
    lastLapMs: number;
    bestLapMs: number;
    wrongWay: boolean;
    tyre: number;
  } | null;
  drivers: RaceHudDriver[];
}

/** m:ss.cc, or a dash — the same formatter the server uses for its chat lines. */
export const raceTime = raceClock;

const CSS = `
.pa-race-lights{position:absolute;left:50%;top:13%;transform:translateX(-50%);display:flex;gap:0.6rem;
  z-index:48;pointer-events:none;}
.pa-race-lights i{width:2.2rem;height:2.2rem;border-radius:50%;border:2px solid #0a0908;background:#141312;
  box-shadow:inset 0 2px 0 #37342f;display:block;}
.pa-race-lights i.on{background:#c51a1b;box-shadow:inset 0 2px 0 #e2585a,0 0 12px rgba(197,26,27,.7);}
.pa-race-lights i.go{background:#5aa348;box-shadow:inset 0 2px 0 #7fbf6a,0 0 14px rgba(127,191,106,.8);}
.pa-race-banner{position:absolute;left:50%;top:calc(13% + 3.4rem);transform:translateX(-50%);z-index:48;
  pointer-events:none;font:1.5rem 'FS Pixel Sans',monospace;color:#f5f3f0;white-space:nowrap;
  text-shadow:0 0 4px #000,0 0 4px #000,0 0 8px #000;}
.pa-race-banner.warn{color:#e7da00;}
.pa-race-banner.bad{color:#e2585a;}

.pa-race-hud{position:absolute;right:0.8rem;top:4.2rem;z-index:47;pointer-events:none;
  background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:0.5rem 0.6rem;min-width:15rem;
  box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;font:0.95rem 'FS Pixel Sans',monospace;color:#f1efec;}
.pa-race-hud .top{display:flex;align-items:baseline;gap:0.6rem;}
.pa-race-hud .pos{font-size:2rem;color:#e7da00;line-height:1;}
.pa-race-hud .pos small{font-size:0.9rem;color:#adb0b2;}
.pa-race-hud .lap{font-size:1.1rem;}
.pa-race-hud .clock{margin-left:auto;font-size:1.1rem;}
.pa-race-hud .times{color:#adb0b2;margin-top:0.15rem;}
.pa-race-hud .rec{color:#818586;}
.pa-race-hud .tyre{display:flex;align-items:center;gap:0.4rem;margin-top:0.2rem;color:#adb0b2;}
.pa-race-hud .tyre .bar{flex:1;height:0.55rem;background:#141312;border:2px solid #0a0908;border-radius:0.2rem;overflow:hidden;}
.pa-race-hud .tyre .bar i{display:block;height:100%;background:#5aa348;}
.pa-race-hud .tyre.low .bar i{background:#a86a2e;}
.pa-race-hud .tyre.gone .bar i{background:#c51a1b;}
.pa-race-hud hr{border:0;border-top:2px solid #0a0908;margin:0.4rem -0.6rem;}
.pa-race-hud table{width:100%;border-collapse:collapse;}
.pa-race-hud td{padding:0.05rem 0;white-space:nowrap;}
.pa-race-hud td.p{width:1.4rem;color:#adb0b2;}
.pa-race-hud td.g{text-align:right;color:#adb0b2;padding-left:0.8rem;}
.pa-race-hud tr.me td{color:#e7da00;}
.pa-race-hud tr.me td.p,.pa-race-hud tr.me td.g{color:#e7da00;}
.pa-race-hud tr.out td{color:#818586;}

.pa-race-board{position:absolute;left:50%;top:18%;transform:translateX(-50%);z-index:49;pointer-events:none;
  background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:0.8rem 1.1rem;min-width:22rem;
  box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);
  font:1rem 'FS Pixel Sans',monospace;color:#f1efec;}
.pa-race-board h4{margin:0 0 0.5rem;font-weight:normal;color:#e7da00;font-size:1.2rem;}
.pa-race-board table{width:100%;border-collapse:collapse;}
.pa-race-board th{text-align:left;font-weight:normal;color:#818586;padding-bottom:0.25rem;}
.pa-race-board th.r,.pa-race-board td.r{text-align:right;}
.pa-race-board td{padding:0.12rem 0;}
.pa-race-board tr.me td{color:#e7da00;}
.pa-race-board .foot{color:#818586;margin-top:0.5rem;}
`;

export class RaceHud {
  private lights: HTMLDivElement | null = null;
  private banner: HTMLDivElement | null = null;
  private hud: HTMLDivElement | null = null;
  private board: HTMLDivElement | null = null;
  /** What the banner last said, so it is only rewritten when it changes. */
  private bannerText = '';

  constructor(private readonly host: HTMLElement) {
    if (!document.getElementById('pa-race-style')) {
      const style = document.createElement('style');
      style.id = 'pa-race-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
  }

  /** Everything the overlay owns, gone. */
  destroy(): void {
    for (const el of [this.lights, this.banner, this.hud, this.board]) el?.remove();
    this.lights = this.banner = this.hud = this.board = null;
  }

  update(m: RaceHudModel | null): void {
    if (!m) {
      this.hide();
      return;
    }
    this.renderLights(m);
    this.renderBanner(m);
    this.renderHud(m);
    this.renderBoard(m);
  }

  private hide(): void {
    for (const el of [this.lights, this.banner, this.hud, this.board]) if (el) el.style.display = 'none';
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
    if (m.phase !== 'countdown') {
      this.lights.style.display = 'none';
      return;
    }
    this.lights.style.display = '';
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
  }

  /**
   * One line, and only one — whichever matters most right now.
   *
   * Going the wrong way beats everything, because it is the only one you can act on; then the
   * lights, then the flag. Two banners stacked is two things to read in a corner.
   */
  private renderBanner(m: RaceHudModel): void {
    this.banner = this.el(this.banner, 'pa-race-banner');
    let text = '';
    let cls = '';
    if (m.phase === 'idle') {
      // Practice has one thing worth a banner, and it is the one you can act on.
      if (m.own?.wrongWay) {
        text = '⟲ WRONG WAY';
        cls = ' bad';
      }
    } else if (m.own?.wrongWay) {
      text = '⟲ WRONG WAY';
      cls = ' bad';
    } else if (m.phase === 'countdown') {
      text = m.go ? 'GO!' : `${m.laps} laps`;
      cls = m.go ? ' warn' : '';
    } else if (m.phase === 'racing' && m.own && m.own.tyre < TYRE_WARN) {
      // Worth a line because it is actionable: there is a pit lane and you can use it.
      text = m.own.tyre < 0.15 ? '◍ TYRES GONE — PIT' : '◍ WATCH YOUR TYRES';
      cls = ' warn';
    } else if (m.phase === 'racing' && m.finalLap) {
      text = '🏁 FINAL LAP';
      cls = ' warn';
    }
    if (!text) {
      this.banner.style.display = 'none';
      this.bannerText = '';
      return;
    }
    this.banner.style.display = '';
    if (this.bannerText !== text + cls) {
      this.bannerText = text + cls;
      this.banner.className = `pa-race-banner${cls}`;
      this.banner.textContent = text;
    }
  }

  /** The gap to the leader, as a driver reads it: seconds, or laps once lapped. */
  private gap(m: RaceHudModel, d: RaceHudDriver, leader: RaceHudDriver | undefined): string {
    if (d.finishedMs) return raceTime(d.finishedMs);
    if (!leader || d === leader) return d.me ? 'you' : '';
    const behind = leader.progress - d.progress;
    if (behind >= 1) return `+${Math.floor(behind)} lap${Math.floor(behind) > 1 ? 's' : ''}`;
    // Scaled by a real lap time where one exists — a gap in "fractions of a lap" means nothing.
    const lapMs = d.bestLapMs || leader.bestLapMs || m.recordLapMs;
    if (!lapMs) return '';
    return `+${((behind * lapMs) / 1000).toFixed(1)}s`;
  }

  private renderHud(m: RaceHudModel): void {
    this.hud = this.el(this.hud, 'pa-race-hud');
    if (m.phase === 'done' || (m.phase === 'idle' && !m.own)) {
      this.hud.style.display = 'none';
      return;
    }
    this.hud.style.display = '';
    // Practice: no race, no field, no places — your own lap, your own times, your own tyres, and
    // the record to chase. Everything a lap on your own is about.
    if (m.phase === 'idle' && m.own) {
      const rec = m.recordLapMs
        ? `<div class="rec">record ${raceTime(m.recordLapMs)}` +
          `${m.recordLapBy ? ` · ${escapeHtml(m.recordLapBy)}` : ''}</div>`
        : '<div class="rec">no record yet — /race to set one</div>';
      this.hud.innerHTML =
        `<div class="top"><span class="lap">Practice · lap ${m.own.lap + 1}</span>` +
        `<span class="clock">${raceTime(m.own.lastLapMs)}</span></div>` +
        `<div class="times">best ${raceTime(m.own.bestLapMs)}</div>` +
        this.tyreBar(m.own.tyre) +
        rec;
      return;
    }
    const order = [...m.drivers].sort((a, b) => (a.place || 99) - (b.place || 99));
    const leader = order[0];
    const own = m.own;
    const head = own
      ? `<div class="top"><span class="pos">P${own.place || '–'}<small>/${m.entries}</small></span>` +
        `<span class="lap">Lap ${Math.min(own.lap + 1, m.laps)}/${m.laps}</span>` +
        `<span class="clock">${raceTime(m.timerMs)}</span></div>` +
        `<div class="times">last ${raceTime(own.lastLapMs)} · best ${raceTime(own.bestLapMs)}</div>`
      : `<div class="top"><span class="lap">${m.laps} laps</span>` +
        `<span class="clock">${raceTime(m.timerMs)}</span></div>`;
    const tyre = own ? this.tyreBar(own.tyre) : '';
    const rec = m.recordLapMs
      ? `<div class="rec">record ${raceTime(m.recordLapMs)}${m.recordLapBy ? ` · ${escapeHtml(m.recordLapBy)}` : ''}</div>`
      : '';
    const rows = order
      .map(
        (d) =>
          `<tr class="${d.me ? 'me' : ''}${d.finishedMs ? ' out' : ''}">` +
          `<td class="p">${d.place || '–'}</td><td>${escapeHtml(d.name)}</td>` +
          `<td class="g">${this.gap(m, d, leader)}</td></tr>`,
      )
      .join('');
    this.hud.innerHTML = `${head}${tyre}${rec}<hr><table>${rows}</table>`;
  }

  /** Tyres as a bar: what a driver needs from them is "how much is left" at a glance, never a
   *  number. */
  private tyreBar(tyre: number): string {
    return (
      `<div class="tyre${tyre < 0.15 ? ' gone' : tyre < TYRE_WARN ? ' low' : ''}">` +
      `<span>tyres</span><span class="bar"><i style="width:${Math.round(tyre * 100)}%"></i></span></div>`
    );
  }

  private renderBoard(m: RaceHudModel): void {
    this.board = this.el(this.board, 'pa-race-board');
    if (m.phase !== 'done') {
      this.board.style.display = 'none';
      return;
    }
    this.board.style.display = '';
    const rows = [...m.drivers].sort((a, b) => (a.place || 99) - (b.place || 99));
    const body = rows
      .map(
        (d) =>
          `<tr class="${d.me ? 'me' : ''}"><td>${d.place ? `${d.place}.` : '—'}</td>` +
          `<td>${escapeHtml(d.name)}</td>` +
          `<td class="r">${d.finishedMs ? raceTime(d.finishedMs) : `lap ${Math.min(d.lap + 1, m.laps)}`}</td>` +
          `<td class="r">${raceTime(d.bestLapMs)}</td></tr>`,
      )
      .join('');
    const foot = m.recordLapMs
      ? `<div class="foot">Track record ${raceTime(m.recordLapMs)}${m.recordLapBy ? ` — ${escapeHtml(m.recordLapBy)}` : ''}` +
        (m.recordRaceMs ? ` · race ${raceTime(m.recordRaceMs)}${m.recordRaceBy ? ` — ${escapeHtml(m.recordRaceBy)}` : ''}` : '') +
        '</div>'
      : '';
    this.board.innerHTML =
      `<h4>Result — ${m.laps} laps</h4>` +
      `<table><tr><th></th><th>Driver</th><th class="r">Time</th><th class="r">Best lap</th></tr>${body}</table>` +
      foot;
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
