/**
 * Mumble panel: the usual mic / deafen / volume controls and a self-register
 * button, over a tabbed well holding the two views of the server — its channel
 * tree with the users in each, and a log of who has arrived or left since we
 * connected. Rendered into whatever container the host gives it — in the office
 * that is the right-hand docked application window (see ui/dockWindow.ts),
 * which is why nothing here sizes or positions itself.
 *
 * The tabs are a swap, not a second scroller: both panels are built and only
 * one is displayed, so the window keeps exactly one scrolling region either way
 * and switching never shows a stale list for a frame.
 *
 * The connection settings are a second view of this same window (⚙ in the
 * header strip, MumbleSettingsUI), not a section of the office's Settings
 * panel — the same arrangement Matrix chat uses for its own account pages. Only
 * one view is displayed at a time.
 *
 * Rows are deliberately one line per user (volume is a dropdown, not a slider):
 * a busy channel has to stay readable without scrolling.
 *
 * One-shot actions live in the row's own menu — its ⋯, or a right-click on it
 * — and both kinds of row have one: a channel's offers Join and Listen (place
 * an ear and hear it as well as your own), a user's offers somewhere to move
 * them. Both are permission-gated, and the gate is an entry's *presence*, down
 * to the ⋯ itself going away when its menu would be empty. The server remains
 * the authority — see `MumbleVoice.allowed` — so a refusal still arrives as the
 * note at the bottom of the panel.
 *
 * An ear shows up in the tree as a row of its own, in the channel being listened
 * to, for everyone's ears and not just ours: it is the only place the listening
 * is visible, since the listener's real row stays where they actually are.
 *
 * Desktop only: the constructor renders nothing at all when there is no Mumble
 * client behind it, so the browser build is untouched.
 */
import {
  MumbleVoice,
  type MumbleActivity,
  type MumbleDevices,
  type MumbleTree,
  type MumbleVoiceState,
} from './MumbleVoice.js';
import type { MumbleChannelInfo, MumbleUserInfo } from '../desktop/bridge.js';
import { MAX_MIC_GAIN } from './micGraph.js';
import { MumbleSettingsUI } from './MumbleSettingsUI.js';
import { openPanelMenu, type PanelMenuHandle, type PanelMenuItem } from './panelMenu.js';

export interface MumbleUIHooks {
  /** Called when the user joins/leaves, so the scene can park zone voice. */
  onJoin?: () => void;
  onLeave?: () => void;
}

/** Per-user volume choices. A dropdown keeps each user on one line, where a
 *  slider needed a second row — a channel with a dozen people has to stay
 *  readable without scrolling. */
const VOLUME_STEPS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/** A tree row that outlives the snapshot it was built from: the element stays in
 *  the document and `update` folds in fresh data. See renderTree for why the
 *  element has to survive rather than be rebuilt. */
interface ChannelRow {
  el: HTMLElement;
  update(channel: MumbleChannelInfo, userCount: number, depth: number): void;
}
interface UserRow {
  el: HTMLElement;
  update(user: MumbleUserInfo, depth: number, t: MumbleTree): void;
}
/** Somebody who has an ear in this channel while standing somewhere else. One
 *  per (channel, listener) pair, so the same person can appear under several. */
interface ListenerRow {
  el: HTMLElement;
  update(user: MumbleUserInfo, depth: number, t: MumbleTree): void;
}

/** The two panels the tab strip switches between: the server's channel tree,
 *  and who has come and gone since we connected. */
type MumbleTab = 'channels' | 'activity';

/** The tree flattened to the order it is drawn in, kept from the last render so
 *  the move menu can offer the same list in the same shape without walking the
 *  tree a second time. */
interface FlatChannel {
  id: number;
  name: string;
  depth: number;
}

export class MumbleUI {
  readonly voice: MumbleVoice | null;

  private track?: HTMLElement;
  private dot?: HTMLElement;
  private hint?: HTMLElement;
  private sub?: HTMLElement;
  private micBtn?: HTMLButtonElement;
  private deafBtn?: HTMLButtonElement;
  private regBtn?: HTMLButtonElement;
  private masterEl?: HTMLInputElement;
  private micGainEl?: HTMLInputElement;
  private gainValEl?: HTMLElement;
  private threshEl?: HTMLInputElement;
  private meterLvl?: HTMLElement;
  private meterThr?: HTMLElement;
  private micSel?: HTMLSelectElement;
  private spkSel?: HTMLSelectElement;
  private treeEl?: HTMLElement;
  private logEl?: HTMLElement;
  private treeTabBtn?: HTMLButtonElement;
  private logTabBtn?: HTMLButtonElement;
  private alertsEl?: HTMLInputElement;
  private mainEl?: HTMLElement;
  private rootEl?: HTMLElement;
  private cfgBtn?: HTMLButtonElement;
  private settings?: MumbleSettingsUI;
  private settingsOpen = false;
  /** Which of the two panels below the tab strip is showing. */
  private tab: MumbleTab = 'channels';
  /** Newest activity seq the reader has actually had on screen. Anything above
   *  it is what the Activity tab's count reports. */
  private seenActivitySeq = 0;
  /** Rows already in the tree, by channel id and by user session, so a re-render
   *  can update them instead of replacing them — see renderTree. */
  private readonly channelRows = new Map<number, ChannelRow>();
  private readonly userRows = new Map<number, UserRow>();
  /** Keyed `channel:session` — one person can hold ears in several channels. */
  private readonly listenerRows = new Map<string, ListenerRow>();
  private lastState?: MumbleVoiceState;
  /** The channels of the last render, in drawing order — the move menu's list. */
  private channelOrder: FlatChannel[] = [];
  /** Channel names by id, for the "listening here from …" line on an ear row. */
  private channelNames = new Map<number, string>();
  /** Whether there is anywhere we may move people to, recomputed once per
   *  render rather than once per user row: it is the same answer for all of
   *  them, and the tree repaints five times a second. */
  private canMove = false;
  /** At most one row menu is open at a time — a channel's or a user's. */
  private menu: PanelMenuHandle | null = null;
  private menuAnchor: HTMLElement | null = null;

  constructor(mount: HTMLElement, private readonly hooks: MumbleUIHooks = {}) {
    if (!MumbleVoice.supported) {
      this.voice = null;
      return;
    }
    this.voice = new MumbleVoice(
      (s) => this.renderState(s),
      (t) => this.renderTree(t),
      (d) => this.renderDevices(d),
      (l) => this.renderMicLevel(l),
      (a) => this.renderActivity(a),
    );
    this.injectStyles();
    this.build(mount);
    this.renderState(this.voice.state);
    this.renderTree({ channels: [], users: [], talking: new Set(), me: 0 });
    this.renderActivity(this.voice.activity);
  }

  /** Connect now if Mumble was left on last session. */
  start(): void {
    this.voice?.autoStart();
  }

  /** Swap between the channel tree and the connection settings. Only ever one of
   *  them is in the document's flow, so the window keeps its single scroller. */
  private showSettings(open: boolean): void {
    const settings = this.settings;
    if (!settings || !this.mainEl) return;
    // The menu is anchored to a row in the view we are about to hide, and a
    // popover left floating over the settings would have nothing under it.
    this.closeMenu();
    this.settingsOpen = open;
    this.mainEl.style.display = open ? 'none' : '';
    settings.el.style.display = open ? '' : 'none';
    this.cfgBtn?.classList.toggle('on', open);
    if (open) void settings.refresh();
  }

