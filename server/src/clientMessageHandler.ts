import type { AgentStateStore } from './agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites } from './assetLoader.js';
import { LayoutStore } from './layoutStore.js';
import { claudeProvider } from './providers/index.js';

type WsSend = (message: Record<string, unknown>) => void;

/** Async hook toggle side effect (install/uninstall + script copy). Provided by cli.ts. */
export type SetHooksEnabledSideEffect = (enabled: boolean) => Promise<void> | void;

/** Cached assets loaded at server startup. Sent to each WebSocket client on webviewReady. */
export interface AssetCache {
  characters: LoadedCharacterSprites | null;
  floorTiles: string[][][] | null;
  wallTiles: string[][][][] | null;
  furniture: LoadedAssets | null;
  defaultLayout: Record<string, unknown> | null;
}

export interface ClientMessageContext {
  store: AgentStateStore;
  cache: AssetCache | null;
  /** SQLite-backed layout persistence (named layouts + active selection). */
  layoutStore: LayoutStore;
  /** Install/uninstall hooks side effect. Needs server url+token known only to cli.ts. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
}

/** Build a `layoutList` message reflecting the store's current state. */
function layoutListMessage(layoutStore: LayoutStore): Record<string, unknown> {
  return {
    type: 'layoutList',
    layouts: layoutStore.list(),
    active: layoutStore.getActiveName(),
  };
}

/** Build a `layoutLoaded` message for the currently-active layout. */
function activeLayoutMessage(layoutStore: LayoutStore, force: boolean): Record<string, unknown> {
  return {
    type: 'layoutLoaded',
    layout: layoutStore.getActiveLayout(),
    activeLayout: layoutStore.getActiveName(),
    force,
  };
}

// ── Setting key constants ──
const KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
const KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';

/**
 * Handle incoming ClientMessage from a WebSocket client.
 *
 * In standalone mode, the server is the authority for all state: assets,
 * layout, settings, agents. Assets are loaded once at startup and cached
 * in memory. Each connecting client receives the full state on webviewReady.
 */
export function handleClientMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const { store, layoutStore } = ctx;
  const adapter = store.getAdapter();

  switch (msg.type) {
    case 'webviewReady':
      handleWebviewReady(send, ctx);
      break;

    case 'saveLayout':
      // Autosave to the active layout. No-op when the active layout is the
      // read-only Default (the user must "save as" to start persisting). On a
      // successful write, push the new layout to OTHER viewers — their dirty
      // guard skips it for anyone mid-edit, including the originator.
      if (msg.layout && layoutStore.saveActive(msg.layout as Record<string, unknown>, Date.now())) {
        store.broadcast(activeLayoutMessage(layoutStore, false));
      }
      break;

    case 'saveLayoutAs':
      if (
        typeof msg.name === 'string' &&
        msg.layout &&
        LayoutStore.isValidUserName(msg.name)
      ) {
        layoutStore.saveAs(msg.name, msg.layout as Record<string, unknown>, Date.now());
        store.broadcast(activeLayoutMessage(layoutStore, true));
        store.broadcast(layoutListMessage(layoutStore));
      } else {
        send(layoutListMessage(layoutStore)); // reject silently; resync the UI
      }
      break;

    case 'loadLayout':
      if (typeof msg.name === 'string' && layoutStore.setActive(msg.name)) {
        store.broadcast(activeLayoutMessage(layoutStore, true));
        store.broadcast(layoutListMessage(layoutStore));
      } else {
        send(layoutListMessage(layoutStore));
      }
      break;

    case 'deleteLayout': {
      const activeBefore = layoutStore.getActiveName();
      if (typeof msg.name === 'string' && layoutStore.delete(msg.name)) {
        // Deleting the active layout switches active -> Default; push the swap.
        if (msg.name === activeBefore) {
          store.broadcast(activeLayoutMessage(layoutStore, true));
        }
      }
      store.broadcast(layoutListMessage(layoutStore));
      break;
    }

    case 'requestLayouts':
      send(layoutListMessage(layoutStore));
      break;

    case 'saveAgentSeats':
      if (msg.seats) {
        adapter?.saveSeats(
          msg.seats as Record<string, { palette?: number; hueShift?: number; seatId?: string }>,
        );
      }
      break;

    case 'setSoundEnabled':
      adapter?.setSetting(KEY_SOUND_ENABLED, msg.enabled);
      break;

    case 'setAlwaysShowLabels':
      adapter?.setSetting(KEY_ALWAYS_SHOW_LABELS, msg.enabled);
      break;

    default:
      // Unknown / not-yet-implemented messages are ignored.
      break;
  }
}

function handleWebviewReady(send: WsSend, ctx: ClientMessageContext): void {
  const { store, cache, layoutStore } = ctx;
  const adapter = store.getAdapter();

  // 1. Provider capabilities (must arrive before any agent messages)
  send({
    type: 'providerCapabilities',
    readingTools: [...claudeProvider.readingTools],
    subagentToolNames: [...claudeProvider.subagentToolNames],
  });

  // 2. Assets (from server cache, loaded at startup via pngjs)
  if (cache) {
    if (cache.characters) {
      send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
    }
    if (cache.floorTiles) {
      send({ type: 'floorTilesLoaded', sprites: cache.floorTiles });
    }
    if (cache.wallTiles) {
      send({ type: 'wallTilesLoaded', sets: cache.wallTiles });
    }
    if (cache.furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: cache.furniture.catalog,
        sprites: Object.fromEntries(cache.furniture.sprites),
      });
    }
  }

  // 3. Layout: the active named layout (or the bundled Default), plus the list
  //    of all saved layouts for the layout manager.
  send(activeLayoutMessage(layoutStore, true));
  send(layoutListMessage(layoutStore));

  // 4. Settings (from adapter, with sensible defaults when adapter is absent)
  send({
    type: 'settingsLoaded',
    soundEnabled: adapter?.getSetting(KEY_SOUND_ENABLED, true) ?? true,
    alwaysShowLabels: adapter?.getSetting(KEY_ALWAYS_SHOW_LABELS, false) ?? false,
  });


  // 6. Existing agents (either just restored, or from VS Code adapter if present)
  const agentIds: number[] = [];
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
  }
  const seats = adapter?.loadSeats() ?? {};
  send({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta: seats,
    folderNames,
    externalAgents,
  });

  // PIXEL-FEED PATCH: the webview buffers agents from `existingAgents` and only
  // flushes them into the office on a `layoutLoaded` message. Since layoutLoaded
  // is sent BEFORE existingAgents above, agents that already exist at connect
  // time (e.g. ingested remote sessions) would never render. Re-send the layout
  // here so the webview flushes the buffer. rebuildFromLayout keeps existing
  // characters, so this is safe and idempotent.
  send(activeLayoutMessage(layoutStore, true));
}
