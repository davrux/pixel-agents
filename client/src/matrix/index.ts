/**
 * The one and only export surface of the `client/src/matrix/` chunk. The host
 * reaches everything in this feature exclusively through
 * `await import('../matrix/index.js')` — nothing else in this directory is
 * ever imported directly from outside it. Keeping the surface this small is
 * what keeps the chunk lazy: any other export here is a crack a bundler can
 * use to pull the whole Matrix client (and its CS-API layer) into the main
 * bundle for users who never open the panel.
 */
import { MatrixUI, type MatrixUIHooks } from './MatrixUI.js';
import { injectMatrixSkin } from './matrixSkin.js';

export interface MatrixClientHooks {
  paUserId: string;
  onPinChange(pinned: boolean): void;
  onUnreadChange(unread: number): void;
  /** Escape at the panel's root view (nothing left to pop): the host should
   *  close the panel the same way its own ✕/toggle would. */
  onRequestClose(): void;
}

export interface MatrixClientHandle {
  readonly isPinned: boolean;
  unpin(): void;
  ownsFocus(): boolean;
  openDm(mxid: string): void;
  destroy(): void;
}

export function createMatrixClient(mount: HTMLElement, hooks: MatrixClientHooks): MatrixClientHandle {
  injectMatrixSkin();
  const uiHooks: MatrixUIHooks = hooks;
  const ui = new MatrixUI(mount, uiHooks);
  return {
    get isPinned() {
      return ui.isPinned;
    },
    unpin: () => ui.unpin(),
    ownsFocus: () => ui.ownsFocus(),
    openDm: (mxid) => ui.openDm(mxid),
    destroy: () => ui.destroy(),
  };
}