  /** Swap the panel under the tab strip. Both panels stay rendered and only one
   *  is displayed: the log is small, and keeping it live means switching to it
   *  never shows a stale list for a frame. */
  private showTab(tab: MumbleTab): void {
    if (!this.treeEl || !this.logEl || !this.treeTabBtn || !this.logTabBtn) return;
    this.closeMenu(); // its anchor is a tree row, which is about to be hidden
    this.tab = tab;
    const onChannels = tab === 'channels';
    this.treeEl.hidden = !onChannels;
    this.logEl.hidden = onChannels;
    this.treeTabBtn.classList.toggle('on', onChannels);
    this.logTabBtn.classList.toggle('on', !onChannels);
    this.treeTabBtn.setAttribute('aria-selected', String(onChannels));
    this.logTabBtn.setAttribute('aria-selected', String(!onChannels));
    this.renderActivityTab();
  }

  /**
   * The Activity tab's own label: how much has arrived that the reader has not
   * had on screen, so the tree can stay up without anything being missed.
   *
   * Also the one place `seenActivitySeq` advances — being on the Activity tab
   * means seeing whatever the last repaint put there.
   */
  private renderActivityTab(): void {
    if (!this.logTabBtn) return;
    const entries = this.voice?.activity ?? [];
    const newest = entries.length > 0 ? entries[entries.length - 1]!.seq : 0;
    // A sync restarts the sequence, so a newest that went backwards means the
    // log was replaced, not read.
    if (newest < this.seenActivitySeq) this.seenActivitySeq = 0;
    if (this.tab === 'activity') this.seenActivitySeq = newest;
    const unseen = entries.reduce((n, e) => (e.seq > this.seenActivitySeq ? n + 1 : n), 0);
    this.logTabBtn.textContent = unseen > 0 ? `Activity (${unseen})` : 'Activity';
    this.logTabBtn.classList.toggle('new', unseen > 0);
  }

  private injectStyles(): void {
    if (document.getElementById('pa-mb-style')) return;
    const style = document.createElement('style');
    style.id = 'pa-mb-style';
    style.textContent = `
      /* Fills its window's body, which does NOT scroll (DockWindow's fill
         option — see ui/dockWindow.ts). Each view is a <section> that takes the
         whole body and manages its own scrolling; only one is displayed. */
      /* position:relative anchors the row popovers (panelMenu.ts), which are
         placed against this box rather than the document so it stays inside
         the docked column and off the Phaser canvas. */
      #pa-mb{display:flex;flex-direction:column;flex:1;min-height:0;position:relative;}
      #pa-mb > section{display:flex;flex-direction:column;flex:1;min-height:0;}
      /* Main view: the controls above and the lines below are fixed; the
         channel tree is the only thing that moves, so reading the roster never
         pushes the mic/volume/device settings you are adjusting off the top of
         the panel.
         The overflow-y here is the short-window fallback, not the normal case:
         the tree absorbs all the slack, so it only ever engages once the tree
         has been squeezed down to its min-height and the alerts checkbox (or a
         note below it) would otherwise be unreachable. */
      #pa-mb-main{overflow-y:auto;overscroll-behavior:contain;}
      #pa-mb-master,#pa-mb-sub,#pa-mb-tabs,#pa-mb .chk,#pa-mb-note{flex:0 0 auto;}
      #pa-mb-master{display:flex;align-items:center;gap:0.75rem;padding:0.7rem 0.8rem;
        background:#141312;border:2px solid #0a0908;border-radius:0.5rem;}
      /* The header strip is where ⚙ lives, so the title block gives up the slack
         rather than the two controls beside it. */
      #pa-mb-master .ti{flex:1;min-width:0;}
      #pa-mb-master .cfg{flex:none;}
      #pa-mb-master .title{display:flex;align-items:center;gap:0.45rem;font-size:1rem;color:#f1efec;}
      #pa-mb-master .dot{width:0.5rem;height:0.5rem;border-radius:50%;background:#525556;}
      #pa-mb-master .dot.live{background:#5aa348;box-shadow:0 0 6px #5aa348;}
      #pa-mb-master .hint{font-size:0.78rem;color:#818586;margin-top:0.2rem;overflow:hidden;text-overflow:ellipsis;}
      #pa-mb-master .hint.bad{color:#e08894;}
      #pa-mb-track{flex:none;width:3.4rem;height:1.75rem;border-radius:1rem;border:2px solid #0a0908;cursor:pointer;
        position:relative;background:#302d2a;box-shadow:inset 0 2px 0 #423f3b,inset 0 -2px 0 #141312;transition:background .15s;}
      #pa-mb-track.on{background:#c51a1b;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10;}
      #pa-mb-track .knob{position:absolute;top:50%;left:1px;transform:translateY(-50%);width:1.25rem;height:1.25rem;
        border-radius:50%;background:#f5f3f0;box-shadow:0 2px 3px rgba(0,0,0,.5);transition:left .15s;}
      #pa-mb-track.on .knob{left:1.6rem;}
      #pa-mb-sub{margin-top:0.65rem;}
      /* The tree carries this itself rather than inheriting it: it used to sit
         inside #pa-mb-sub, and moving it out to be the panel's scroller must not
         quietly make a dead channel list look live. */
      #pa-mb-sub.off,#pa-mb-tree.off{opacity:.4;pointer-events:none;filter:grayscale(.4);}
      /* The log is deliberately NOT dimmed with the tree: the tree is a live
         picture of a server we are no longer talking to, but the log is a
         record of what happened, and stays worth reading after the drop. */
      #pa-mb-sub .row{display:flex;align-items:center;gap:0.55rem;margin:0.45rem 0;font-size:0.9rem;}
      #pa-mb-sub .row label{flex:0 0 auto;min-width:4rem;color:#adb0b2;}
      #pa-mb-sub input[type=range]{flex:1;accent-color:#c51a1b;}
      #pa-mb-sub .val{flex:0 0 auto;min-width:3.4rem;text-align:right;font-size:0.78rem;color:#adb0b2;}
      #pa-mb-sub select{flex:1;min-width:0;background:#262422;border:2px solid #0a0908;color:#f1efec;
        border-radius:0.35rem;padding:0.4rem;font:0.85rem 'FS Pixel Sans',monospace;box-shadow:inset 0 2px 0 #4a4744;}
      #pa-mb-sub select:disabled{opacity:0.5;}
      /* Outside #pa-mb-sub on purpose: a preference stays settable while the
         connection is off, when the rest of the sub-panel is disabled. */
      #pa-mb .chk{display:flex;align-items:center;gap:0.5rem;margin:0.6rem 0 0;font-size:0.88rem;color:#adb0b2;
        cursor:pointer;}
      #pa-mb .chk input{accent-color:#c51a1b;width:0.95rem;height:0.95rem;cursor:pointer;}
      #pa-mb-btns{display:flex;gap:0.4rem;margin:0.5rem 0;}
      #pa-mb button{cursor:pointer;background:#262422;border:2px solid #0a0908;color:#d7d5d1;border-radius:0.3rem;
        font:0.85rem 'FS Pixel Sans',monospace;padding:0.3rem 0.55rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
      #pa-mb button.on{background:#7c2634;border-color:#0a0908;color:#f6cdd4;
        box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
      #pa-mb-meter{position:relative;flex:1;height:0.6rem;background:#141312;border:2px solid #0a0908;
        border-radius:0.3rem;overflow:hidden;}
      #pa-mb-meter .lvl{position:absolute;left:0;top:0;bottom:0;width:0;background:#6b7280;transition:width .05s linear;}
      #pa-mb-meter .lvl.on{background:#5aa348;}
      #pa-mb-meter .thr{position:absolute;top:0;bottom:0;width:2px;background:#e7da00;}
      /* The tab strip over the well. The segmented look is paSkin's .pa-seg,
         but the "#pa-mb button" rule above outranks ".pa-seg .seg" on
         specificity (an id beats two classes) and would give these the panel's
         chunky button chrome — and .on its muted-mic red. So the seg look is
         restored here at a specificity that wins: "#pa-mb-tabs .seg.on" (1 id,
         2 classes) over "#pa-mb button.on" (1 id, 1 class, 1 element). Sized a
         little tighter than paSkin's default, which is meant for a form. */
      #pa-mb-tabs{margin:0.7rem 0 0.4rem;}
      #pa-mb-tabs .seg{flex:1;text-align:center;padding:0.35rem 0.3rem;cursor:pointer;border:0;
        border-radius:0.35rem;background:transparent;color:#adb0b2;
        font:0.88rem 'FS Pixel Sans',monospace;box-shadow:none;}
      #pa-mb-tabs .seg.on{color:#fff;background:#37342f;
        box-shadow:inset 0 2px 0 rgba(255,255,255,.14),inset 0 -2px 0 rgba(0,0,0,.35);}
      /* Something arrived while the tree was the tab on screen. Same yellow the
         threshold marker and the "you are here" channel use for "look here". */
      #pa-mb-tabs .seg.new{color:#e7da00;}
      /* The panel's one scrolling region — whichever of the two panels the tab
         strip is showing. It takes all the height the settings above and the
         lines below don't want, and scrolls inside its own bevelled well, so
         the edge of the scroller is where scrolling visibly starts. The
         min-height is what stops a short window from collapsing it to nothing —
         below that, #pa-mb scrolls as a whole instead. */
      #pa-mb-tree,#pa-mb-log{flex:1 1 auto;min-height:7rem;
        overflow-y:auto;overscroll-behavior:contain;
        border:2px solid #0a0908;border-radius:0.4rem;padding:0.3rem;
        box-shadow:inset 0 2px 0 #2c2a28,inset 0 -3px 0 #050505;
        /* Panel colour, not the deep-inset token: the border and bevel already
           mark the well, and #141312 here would flatten it against the user
           rows (also #141312) and swallow the "you are here" channel tint. */
        background:#1c1a19;}
      #pa-mb-tree .ch{display:flex;align-items:center;gap:0.4rem;padding:0.28rem 0.4rem;border-radius:0.3rem;
        cursor:pointer;font-size:0.88rem;color:#cac8c3;}
      #pa-mb-tree .ch:hover{background:#1c1a18;}
      #pa-mb-tree .ch.here{background:#262422;color:#f1efec;}
      #pa-mb-tree .ch .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #pa-mb-tree .ch .c{font-size:0.75rem;color:#818586;}
      /* The row's menu button — a channel's (join, listen) and a user's (move
         them). Kept out of sight until the row is under the pointer or holds
         keyboard focus, the same idiom the chat panel's ⋯ uses, so thirty rows
         are not thirty buttons. Hidden with opacity rather than display, so its
         space is always reserved and revealing it never reflows the row;
         pointer-events go with it so an invisible button cannot be clicked.
         Right-clicking the row opens the same menu, which is the discoverable
         half of this. */
      #pa-mb-tree .ch .mn{flex:none;padding:0.02rem 0.3rem;font-size:0.78rem;line-height:1.3;
        opacity:0;pointer-events:none;}
      #pa-mb-tree .us .mn{flex:none;padding:0.1rem 0.3rem;font-size:0.78rem;line-height:1.1;
        opacity:0;pointer-events:none;}
      #pa-mb-tree .ch:hover .mn,#pa-mb-tree .ch:focus-within .mn,#pa-mb-tree .ch.menu-open .mn,
      #pa-mb-tree .us:hover .mn,#pa-mb-tree .us:focus-within .mn,
      #pa-mb-tree .us.menu-open .mn{opacity:1;pointer-events:auto;}
      #pa-mb-tree .us{display:flex;align-items:center;gap:0.4rem;padding:0.22rem 0.4rem;margin:0.15rem 0;
        background:#141312;border:2px solid #0a0908;border-radius:0.4rem;}
      /* Tree indentation. Depth arrives as a custom property on the row (see
         mkChannelRow / mkUserRow) rather than as an inline pixel padding, so a
         compact column can tighten the step without the JS knowing how wide it
         is. Both rules must stay after the .ch / .us shorthands above, which
         would otherwise reset them. */
      #pa-mb-tree .ch{padding-left:calc(0.4rem + var(--mb-depth,0) * 0.8rem);}
      #pa-mb-tree .us{margin-left:calc(0.4rem + var(--mb-depth,0) * 0.8rem);}
      #pa-mb-tree .us .tk{width:0.45rem;height:0.45rem;border-radius:50%;background:#423f3b;flex:none;}
      #pa-mb-tree .us .tk.on{background:#5aa348;box-shadow:0 0 5px #5aa348;}
      #pa-mb-tree .us .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.86rem;color:#f0eeea;}
      #pa-mb-tree .us .nm.me{color:#9fd2ff;}
      /* An ear: somebody hearing this channel from another one. The same row as
         a member, dashed and quieter, because they are not in the channel —
         their real row is still where they actually are, and the channel's
         count counts members only. Carries no mute or volume control: it is the
         same person as that other row, and those settings are theirs, not this
         row's. */
      #pa-mb-tree .us.ln{background:#181716;border-style:dashed;border-color:#2c2a26;}
      #pa-mb-tree .us.ln .nm{color:#adb0b2;font-style:italic;}
      #pa-mb-tree .us.ln .nm.me{color:#9fd2ff;}
      #pa-mb-tree .us.ln .ec{flex:none;font-size:0.78rem;line-height:1;opacity:.85;}
      /* Our own ear comes off where you are looking at it. */
      #pa-mb-tree .us.ln.own{cursor:pointer;}
      #pa-mb-tree .us.ln.own:hover{background:#221f1d;border-color:#4a4744;}
      /* Per-user mic / speaker state. Same red-slash idiom as the zone-voice
         mute buttons, so "off" reads identically across both panels. */
      #pa-mb-tree .us .st{flex:none;position:relative;display:inline-block;line-height:1;font-size:0.8rem;opacity:.75;}
      #pa-mb-tree .us .st.off{opacity:1;}
      #pa-mb-tree .us .st.off::after{content:'';position:absolute;left:-12%;top:44%;width:124%;height:0.16em;
        background:#ff5b6b;border-radius:1px;transform:rotate(-24deg);box-shadow:0 0 0 1px rgba(0,0,0,.55);}
      /* Forced by an admin rather than chosen by the user — amber, not red. */
      #pa-mb-tree .us .st.forced::after{background:#e7da00;}
      #pa-mb-tree .us .mu{flex:none;padding:0.1rem 0.3rem;font-size:0.8rem;}
      #pa-mb-tree .us .mu .ico{position:relative;display:inline-block;line-height:1;}
      #pa-mb-tree .us .mu.on .ico::after{content:'';position:absolute;left:-12%;top:44%;width:124%;height:0.16em;
        background:#ff5b6b;border-radius:1px;transform:rotate(-24deg);box-shadow:0 0 0 1px rgba(0,0,0,.55);}
      #pa-mb-tree .us .vol{flex:none;width:4.4rem;background:#262422;border:2px solid #0a0908;color:#d7d5d1;
        border-radius:0.3rem;padding:0.1rem 0.15rem;font:0.78rem 'FS Pixel Sans',monospace;cursor:pointer;}
      #pa-mb-tree .empty,#pa-mb-log .empty{color:#818586;font-size:0.85rem;}
      /* One line per arrival/departure, same one-line-per-person discipline as
         the user rows next door: time, who, and which way they went. */
      #pa-mb-log .ev{display:flex;align-items:baseline;gap:0.45rem;padding:0.22rem 0.4rem;
        font-size:0.85rem;color:#cac8c3;}
      #pa-mb-log .ev .t{flex:0 0 auto;color:#818586;font-size:0.78rem;font-variant-numeric:tabular-nums;}
      #pa-mb-log .ev .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #pa-mb-log .ev .a{flex:0 0 auto;font-size:0.78rem;}
      #pa-mb-log .ev.in .a{color:#5aa348;}
      #pa-mb-log .ev.out .a{color:#818586;}
      #pa-mb-note{font-size:0.78rem;color:#e0b062;margin-top:0.4rem;line-height:1.45;}
      /* ---- row popovers (panelMenu.ts) --------------------------------------
         The floating-surface look every other popover in the app uses (deeper
         bevel + drop shadow), and the same chrome the chat panel's message menu
         has. The button rules are scoped under .mb-menu so they outrank
         "#pa-mb button" (1 id + 1 element) and the entries do not come out with
         the panel's chunky control chrome. */
      #pa-mb .mb-menu{position:absolute;z-index:6;min-width:10rem;max-width:calc(100% - 0.75rem);
        display:flex;flex-direction:column;gap:0.25rem;padding:0.35rem;
        background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;
        box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
      #pa-mb .mb-menu .hd{padding:0.1rem 0.25rem;font-size:0.76rem;color:#818586;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      /* The list scrolls, not the popover: the heading has to stay legible on a
         server with more channels than fit above the panel's edge. */
      #pa-mb .mb-menu .ls{display:flex;flex-direction:column;gap:0.25rem;
        max-height:14rem;overflow-y:auto;overscroll-behavior:contain;}
      #pa-mb .mb-menu button{display:block;width:100%;text-align:left;cursor:pointer;
        padding:0.32rem 0.5rem;padding-left:calc(0.5rem + var(--mb-depth,0) * 0.6rem);
        color:#f1efec;background:#242220;border:2px solid #0a0908;border-radius:0.45rem;
        font:0.88rem/1.3 'FS Pixel Sans',monospace;
        box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      #pa-mb .mb-menu button:hover:enabled{background:#37342f;}
      #pa-mb .mb-menu button:focus-visible{outline:2px solid #4998c0;outline-offset:1px;}
      /* A channel we may not move anyone into is shown and disabled rather than
         left out — a shorter list would read as the server having fewer
         channels than it does. */
      #pa-mb .mb-menu button:disabled{opacity:.4;cursor:default;}
      /* Where they already are. Same blue the tree uses for "this one is you". */
      #pa-mb .mb-menu button.here{opacity:.8;color:#9fd2ff;}

      /* ---- compact column ----------------------------------------------------
         ui/dockWindow.ts sets .pa-compact on the window below ~21rem. Nothing
         here changes a font-size: the row of controls a user row carries (talk
         dot, name, mic, headphones, mute, volume) is what actually runs out of
         width first, so the tightening is all gaps, labels and that dropdown. */
      .pa-compact #pa-mb-master{padding:0.5rem 0.55rem;gap:0.5rem;}
      .pa-compact #pa-mb-sub{margin-top:0.5rem;}
      .pa-compact #pa-mb-sub .row{gap:0.4rem;margin:0.35rem 0;}
      .pa-compact #pa-mb-sub .row label{min-width:3.1rem;}
      .pa-compact #pa-mb-sub .val{min-width:2.6rem;}
      /* Three buttons no longer fit on one line, so let them take two rather
         than shrink the hit targets. */
      .pa-compact #pa-mb-btns{flex-wrap:wrap;}
      .pa-compact #pa-mb-tabs{margin:0.5rem 0 0.3rem;}
      .pa-compact #pa-mb-tabs .seg{padding:0.3rem 0.2rem;font-size:0.82rem;}
      .pa-compact #pa-mb-tree,.pa-compact #pa-mb-log{padding:0.25rem;}
      .pa-compact #pa-mb-log .ev{gap:0.35rem;padding:0.2rem 0.3rem;}
      .pa-compact #pa-mb-tree .us{gap:0.3rem;padding:0.2rem 0.3rem;}
      .pa-compact #pa-mb-tree .us .vol{width:3.5rem;}
      .pa-compact #pa-mb-tree .us .mu,.pa-compact #pa-mb-tree .us .mn{padding:0.1rem 0.2rem;}
      .pa-compact #pa-mb .mb-menu .ls{max-height:11rem;}
      .pa-compact #pa-mb-tree .ch{padding:0.25rem 0.3rem;}
      /* A narrow column can't spend 0.8rem a level; nesting still has to be
         legible at depth 3 or 4 without pushing every name into an ellipsis. */
      .pa-compact #pa-mb-tree .ch{padding-left:calc(0.3rem + var(--mb-depth,0) * 0.5rem);}
      .pa-compact #pa-mb-tree .us{margin-left:calc(0.3rem + var(--mb-depth,0) * 0.5rem);}
    `;
    document.head.appendChild(style);
  }

  private build(mount: HTMLElement): void {
    const root = document.createElement('div');
    root.id = 'pa-mb';
    this.rootEl = root;
    // The header strip belongs to the window, not to either view: it is where
    // the connection lives, and reading its state while you edit the server you
    // are connecting to is the whole point of putting the settings in here.
    const master = document.createElement('div');
    master.id = 'pa-mb-master';
    master.innerHTML = `
      <div class="ti">
        <div class="title"><span class="dot"></span>Mumble</div>
        <div class="hint"></div>
      </div>
      <button class="cfg" id="pa-mb-cfgbtn" title="Server, identity and connection settings" aria-label="Mumble settings">⚙</button>
      <div id="pa-mb-track"><div class="knob"></div></div>`;
    root.appendChild(master);

    const main = document.createElement('section');
    main.id = 'pa-mb-main';
    main.dataset.view = 'main';
    main.innerHTML = `
      <div id="pa-mb-sub">
        <div id="pa-mb-btns">
          <button id="pa-mb-mic" title="Mute your microphone">🎤 Mic</button>
          <button id="pa-mb-deaf" title="Silence everyone">🔊 Sound</button>
          <button id="pa-mb-reg" title="Ask the server to register this identity">Register me</button>
        </div>
        <div class="row"><label>Mic</label><select id="pa-mb-micsel"></select></div>
        <div class="row"><label>Speaker</label><select id="pa-mb-spksel"></select></div>
        <div class="row"><label>Mic boost</label><input id="pa-mb-micgain" type="range" min="0" max="${MAX_MIC_GAIN * 100}" step="5"><span id="pa-mb-gainval" class="val"></span></div>
        <div class="row"><label>Volume</label><input id="pa-mb-vol" type="range" min="0" max="200"></div>
        <div class="row"><label>Threshold</label><input id="pa-mb-thresh" type="range" min="0" max="100"></div>
        <div class="row"><label>Level</label><div id="pa-mb-meter"><div class="lvl"></div><div class="thr"></div></div></div>
      </div>
      <div id="pa-mb-tabs" class="pa-seg" role="tablist">
        <button class="seg on" id="pa-mb-tab-channels" role="tab" aria-selected="true" aria-controls="pa-mb-tree">Channels</button>
        <button class="seg" id="pa-mb-tab-activity" role="tab" aria-selected="false" aria-controls="pa-mb-log">Activity</button>
      </div>
      <div id="pa-mb-tree" role="tabpanel" aria-labelledby="pa-mb-tab-channels"></div>
      <div id="pa-mb-log" role="tabpanel" aria-labelledby="pa-mb-tab-activity" hidden></div>
      <label class="chk" title="System notification when someone joins or leaves your channel"><input id="pa-mb-alerts" type="checkbox"> Join/leave alerts</label>
      <div id="pa-mb-note" hidden></div>`;
    root.appendChild(main);
    this.mainEl = main;

    this.dot = master.querySelector('.dot')!;
    this.hint = master.querySelector('.hint')!;
    this.track = master.querySelector('#pa-mb-track')!;
    this.cfgBtn = master.querySelector('#pa-mb-cfgbtn')!;
    this.sub = main.querySelector('#pa-mb-sub')!;
    this.micBtn = main.querySelector('#pa-mb-mic')!;
    this.deafBtn = main.querySelector('#pa-mb-deaf')!;
    this.regBtn = main.querySelector('#pa-mb-reg')!;
    this.micSel = main.querySelector('#pa-mb-micsel')!;
    this.spkSel = main.querySelector('#pa-mb-spksel')!;
    this.micGainEl = main.querySelector('#pa-mb-micgain')!;
    this.gainValEl = main.querySelector('#pa-mb-gainval')!;
    this.masterEl = main.querySelector('#pa-mb-vol')!;
    this.threshEl = main.querySelector('#pa-mb-thresh')!;
    this.meterLvl = main.querySelector('#pa-mb-meter .lvl')!;
    this.meterThr = main.querySelector('#pa-mb-meter .thr')!;
    this.treeEl = main.querySelector('#pa-mb-tree')!;
    this.logEl = main.querySelector('#pa-mb-log')!;
    this.treeTabBtn = main.querySelector('#pa-mb-tab-channels')!;
    this.logTabBtn = main.querySelector('#pa-mb-tab-activity')!;
    this.alertsEl = main.querySelector('#pa-mb-alerts')!;

    // The settings view. Saving reconnects with the new details — the panel used
    // to be told to do that from the office's Settings panel; now it is next door.
    this.settings = new MumbleSettingsUI({
      onBack: () => this.showSettings(false),
      onSaved: () => void this.voice?.reconnect(),
    });
    this.settings.el.style.display = 'none';
    root.appendChild(this.settings.el);

    const voice = this.voice!;
    this.track.addEventListener('click', () => {
      if (voice.isEnabled) {
        voice.leave();
        this.hooks.onLeave?.();
      } else {
        voice.join();
        this.hooks.onJoin?.();
      }
    });
    this.micBtn.onclick = () => voice.toggleMic();
    this.deafBtn.onclick = () => voice.toggleDeafen();
    this.regBtn.onclick = () => voice.selfRegister();
    this.micGainEl.addEventListener('input', () => voice.setMicSensitivity(Number(this.micGainEl!.value) / 100));
    this.threshEl.addEventListener('input', () => voice.setMicThreshold(Number(this.threshEl!.value) / 100));
    this.masterEl.addEventListener('input', () => voice.setMaster(Number(this.masterEl!.value) / 100));
    this.alertsEl.addEventListener('change', () => voice.setJoinAlerts(this.alertsEl!.checked));
    this.micSel.addEventListener('change', () => void voice.switchMic(this.micSel!.value));
    this.spkSel.addEventListener('change', () => void voice.switchSpeaker(this.spkSel!.value));
    this.treeTabBtn.onclick = () => this.showTab('channels');
    this.logTabBtn.onclick = () => this.showTab('activity');
    // Toggle, not push: the ⚙ is on screen in both views, so pressing it again
    // has to be the way back rather than a no-op (same as Matrix's 🔐 / 🔔).
    this.cfgBtn.onclick = () => this.showSettings(!this.settingsOpen);

    mount.appendChild(root);
    this.renderDevices({ mics: [], speakers: [] });
  }

  private renderState(s: MumbleVoiceState): void {
    this.lastState = s;
    if (!this.track) return;
    const enabled = this.voice?.isEnabled === true;
    this.track.classList.toggle('on', enabled);
    this.dot!.classList.toggle('live', s.connected);
    const hint = this.hint!;
    hint.classList.toggle('bad', !!s.error && !s.connected);
    hint.textContent = s.error && !s.connected
      ? s.error
      : s.connected
        ? `Connected${s.host ? ` — ${s.host}` : ''}`
        : s.connecting
          ? 'Connecting…'
          : s.host
            ? 'Off'
            : 'Not configured — open ⚙';
    hint.title = hint.textContent;

    this.sub!.classList.toggle('off', !s.connected);
    // The tree is a sibling of the settings block now (it is the panel's
    // scroller), so it no longer inherits the dimming and has to be told.
    this.treeEl?.classList.toggle('off', !s.connected);
    // An empty log's line names the connection state ("Not connected."), so it
    // has to be repainted when that changes. Only when empty: once there are
    // entries it says nothing about the connection, and rebuilding it on every
    // state tick would be waste.
    if (this.voice && this.voice.activity.length === 0) this.renderActivity(this.voice.activity);
    this.micBtn!.classList.toggle('on', !s.micOn);
    // Mumble ties self-deaf to self-mute, so say so on both buttons rather than
    // letting the mic appear to switch the sound back on out of nowhere.
    this.micBtn!.title = s.micOn
      ? 'Mute your microphone'
      : s.deafened
        ? 'Unmute — this also un-silences everyone'
        : 'Your microphone is muted';
    this.deafBtn!.classList.toggle('on', s.deafened);
    this.deafBtn!.title = s.deafened
      ? 'Everyone is silenced, and your mic with them'
      : 'Silence everyone — this also mutes your mic';
    this.regBtn!.hidden = s.registered;

    this.micGainEl!.value = String(Math.round(s.micGain * 100));
    this.renderGainValue(s.micGain);
    this.threshEl!.value = String(Math.round(s.micThreshold * 100));
    this.meterThr!.style.left = `${Math.round(s.micThreshold * 100)}%`;
    this.masterEl!.value = String(Math.round(s.master * 100));
    this.alertsEl!.checked = s.joinAlerts;

    // The server's own words for a refusal, plus whatever advice the thing we
    // asked for carries — the panel can no longer assume every PermissionDenied
    // is about registering, now that moving people and placing ears can be
    // refused too.
    const note = document.getElementById('pa-mb-note');
    if (note) {
      note.hidden = !s.notice;
      note.textContent = s.notice ? `${s.notice}${s.noticeHint ? ` — ${s.noticeHint}.` : ''}` : '';
    }
  }

  /** Show the boost as a multiplier plus dB — 400% alone doesn't tell you much. */
  private renderGainValue(gain: number): void {
    if (!this.gainValEl) return;
    if (gain <= 0) {
      this.gainValEl.textContent = 'off';
      return;
    }
    const db = 20 * Math.log10(gain);
    this.gainValEl.textContent = `${gain.toFixed(gain < 10 ? 1 : 0)}x`;
    this.gainValEl.title = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  }

  private renderMicLevel(level: number): void {
    if (!this.meterLvl) return;
    this.meterLvl.style.width = `${Math.round(level * 100)}%`;
    const open = level >= (this.lastState?.micThreshold ?? 0);
    this.meterLvl.classList.toggle('on', open && level > 0.001);
  }

  private renderDevices(d: MumbleDevices): void {
    if (!this.micSel || !this.spkSel) return;
    fillSelect(this.micSel, d.mics, d.micId);
    fillSelect(this.spkSel, d.speakers, d.speakerId);
  }

  /**
   * Fold a fresh snapshot into the tree.
   *
   * This runs every TALK_TICK_MS to animate the talking dots, so rows are updated
   * in place and only moved when the order really changes. Rebuilding them — or
   * even detaching and re-inserting the same elements, which is what
   * replaceChildren does — takes the volume <select> out of the document with its
   * native popup open, and that popup dies with it. It is why the dropdown used to
   * shut again a fifth of a second after you clicked it, before you could pick
   * anything.
   */
  private renderTree(t: MumbleTree): void {
    const el = this.treeEl;
    const voice = this.voice;
    if (!el || !voice) return;
    if (t.channels.length === 0) {
      this.channelRows.clear();
      this.userRows.clear();
      this.listenerRows.clear();
      this.channelOrder = [];
      this.channelNames.clear();
      this.canMove = false;
      this.closeMenu();
      el.replaceChildren(mkEmpty(this.lastState?.connected ? 'No channels.' : 'Not connected.'));
      return;
    }
    this.canMove = voice.canMoveAnyone();
    this.channelNames = new Map(t.channels.map((c) => [c.id, c.name]));
    const flat: FlatChannel[] = [];

    const byParent = new Map<number, MumbleChannelInfo[]>();
    const roots: MumbleChannelInfo[] = [];
    const ids = new Set(t.channels.map((c) => c.id));
    for (const c of t.channels) {
      // A channel whose parent is itself (the root) or missing hangs at the top.
      if (c.id === c.parent || !ids.has(c.parent)) roots.push(c);
      else {
        const list = byParent.get(c.parent);
        if (list) list.push(c);
        else byParent.set(c.parent, [c]);
      }
    }
    const usersByChannel = new Map<number, MumbleUserInfo[]>();
    for (const u of t.users) {
      const list = usersByChannel.get(u.channel);
      if (list) list.push(u);
      else usersByChannel.set(u.channel, [u]);
    }
    // Ears, by the channel being listened to. An ear in the channel you are
    // standing in is skipped: you already have a row there, and a second one
    // saying you can also hear it would be noise.
    const earsByChannel = new Map<number, MumbleUserInfo[]>();
    for (const u of t.users) {
      for (const id of u.listening) {
        if (id === u.channel) continue;
        const list = earsByChannel.get(id);
        if (list) list.push(u);
        else earsByChannel.set(id, [u]);
      }
    }

    const order: HTMLElement[] = [];
    const liveChannels = new Set<number>();
    const liveUsers = new Set<number>();
    const liveListeners = new Set<string>();
    const walk = (channel: MumbleChannelInfo, depth: number): void => {
      const users = (usersByChannel.get(channel.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      let ch = this.channelRows.get(channel.id);
      if (!ch) {
        ch = this.mkChannelRow(channel.id);
        this.channelRows.set(channel.id, ch);
      }
      ch.update(channel, users.length, depth);
      liveChannels.add(channel.id);
      flat.push({ id: channel.id, name: channel.name, depth });
      order.push(ch.el);
      for (const u of users) {
        let ur = this.userRows.get(u.session);
        if (!ur) {
          ur = this.mkUserRow(u, t);
          this.userRows.set(u.session, ur);
        }
        ur.update(u, depth + 1, t);
        liveUsers.add(u.session);
        order.push(ur.el);
      }
      // Listeners after the people actually in the channel: they are hearing
      // it, not standing in it, and the members are what the count counts.
      const ears = (earsByChannel.get(channel.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      for (const u of ears) {
        const key = `${channel.id}:${u.session}`;
        let lr = this.listenerRows.get(key);
        if (!lr) {
          lr = this.mkListenerRow(u, channel.id, t);
          this.listenerRows.set(key, lr);
        }
        lr.update(u, depth + 1, t);
        liveListeners.add(key);
        order.push(lr.el);
      }
      const kids = (byParent.get(channel.id) ?? []).sort(
        (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name),
      );
      for (const k of kids) walk(k, depth + 1);
    };
    for (const r of roots.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name))) {
      walk(r, 0);
    }
    for (const id of this.channelRows.keys()) if (!liveChannels.has(id)) this.channelRows.delete(id);
    for (const session of this.userRows.keys()) if (!liveUsers.has(session)) this.userRows.delete(session);
    for (const key of this.listenerRows.keys()) if (!liveListeners.has(key)) this.listenerRows.delete(key);
    this.channelOrder = flat;
    applyOrder(el, order);
  }

  /**
   * Offer somewhere to move one user.
   *
   * The list is the tree as it was last drawn, so it reads the same way as the
   * panel behind it, and every channel is on it — the ones we may not move
   * anyone into are disabled rather than missing (see panelMenu.ts).
   */
  private openUserMenu(
    session: number,
    who: string,
    from: number,
    anchor: HTMLElement,
    row: HTMLElement,
  ): void {
    const voice = this.voice;
    const root = this.rootEl;
    if (!voice || !root || !this.canMove || this.channelOrder.length === 0) return;
    // Asking again on the same row closes it; asking on another moves it there.
    // (A pointer press outside already closes it before the click lands — this
    // is what makes keyboard activation behave the same way.)
    if (this.menu) {
      const sameButton = this.menuAnchor === anchor;
      this.closeMenu();
      if (sameButton) return;
    }
    // Keeps the ⋯ visible while the pointer is over the menu rather than the row.
    row.classList.add('menu-open');
    this.menuAnchor = anchor;
    this.menu = openPanelMenu({
      anchor,
      container: root,
      head: `Move ${who} to`,
      label: `Move ${who}`,
      items: this.channelOrder.map((c) => ({
        label: c.name,
        depth: c.depth,
        current: c.id === from,
        disabled: !voice.canMoveInto(c.id),
        title:
          c.id === from
            ? `${who} is already in ${c.name}`
            : voice.canMoveInto(c.id)
              ? `Move ${who} into ${c.name}`
              : `You may not move people into ${c.name}`,
        onPick: () => voice.moveUser(session, c.id),
      })),
      onClose: () => {
        row.classList.remove('menu-open');
        this.menu = null;
        this.menuAnchor = null;
      },
    });
  }

  private closeMenu(): void {
    this.menu?.close();
    this.menu = null;
    this.menuAnchor = null;
  }

  /**
   * Repaint the activity log.
   *
   * **Newest first.** A log that grew downwards would need its own
   * stick-to-bottom rule to be readable, and would move under anyone reading it
   * the moment somebody connected; putting new lines at the top means the thing
   * worth seeing is already where the panel opens, and the scroll position of a
   * reader looking further back never has to be corrected.
   *
   * Rebuilt wholesale rather than diffed, unlike the tree next door: entries are
   * immutable and carry no controls, so there is no <select> popup or focus to
   * lose, and this runs when somebody connects rather than five times a second.
   */
  private renderActivity(entries: readonly MumbleActivity[]): void {
    const el = this.logEl;
    if (!el) return;
    this.renderActivityTab();

    if (entries.length === 0) {
      el.replaceChildren(
        mkEmpty(this.lastState?.connected ? 'Nobody has come or gone yet.' : 'Not connected.'),
      );
      return;
    }
    const rows = entries.map((e) => mkActivityRow(e)).reverse();
    el.replaceChildren(...rows);
  }

  /**
   * A channel row. Its id is fixed — the map is keyed by it — so only the name,
   * count, depth and "you are here" highlight are refreshed.
   *
   * Clicking the row still joins; everything else is in the row's menu, opened
   * by the ⋯ or by a right-click anywhere on it. That is what keeps a tree of
   * thirty channels from being a tree of thirty buttons, and the ⋯ stays out of
   * sight (see the CSS) until the row is under the pointer or holds focus.
   */
  private mkChannelRow(id: number): ChannelRow {
    const voice = this.voice!;
    const row = document.createElement('div');
    row.className = 'ch';
    const name = document.createElement('span');
    name.className = 'n';
    const count = document.createElement('span');
    count.className = 'c';
    const menuBtn = document.createElement('button');
    menuBtn.className = 'mn';
    menuBtn.textContent = '⋯';
    menuBtn.setAttribute('aria-haspopup', 'menu');
    row.append(name, count, menuBtn);
    // The row joins, so the button that does something else has to keep its
    // click to itself.
    let label = '';
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      this.openChannelMenu(id, label, menuBtn, row);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      // Anchored to the ⋯ either way, so the menu lands in the same place
      // however it was asked for.
      this.openChannelMenu(id, label, menuBtn, row);
    };
    row.onclick = () => voice.joinChannel(id);
    return {
      el: row,
      update: (channel, userCount, depth) => {
        // Asked once per channel per session (and again after an ACL change);
        // the answer decides what the menu below may offer.
        voice.requestPermissions(channel.id);
        label = channel.name;
        const here = channel.id === this.lastState?.channel;
        row.classList.toggle('here', here);
        row.style.setProperty('--mb-depth', String(depth));
        name.textContent = channel.name;
        count.textContent = userCount > 0 ? String(userCount) : '';
        row.title = channel.description ? `${channel.name} — ${channel.description}` : `Join ${channel.name}`;
        // Nothing to offer for the channel we are already in — joining it is a
        // no-op and an ear in it is what we take back down on arrival — so the
        // ⋯ goes away rather than opening an empty menu.
        menuBtn.hidden = !this.channelMenuItems(channel.id, channel.name).length;
        menuBtn.title = `${channel.name} — more`;
        menuBtn.setAttribute('aria-label', `${channel.name} actions`);
      },
    };
  }

  /**
   * What a channel row's menu may offer, which is also whether it has anything
   * to offer at all — the ⋯ is drawn from the same answer, so a menu is never
   * opened empty.
   *
   * An ear we already hold stays removable even if the Listen permission goes
   * away under us, or there would be no way to take it back down.
   */
  private channelMenuItems(id: number, name: string): PanelMenuItem[] {
    const voice = this.voice;
    if (!voice) return [];
    const items: PanelMenuItem[] = [];
    if (id !== this.lastState?.channel) {
      items.push({ label: '→ Join', title: `Join ${name}`, onPick: () => voice.joinChannel(id) });
    }
    if (voice.isListening(id)) {
      items.push({
        label: '👂 Stop listening',
        title: `Stop listening to ${name}`,
        onPick: () => voice.toggleListen(id),
      });
    } else if (voice.canListen(id)) {
      items.push({
        label: '👂 Listen',
        title: `Hear ${name} as well as your own channel, without leaving it`,
        onPick: () => voice.toggleListen(id),
      });
    }
    return items;
  }

  private openChannelMenu(id: number, name: string, anchor: HTMLElement, row: HTMLElement): void {
    const root = this.rootEl;
    if (!root) return;
    // Asking again on the same row closes it; asking on another moves it there.
    if (this.menu) {
      const sameButton = this.menuAnchor === anchor;
      this.closeMenu();
      if (sameButton) return;
    }
    const items = this.channelMenuItems(id, name);
    if (items.length === 0) return;
    // Keeps the ⋯ visible while the pointer is over the menu rather than the row.
    row.classList.add('menu-open');
    this.menuAnchor = anchor;
    this.menu = openPanelMenu({
      anchor,
      container: root,
      head: name,
      label: `${name} actions`,
      items,
      onClose: () => {
        row.classList.remove('menu-open');
        this.menu = null;
        this.menuAnchor = null;
      },
    });
  }

  /**
   * One line for an ear: somebody hearing this channel from another one.
   *
   * Drawn for everybody's ears, not just ours — it is the only place a listener
   * is visible at all, since their real row stays in the channel they are
   * standing in. Ours is clickable, because the row is where you are looking
   * when you want the ear gone.
   */
  private mkListenerRow(user: MumbleUserInfo, channelId: number, t: MumbleTree): ListenerRow {
    const voice = this.voice!;
    const row = document.createElement('div');
    row.className = 'us ln';
    const talk = document.createElement('span');
    const ear = document.createElement('span');
    ear.className = 'ec';
    ear.textContent = '👂';
    const name = document.createElement('span');
    const self = user.session === t.me;
    name.className = `nm${self ? ' me' : ''}`;
    row.append(talk, ear, name);
    if (self) {
      row.classList.add('own');
      row.onclick = () => voice.toggleListen(channelId);
    }
    return {
      el: row,
      update: (u, depth, tree) => {
        row.style.setProperty('--mb-depth', String(depth));
        talk.className = `tk${tree.talking.has(u.session) ? ' on' : ''}`;
        name.textContent = u.name;
        const from = this.channelNames.get(u.channel);
        const where = from ? ` from ${from}` : '';
        row.title = self
          ? `You are listening in here${where} — click to stop`
          : `${u.name} is listening in here${where}`;
      },
    };
  }

  /**
   * One line per user: talk dot, name, state flags, mute, volume dropdown, ⋯.
   *
   * Mute and volume stay on the row because they are settings you scan and
   * adjust across a channel, not one-shot actions. Moving somebody is a one-shot
   * action on one person, so it is in the row's menu — the same ⋯-or-right-click
   * a channel row has, rather than a control of its own.
   *
   * Built once per session and updated in place. Whether this is our own row is
   * fixed for the life of the row, since a new session id means a new row, so the
   * controls can be left out of the DOM entirely rather than toggled.
   */
  private mkUserRow(user: MumbleUserInfo, t: MumbleTree): UserRow {
    const voice = this.voice!;
    const row = document.createElement('div');
    row.className = 'us';
    const talk = document.createElement('span');
    const name = document.createElement('span');
    const mic = document.createElement('span');
    const spk = document.createElement('span');
    // Our own row carries no controls: you don't mute or attenuate yourself.
    const self = user.session === t.me;
    name.className = `nm${self ? ' me' : ''}`;
    row.append(talk, name, mic, spk);

    // Mute and volume are local-only, so they key off the display name — session
    // ids churn on every reconnect. A rename keeps the row, so the handlers read
    // the current name at click time rather than closing over the first one.
    // `where` is the same story for the move menu, which has to mark the channel
    // they are in *now*.
    let who = user.name;
    let where = user.channel;
    let menuBtn: HTMLButtonElement | undefined;
    let mute: HTMLButtonElement | undefined;
    let vol: HTMLSelectElement | undefined;
    let steps: number[] = [];
    if (!self) {
      mute = document.createElement('button');
      mute.className = 'mu';
      mute.innerHTML = '<span class="ico">🔊</span>';
      mute.onclick = () => voice.setUserMuted(who, !voice.isUserMuted(who));
      const sel = document.createElement('select');
      sel.className = 'vol';
      sel.onchange = () => voice.setUserVolume(who, Number(sel.value));
      vol = sel;
      row.append(mute, sel);
      // Moving yourself is what clicking a channel does, so there is nothing to
      // open on our own row. Last in the row, like a channel's ⋯.
      const btn = document.createElement('button');
      btn.className = 'mn';
      btn.textContent = '⋯';
      btn.setAttribute('aria-haspopup', 'menu');
      btn.onclick = (e) => {
        e.stopPropagation();
        this.openUserMenu(user.session, who, where, btn, row);
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        // Anchored to the ⋯ either way, so the menu lands in the same place
        // however it was asked for.
        this.openUserMenu(user.session, who, where, btn, row);
      };
      row.appendChild(btn);
      menuBtn = btn;
    }

    return {
      el: row,
      update: (u, depth, tree) => {
        who = u.name;
        where = u.channel;
        row.style.setProperty('--mb-depth', String(depth));
        talk.className = `tk${tree.talking.has(u.session) ? ' on' : ''}`;
        name.textContent = u.name;
        name.title = u.userId !== undefined ? `${u.name} — registered on the server` : u.name;
        applyStateIcon(mic, 'mic', u);
        applyStateIcon(spk, 'speaker', u);
        if (menuBtn) {
          // Moving is the only thing this menu offers, so with nowhere to move
          // anyone the ⋯ goes away rather than opening an all-disabled list.
          menuBtn.hidden = !this.canMove;
          menuBtn.title = `${u.name} — more`;
          menuBtn.setAttribute('aria-label', `${u.name} actions`);
        }
        if (!mute || !vol) return;
        const muted = voice.isUserMuted(u.name);
        mute.classList.toggle('on', muted);
        mute.title = muted ? 'Unmute this user for you' : 'Mute this user for you';
        vol.title = `Volume for ${u.name}`;
        const current = voice.getUserVolume(u.name);
        // Include the stored value if it isn't one of the presets (e.g. set by an
        // older build's slider), so opening the dropdown never silently changes it.
        const want = VOLUME_STEPS.includes(current)
          ? VOLUME_STEPS
          : [...VOLUME_STEPS, current].sort((a, b) => a - b);
        // Rewriting the options closes an open popup just as surely as replacing
        // the element would, so only do it when the choices actually differ.
        if (want.length !== steps.length || want.some((s, i) => s !== steps[i])) {
          steps = want;
          vol.replaceChildren(
            ...want.map((step) => {
              const o = document.createElement('option');
              o.value = String(step);
              o.textContent = `${Math.round(step * 100)}%`;
              return o;
            }),
          );
        }
        if (Number(vol.value) !== current) vol.value = String(current);
      },
    };
  }
}

/**
 * Make `el`'s children exactly `nodes`, in that order, moving as little as
 * possible.
 *
 * A row that is already in the right place must not be touched at all: taking a
 * node out of the document and putting it back drops focus, and a <select> loses
 * its open popup with it. That rules out replaceChildren even when it is handed
 * the very same elements it already has.
 */
function applyOrder(el: HTMLElement, nodes: HTMLElement[]): void {
  let cur = el.firstChild;
  for (const want of nodes) {
    if (cur === want) {
      cur = cur.nextSibling;
      continue;
    }
    el.insertBefore(want, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    el.removeChild(cur);
    cur = next;
  }
}

/**
 * Paint one state icon for a user's mic or speaker, in place — the row it belongs
 * to outlives any single snapshot, so the classes are set from scratch each time
 * rather than added to.
 *
 * Mumble distinguishes a user's own choice (self_mute / self_deaf) from one
 * imposed by the server (mute / deaf / suppress); both silence them, so both
 * get a slash, but the forced case is amber to make "an admin did this" legible
 * at a glance. Deafening implies you also transmit nothing, so a deafened user
 * shows a slashed mic too — matching what the official client displays.
 */
function applyStateIcon(el: HTMLElement, kind: 'mic' | 'speaker', user: MumbleUserInfo): void {
  el.className = 'st';
  if (kind === 'speaker') {
    el.textContent = '🎧';
    if (user.deaf) {
      el.classList.add('off', 'forced');
      el.title = 'Deafened by an admin';
    } else if (user.selfDeaf) {
      el.classList.add('off');
      el.title = 'Deafened — hears no one';
    } else {
      el.title = 'Hearing everyone';
    }
    return;
  }
  el.textContent = '🎤';
  if (user.mute) {
    el.classList.add('off', 'forced');
    el.title = 'Muted by an admin';
  } else if (user.suppress) {
    el.classList.add('off', 'forced');
    el.title = 'Suppressed — not allowed to speak here';
  } else if (user.selfMute || user.selfDeaf) {
    el.classList.add('off');
    el.title = user.selfDeaf ? 'Deafened, so not transmitting' : 'Microphone muted';
  } else {
    el.title = 'Microphone live';
  }
}

/** One activity line: time, who, and which way they went. The time is shown as
 *  a time of day (the log is reset on every sync, so it never spans much) with
 *  the full date in the tooltip for the case where it does. */
function mkActivityRow(e: MumbleActivity): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ev' + (e.joined ? ' in' : ' out');
  const when = document.createElement('span');
  when.className = 't';
  const at = new Date(e.ts);
  when.textContent = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  when.title = at.toLocaleString();
  const who = document.createElement('span');
  who.className = 'n';
  // Remote text: a display name from the server, so property assignment only.
  who.textContent = e.name;
  who.title = e.name;
  const what = document.createElement('span');
  what.className = 'a';
  what.textContent = e.joined ? 'joined' : 'left';
  row.append(when, who, what);
  return row;
}

function mkEmpty(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = text;
  return el;
}

function fillSelect(sel: HTMLSelectElement, devices: MediaDeviceInfo[], activeId?: string): void {
  sel.replaceChildren();
  sel.disabled = devices.length === 0;
  if (devices.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '—';
    sel.appendChild(o);
    return;
  }
  devices.forEach((dev, i) => {
    const o = document.createElement('option');
    o.value = dev.deviceId;
    o.textContent = dev.label || `Device ${i + 1}`;
    if (dev.deviceId === activeId) o.selected = true;
    sel.appendChild(o);
  });
}
