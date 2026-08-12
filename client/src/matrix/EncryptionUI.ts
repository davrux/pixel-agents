/**
 * The `encryption` view: recovery (4S) unlock/setup, key backup, Element-format
 * room-key file import/export, and the device panel (this device's fingerprint
 * + trust, other devices, read-only). Mounted by MatrixUI as an eighth panel
 * view; it never touches the panel router or the store directly — everything
 * it needs or does goes through `EncryptionViewHooks`.
 *
 * The room-key-file rows deliberately mirror MumbleSettingsUI's certificate
 * row (readonly field + a two-button row + a paired passphrase field + a
 * one-line hint) restyled onto `.pa-input`/`.pa-b`. Unlike Mumble's
 * `pickCertFile()` (an Electron-only native dialog that stores a *path*),
 * there is nothing to persist here — the file is read once into memory with
 * `<input type="file">` + `file.text()`, which behaves identically in Chrome,
 * Firefox and the Electron `app://` renderer.
 *
 * Three secret inputs live in this file (recovery key/phrase, import
 * passphrase, export passphrase + confirm). Per AGENTS.md and the design doc
 * (§8.1): created with `document.createElement`, `type`/`autocomplete` set as
 * *properties* (never a `value=` attribute), never logged, never persisted,
 * and blanked at the earliest safe moment (see the call sites below).
 */
import type { MxBackupStatus, MxCryptoState, MxDeviceInfo, MxKeyImportResult, MxSecretRequest } from './types.js';
import { describeError } from './session.js';
import type { MatrixCrypto } from './crypto.js';
import { KeyFileError, decryptKeyFile, encryptKeyFile } from './keyfile.js';

export interface EncryptionViewHooks {
  crypto(): MatrixCrypto | null;
  cryptoState(): MxCryptoState;
  myUserId(): string;
  paUserId(): string;
  askPassword(message: string): Promise<string | null>;
  /** Leave this view for the room list. Escape does the same thing (MatrixUI's
   *  root keydown handler), but this view is far taller than the panel, so a
   *  keyboard-only exit is not a discoverable one — hence the ◀ every other
   *  secondary view already has. */
  onBack(): void;
  onSignOut(): void;
  onChanged(): void;
  toast(message: string): void;
}

export interface EncryptionViewHandle {
  readonly el: HTMLElement;
  render(): void;
  focusUnlock(): void;
  noteSecretRequest(req: MxSecretRequest): void;
  destroy(): void;
}

const MAX_KEYFILE_BYTES = 32 * 1024 * 1024;

export function createEncryptionView(hooks: EncryptionViewHooks): EncryptionViewHandle {
  return new EncryptionView(hooks);
}

class EncryptionView implements EncryptionViewHandle {
  readonly el: HTMLElement;

  /** The scrolling part of the view. `el` itself is a fixed-height flex column
   *  holding a pinned subhead (with the ◀) + this; putting the content here
   *  instead of on `el` is what keeps the back button from scrolling away. */
  private readonly body: HTMLElement;

  // --- static skeleton refs, built once in the constructor ---
  private statusBanner!: HTMLElement;

  private recoveryGroup!: HTMLElement;
  private recoveryUnknown!: HTMLElement;
  private recoveryNeverSetup!: HTMLElement;
  private recoveryReveal!: HTMLElement;
  private recoveryRevealInput!: HTMLInputElement;
  private recoveryLocked!: HTMLElement;
  private recoveryLabel!: HTMLElement;
  private recoveryInput!: HTMLInputElement;
  private recoveryErr!: HTMLElement;
  private recoveryUnlockBtn!: HTMLButtonElement;
  private recoveryReady!: HTMLElement;
  private recoverySetupErrEl!: HTMLElement;

  private backupGroup!: HTMLElement;
  private backupChip!: HTMLElement;
  private backupConnectBtn!: HTMLButtonElement;
  private backupRestoreBtn!: HTMLButtonElement;
  private backupResult!: HTMLElement;

  private keyfileField!: HTMLInputElement;
  private keyfilePicker!: HTMLInputElement;
  private importPassInput!: HTMLInputElement;
  private importBtn!: HTMLButtonElement;
  private importGroupEls!: HTMLElement[];
  private importErr!: HTMLElement;
  private importResult!: HTMLElement;

  private exportPassInput!: HTMLInputElement;
  private exportConfirmInput!: HTMLInputElement;
  private exportBtn!: HTMLButtonElement;
  private exportErr!: HTMLElement;

  private deviceIdField!: HTMLInputElement;
  private fingerprintField!: HTMLTextAreaElement;
  private deviceChip!: HTMLElement;
  private deviceOwnerLine!: HTMLElement;
  private verifyBtn!: HTMLButtonElement;

  private otherDevicesLabel!: HTMLElement;
  private otherDevicesList!: HTMLElement;
  private otherDevicesEmpty!: HTMLElement;

  private verificationNote!: HTMLElement;

  // --- transient view state (not owned by the crypto state machine) ---
  private keyFileText: string | null = null;
  private keyFileName = '';
  private keyFileSize = 0;

  private localUnlockErr: string | null = null;
  private unlockBusy = false;
  private recoveryUnknownBusy = false;
  private secretRequestHasPassphrase = true;

  private setupBusy = false;
  private revealedKey: string | null = null;
  private setupErr: string | null = null;

  private backupStatus: MxBackupStatus | null = null;
  private backupBusy: string | null = null; // 'connect' | 'restore' | null

  private importBusy = false;
  private importProgressPct: number | null = null;

  private exportBusy = false;

  private ownDevice: MxDeviceInfo | null = null;
  private otherDevices: MxDeviceInfo[] = [];
  private devicesFetchedFor: MatrixCrypto | null = null;
  private devicesLoaded = false;

  private showVerificationNote = false;

  private boundCrypto: MatrixCrypto | null = null;
  private cryptoUnsubs: Array<() => void> = [];

  constructor(private readonly hooks: EncryptionViewHooks) {
    this.el = document.createElement('section');
    this.el.dataset.view = 'encryption';
    // Focusable as a fallback landing spot (see focusUnlock()'s caller in MatrixUI.pushRootView) —
    // without something inside this section ever receiving focus, ownsFocus() stays false and
    // OfficeScene/ChatUI's guards treat the panel as inert, leaking a keystroke into zone chat.
    this.el.tabIndex = -1;

    const subhead = document.createElement('div');
    subhead.className = 'mx-subhead';
    const back = document.createElement('button');
    back.className = 'pa-b';
    back.textContent = '◀';
    back.setAttribute('aria-label', 'Back to chats');
    back.title = 'Back to chats';
    back.addEventListener('click', () => this.hooks.onBack());
    subhead.appendChild(back);
    const title = document.createElement('span');
    title.className = 'mx-room-name';
    title.textContent = 'Encryption';
    subhead.appendChild(title);
    this.el.appendChild(subhead);

    this.body = document.createElement('div');
    this.body.className = 'mx-encbody';
    this.el.appendChild(this.body);

    this.build();
    this.render();
  }

  // ---------------------------------------------------------------- build

  private build(): void {
    this.statusBanner = document.createElement('div');
    this.statusBanner.hidden = true;
    this.body.appendChild(this.statusBanner);

    this.body.appendChild(groupLabel('RECOVERY'));
    this.recoveryGroup = document.createElement('div');
    this.body.appendChild(this.recoveryGroup);
    this.buildRecoveryGroup();

    this.backupGroup = document.createElement('div');
    this.body.appendChild(this.backupGroup);
    this.buildBackupGroup();

    this.body.appendChild(groupLabel('ROOM KEY FILE'));
    this.buildKeyfileGroup();

    this.body.appendChild(groupLabel('EXPORT'));
    this.buildExportGroup();

    this.body.appendChild(groupLabel('THIS DEVICE'));
    this.buildDeviceGroup();

    this.otherDevicesLabel = groupLabel('OTHER DEVICES');
    this.body.appendChild(this.otherDevicesLabel);
    this.otherDevicesList = document.createElement('div');
    this.body.appendChild(this.otherDevicesList);
    this.otherDevicesEmpty = mutedLine("This is the only device on your account.");
    this.body.appendChild(this.otherDevicesEmpty);

    this.verificationNote = mutedLine(
      "Another device asked to verify. This client can't do emoji verification yet — unlock with your recovery key instead.",
    );
    this.verificationNote.hidden = true;
    this.body.appendChild(this.verificationNote);
  }

  private buildRecoveryGroup(): void {
    this.recoveryUnknown = document.createElement('div');
    this.recoveryUnknown.hidden = true;
    this.recoveryUnknown.appendChild(mutedLine("Couldn't check your recovery status."));
    const retryBtn = pixelButton('Retry', ['wide']);
    retryBtn.onclick = () => this.onRetryRecoveryCheck();
    this.recoveryUnknown.appendChild(retryBtn);
    this.recoveryGroup.appendChild(this.recoveryUnknown);

    this.recoveryNeverSetup = document.createElement('div');
    this.recoveryNeverSetup.appendChild(
      mutedLine(
        "Your account has no encryption recovery. Without it, signing in on a new device can't read your encrypted history.",
      ),
    );
    const setupBtn = pixelButton('Set up recovery', ['primary', 'wide']);
    setupBtn.onclick = () => void this.onSetUpRecovery();
    this.recoveryNeverSetup.appendChild(setupBtn);
    const setupErrEl = errSlot();
    this.recoveryNeverSetup.appendChild(setupErrEl);
    this.recoverySetupErrEl = setupErrEl;
    this.recoveryGroup.appendChild(this.recoveryNeverSetup);

    this.recoveryReveal = document.createElement('div');
    this.recoveryReveal.hidden = true;
    this.recoveryReveal.appendChild(labelEl('Recovery key'));
    const revealRow = document.createElement('div');
    revealRow.className = 'mx-keyrow';
    this.recoveryRevealInput = pixelInput('text');
    this.recoveryRevealInput.readOnly = true;
    const copyBtn = pixelButton('Copy', []);
    copyBtn.onclick = () => void copyToClipboard(this.recoveryRevealInput.value, this.hooks);
    revealRow.append(this.recoveryRevealInput, copyBtn);
    this.recoveryReveal.appendChild(revealRow);
    this.recoveryReveal.appendChild(
      warnLine('Save this now. It is the only way back into your encrypted history.'),
    );
    const savedBtn = pixelButton("I've saved it", ['primary']);
    savedBtn.onclick = () => this.onRecoverySaved();
    this.recoveryReveal.appendChild(savedBtn);
    this.recoveryGroup.appendChild(this.recoveryReveal);

    this.recoveryLocked = document.createElement('div');
    this.recoveryLocked.hidden = true;
    this.recoveryLabel = labelEl('Recovery key or phrase');
    this.recoveryLocked.appendChild(this.recoveryLabel);
    this.recoveryInput = pixelInput('password');
    this.recoveryInput.autocomplete = 'new-password';
    submitOnEnter(this.recoveryInput, () => void this.onUnlock());
    this.recoveryLocked.appendChild(this.recoveryInput);
    this.recoveryErr = errSlot();
    this.recoveryLocked.appendChild(this.recoveryErr);
    const btnRow = document.createElement('div');
    btnRow.className = 'mx-btns';
    this.recoveryUnlockBtn = pixelButton('Unlock', ['primary']);
    this.recoveryUnlockBtn.onclick = () => void this.onUnlock();
    const cancelBtn = pixelButton('Cancel', []);
    cancelBtn.onclick = () => this.onCancelUnlock();
    btnRow.append(this.recoveryUnlockBtn, cancelBtn);
    this.recoveryLocked.appendChild(btnRow);
    this.recoveryGroup.appendChild(this.recoveryLocked);

    this.recoveryReady = mutedLine('Recovery is set up and this device is unlocked.');
    this.recoveryReady.hidden = true;
    this.recoveryGroup.appendChild(this.recoveryReady);
  }

  private buildBackupGroup(): void {
    this.backupGroup.appendChild(groupLabel('KEY BACKUP'));
    this.backupChip = document.createElement('span');
    this.backupChip.className = 'mx-chip';
    this.backupGroup.appendChild(this.backupChip);
    const btnRow = document.createElement('div');
    btnRow.className = 'mx-btns';
    this.backupConnectBtn = pixelButton('Connect backup', []);
    this.backupConnectBtn.onclick = () => void this.onConnectBackup();
    this.backupRestoreBtn = pixelButton('Restore from backup', []);
    this.backupRestoreBtn.onclick = () => void this.onRestoreBackup();
    btnRow.append(this.backupConnectBtn, this.backupRestoreBtn);
    this.backupGroup.appendChild(btnRow);
    this.backupResult = mutedLine('');
    this.backupResult.hidden = true;
    this.backupGroup.appendChild(this.backupResult);
  }

  private buildKeyfileGroup(): void {
    this.body.appendChild(labelEl('Key file'));
    const fieldRow = document.createElement('div');
    fieldRow.className = 'mx-keyrow';
    this.keyfileField = pixelInput('text');
    this.keyfileField.readOnly = true;
    this.keyfileField.placeholder = '(none selected)';
    fieldRow.appendChild(this.keyfileField);
    this.body.appendChild(fieldRow);

    this.keyfilePicker = document.createElement('input');
    this.keyfilePicker.type = 'file';
    this.keyfilePicker.accept = '.txt,text/plain';
    this.keyfilePicker.hidden = true;
    this.keyfilePicker.onchange = () => void this.onKeyFileChosen();
    this.body.appendChild(this.keyfilePicker);

    const btnRow = document.createElement('div');
    btnRow.className = 'mx-btns';
    const chooseBtn = pixelButton('Choose file…', []);
    chooseBtn.onclick = () => this.keyfilePicker.click();
    const clearBtn = pixelButton('Clear', []);
    clearBtn.onclick = () => this.onClearKeyFile();
    btnRow.append(chooseBtn, clearBtn);
    this.body.appendChild(btnRow);

    this.body.appendChild(labelEl('Passphrase'));
    this.importPassInput = pixelInput('password');
    this.importPassInput.autocomplete = 'new-password';
    this.importPassInput.maxLength = 256;
    submitOnEnter(this.importPassInput, () => void this.onImportKeys());
    this.body.appendChild(this.importPassInput);

    this.importBtn = pixelButton('Import keys', ['primary', 'wide']);
    this.importBtn.onclick = () => void this.onImportKeys();
    this.body.appendChild(this.importBtn);

    this.body.appendChild(
      hintLine('Use the file Element exports with Settings → Encryption → Export room keys.'),
    );
    this.importErr = errSlot();
    this.body.appendChild(this.importErr);
    this.importResult = mutedLine('');
    this.importResult.hidden = true;
    this.body.appendChild(this.importResult);

    this.importGroupEls = [chooseBtn, clearBtn, this.importPassInput, this.importBtn];
  }

  private buildExportGroup(): void {
    this.body.appendChild(labelEl('Passphrase'));
    this.exportPassInput = pixelInput('password');
    this.exportPassInput.autocomplete = 'new-password';
    submitOnEnter(this.exportPassInput, () => void this.onExportKeys());
    this.body.appendChild(this.exportPassInput);

    this.body.appendChild(labelEl('Confirm'));
    this.exportConfirmInput = pixelInput('password');
    this.exportConfirmInput.autocomplete = 'new-password';
    submitOnEnter(this.exportConfirmInput, () => void this.onExportKeys());
    this.body.appendChild(this.exportConfirmInput);

    this.exportBtn = pixelButton('Export room keys', ['wide']);
    this.exportBtn.onclick = () => void this.onExportKeys();
    this.body.appendChild(this.exportBtn);

    this.body.appendChild(
      warnLine('Anyone with this file and its passphrase can read your encrypted messages.'),
    );
    this.exportErr = errSlot();
    this.body.appendChild(this.exportErr);
  }

  private buildDeviceGroup(): void {
    this.body.appendChild(labelEl('Device'));
    this.deviceIdField = pixelInput('text');
    this.deviceIdField.readOnly = true;
    this.body.appendChild(this.deviceIdField);

    this.body.appendChild(labelEl('Fingerprint'));
    // A <textarea>, not a single-line <input>: a fingerprint is compared visually, and an <input>
    // cannot wrap onto a second line no matter what CSS asks of it.
    this.fingerprintField = document.createElement('textarea');
    this.fingerprintField.readOnly = true;
    this.fingerprintField.rows = 2;
    this.fingerprintField.className = 'pa-input mx-fp';
    this.body.appendChild(this.fingerprintField);

    this.deviceChip = document.createElement('span');
    this.deviceChip.className = 'mx-chip';
    this.body.appendChild(this.deviceChip);

    this.deviceOwnerLine = mutedLine('');
    this.body.appendChild(this.deviceOwnerLine);

    const btnRow = document.createElement('div');
    btnRow.className = 'mx-btns';
    this.verifyBtn = pixelButton('Verify this device', ['primary']);
    this.verifyBtn.onclick = () => this.focusUnlock();
    const signOutBtn = pixelButton('Sign out', ['danger']);
    signOutBtn.onclick = () => this.onSignOut();
    btnRow.append(this.verifyBtn, signOutBtn);
    this.body.appendChild(btnRow);
  }

  // -------------------------------------------------------------- render

  render(): void {
    this.ensureCryptoBound();
    const state = this.hooks.cryptoState();

    this.renderStatusBanner(state);
    this.renderRecovery(state);
    this.renderBackup(state);
    this.renderKeyfileGroup(state);
    this.renderExportGroup(state);
    this.renderDeviceGroup(state);
    this.renderOtherDevices();
    this.verificationNote.hidden = !this.showVerificationNote;
  }

  private renderStatusBanner(state: MxCryptoState): void {
    this.statusBanner.replaceChildren();
    if (state === 'unavailable') {
      this.statusBanner.hidden = false;
      this.statusBanner.appendChild(
        errText("Encryption isn't available in this browser session — reload to try again."),
      );
    } else if (this.hooks.crypto()?.storage === 'memory') {
      this.statusBanner.hidden = false;
      this.statusBanner.appendChild(
        warnText("Encryption keys can't be saved on this device — you'll be asked to unlock again after a reload."),
      );
    } else {
      this.statusBanner.hidden = true;
    }
  }

  private renderRecovery(state: MxCryptoState): void {
    const disabled = state === 'unavailable';
    this.recoveryUnknown.hidden = state !== 'unknown';
    this.recoveryUnknownBusy = this.recoveryUnknownBusy && state === 'unknown';
    for (const btn of this.recoveryUnknown.querySelectorAll('button')) {
      (btn as HTMLButtonElement).disabled = this.recoveryUnknownBusy;
    }
    this.recoveryNeverSetup.hidden = !(state === 'never-set-up' && !this.revealedKey);
    // `!this.revealedKey` (not `=== null`) so a falsy-but-non-null value can never re-open this panel
    // — setUpRecovery() no longer produces one, but the guard costs nothing and matches the "never
    // silently show an empty box captioned as the only way back into your history" rule.
    this.recoveryReveal.hidden = !this.revealedKey;
    this.recoveryLocked.hidden = !(state === 'locked' || state === 'wrong-key' || state === 'unlocking');
    this.recoveryReady.hidden = state !== 'ready' || this.revealedKey !== null;
    this.backupGroup.hidden = state !== 'ready' || this.revealedKey !== null;

    if (this.revealedKey !== null) this.recoveryRevealInput.value = this.revealedKey;
    this.recoverySetupErrEl.hidden = !this.setupErr;
    if (this.setupErr) this.recoverySetupErrEl.textContent = this.setupErr;
    for (const btn of this.recoveryNeverSetup.querySelectorAll('button')) {
      (btn as HTMLButtonElement).disabled = disabled || this.setupBusy;
    }

    this.recoveryLabel.textContent = this.secretRequestHasPassphrase ? 'Recovery key or phrase' : 'Recovery key';
    const busy = this.unlockBusy || state === 'unlocking';
    this.recoveryInput.disabled = busy || disabled;
    this.recoveryUnlockBtn.disabled = busy || disabled;
    this.recoveryUnlockBtn.textContent = busy ? 'Checking…' : 'Unlock';

    this.recoveryErr.hidden = true;
    if (state === 'wrong-key') {
      this.recoveryErr.hidden = false;
      this.recoveryErr.textContent = "That recovery key or phrase didn't work.";
    } else if (this.localUnlockErr) {
      this.recoveryErr.hidden = false;
      this.recoveryErr.textContent = this.localUnlockErr;
    }
  }

  private renderBackup(state: MxCryptoState): void {
    if (state !== 'ready') return;
    const c = this.hooks.crypto();
    if (c && this.backupStatus === null && this.backupBusy === null) {
      this.backupBusy = 'status';
      c.backupStatus()
        .then((s) => {
          this.backupStatus = s;
        })
        .catch(() => {
          this.backupStatus = { version: null, active: false };
        })
        .finally(() => {
          this.backupBusy = this.backupBusy === 'status' ? null : this.backupBusy;
          this.render();
        });
    }
    const status = this.backupStatus;
    this.backupChip.className = status?.active ? 'mx-chip ok' : 'mx-chip warn';
    this.backupChip.textContent = status?.active
      ? status.version
        ? `Backup v${status.version} — active`
        : 'Backup active'
      : 'Not connected';
    this.backupConnectBtn.disabled = this.backupBusy !== null;
    this.backupRestoreBtn.disabled = this.backupBusy !== null || !status?.active;
    this.backupConnectBtn.textContent = this.backupBusy === 'connect' ? 'Connecting…' : 'Connect backup';
    if (this.backupBusy === 'restore') {
      this.backupRestoreBtn.textContent =
        this.importProgressPct === null ? 'Restoring…' : `Restoring… ${this.importProgressPct}%`;
    } else {
      this.backupRestoreBtn.textContent = 'Restore from backup';
    }
  }

  private renderKeyfileGroup(state: MxCryptoState): void {
    const disabled = state === 'unavailable' || this.importBusy;
    for (const el of this.importGroupEls) (el as HTMLButtonElement | HTMLInputElement).disabled = disabled;
    this.keyfileField.value = this.keyFileName ? `${this.keyFileName} (${formatKb(this.keyFileSize)})` : '';
    this.importBtn.textContent = this.importBusy
      ? this.importProgressPct === null
        ? 'Importing…'
        : `Importing… ${this.importProgressPct}%`
      : 'Import keys';
  }

  private renderExportGroup(state: MxCryptoState): void {
    const disabled = state === 'unavailable' || this.exportBusy;
    this.exportPassInput.disabled = disabled;
    this.exportConfirmInput.disabled = disabled;
    this.exportBtn.disabled = disabled;
    this.exportBtn.textContent = this.exportBusy ? 'Encrypting…' : 'Export room keys';
  }

  private renderDeviceGroup(state: MxCryptoState): void {
    this.deviceIdField.value = this.ownDevice?.deviceId ?? '';
    this.fingerprintField.value = this.ownDevice ? fmtFingerprint(this.ownDevice.ed25519) : '';
    const verified = !!this.ownDevice?.verified;
    this.deviceChip.className = verified ? 'mx-chip ok' : 'mx-chip warn';
    this.deviceChip.textContent = verified ? 'Verified ✓' : 'Not verified';
    this.deviceOwnerLine.textContent = `This device belongs to ${this.hooks.paUserId()}.`;
    this.verifyBtn.disabled = state === 'unavailable';

    const c = this.hooks.crypto();
    if (c && this.devicesFetchedFor !== c) {
      this.devicesFetchedFor = c;
      this.devicesLoaded = false;
      const ownDone = c.ownDevice().then((d) => {
        this.ownDevice = d;
      });
      const othersDone = c.otherDevices().then((list) => {
        this.otherDevices = list;
      });
      // Wait for BOTH before rendering: rendering after only otherDevices() resolves left the
      // Device/Fingerprint fields and the trust chip blank for a network round trip (ownDevice()
      // does two awaits; an account with no other devices needs only one), and — until this fetch
      // settles at all — showed "This is the only device on your account." on accounts that in fact
      // have several.
      void Promise.allSettled([ownDone, othersDone]).then(() => {
        this.devicesLoaded = true;
        this.render();
      });
    }
  }

  private renderOtherDevices(): void {
    this.otherDevicesLabel.textContent = `OTHER DEVICES (${this.otherDevices.length})`;
    this.otherDevicesList.replaceChildren();
    if (!this.devicesLoaded) {
      this.otherDevicesEmpty.hidden = false;
      this.otherDevicesEmpty.textContent = 'Loading devices…';
      return;
    }
    this.otherDevicesEmpty.textContent = 'This is the only device on your account.';
    this.otherDevicesEmpty.hidden = this.otherDevices.length > 0;
    for (const dev of this.otherDevices) {
      const row = document.createElement('div');
      row.className = 'pa-list-row';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = dev.displayName || dev.deviceId;
      const small = document.createElement('small');
      small.textContent = dev.deviceId;
      const chip = document.createElement('span');
      chip.className = dev.verified ? 'mx-chip ok' : 'mx-chip warn';
      chip.textContent = dev.verified ? 'Verified ✓' : 'Not verified';
      row.append(nm, small, chip);
      this.otherDevicesList.appendChild(row);
    }
  }

  // ------------------------------------------------------------- crypto binding

  private ensureCryptoBound(): void {
    const c = this.hooks.crypto();
    if (c === this.boundCrypto) return;
    for (const unsub of this.cryptoUnsubs) unsub();
    this.cryptoUnsubs = [];
    this.boundCrypto = c;
    this.backupStatus = null;
    this.devicesFetchedFor = null;
    this.devicesLoaded = false;
    if (!c) return;
    this.cryptoUnsubs.push(
      c.on('devices', () => {
        this.devicesFetchedFor = null;
        this.render();
      }),
    );
    // The three-key `on()` contract we were given doesn't name a verification-
    // request event; crypto.ts may still emit one at runtime (SAS requests
    // are out of scope but we surface the fact one arrived, per design doc
    // §5.7). Guarded behind a runtime cast so it degrades to "never fires"
    // rather than a type error if the event name differs or never exists.
    const onAny = c.on as unknown as (k: string, fn: (payload: unknown) => void) => () => void;
    try {
      this.cryptoUnsubs.push(
        onAny('verificationRequest', () => {
          this.showVerificationNote = true;
          this.hooks.toast(
            "Another device asked to verify. This client can't do emoji verification yet — unlock with your recovery key instead.",
          );
          this.render();
        }),
      );
    } catch {
      // no such event; the muted line simply never appears.
    }
  }

  // ------------------------------------------------------------- actions

  private async onSetUpRecovery(): Promise<void> {
    const c = this.hooks.crypto();
    if (!c) return;
    this.setupBusy = true;
    this.setupErr = null;
    this.render();
    try {
      const result = await c.setUpRecovery(this.hooks.askPassword);
      if (result.kind === 'already-set-up') {
        // The account already has 4S; bootstrapSecretStorage() correctly left it untouched instead of
        // generating a second key. Drop into the unlock flow instead of showing an empty reveal panel
        // captioned "the only way back into your encrypted history" — that would be a lie twice over.
        await c.refresh();
        this.hooks.toast('Recovery is already set up on this account — unlock it below.');
        this.focusUnlock();
      } else {
        this.revealedKey = result.key;
      }
    } catch (e) {
      this.setupErr = describeError(e, hostFromMxid(this.hooks.myUserId()));
    } finally {
      this.setupBusy = false;
      this.render();
    }
  }

  private onRecoverySaved(): void {
    this.recoveryRevealInput.value = '';
    this.revealedKey = null;
    this.hooks.onChanged();
    this.render();
  }

  private async onUnlock(): Promise<void> {
    const c = this.hooks.crypto();
    const value = this.recoveryInput.value;
    this.recoveryInput.value = '';
    if (!c || !value) return;
    this.localUnlockErr = null;
    this.unlockBusy = true;
    this.render();
    try {
      const result = await c.unlock(value);
      if (result === 'ok') {
        this.hooks.onChanged();
      } else if (result === 'no-passphrase') {
        this.localUnlockErr = 'This account uses a recovery key, not a phrase.';
      } else if (result === 'error') {
        // A local state/derivation problem, not a homeserver one — routing this through
        // describeError() would mislabel it as a network/CORS failure (MatrixError.from() maps any
        // plain Error to status 0 -> "Could not reach `<host>`...").
        this.localUnlockErr = "Couldn't check that key — try again.";
      }
      // 'wrong-key': the crypto store's own cryptoState() now reports
      // 'wrong-key'; renderRecovery() shows the built-in message for it.
    } catch (e) {
      this.localUnlockErr = describeError(e, hostFromMxid(this.hooks.myUserId()));
    } finally {
      this.unlockBusy = false;
      this.render();
      this.recoveryInput.focus();
    }
  }

  private onRetryRecoveryCheck(): void {
    const c = this.hooks.crypto();
    if (!c || this.recoveryUnknownBusy) return;
    this.recoveryUnknownBusy = true;
    this.render();
    void c.refresh().finally(() => {
      this.recoveryUnknownBusy = false;
      this.render();
    });
  }

  private onCancelUnlock(): void {
    this.hooks.crypto()?.cancelUnlock();
    this.localUnlockErr = null;
    this.recoveryInput.value = '';
    this.render();
  }

  private async onConnectBackup(): Promise<void> {
    const c = this.hooks.crypto();
    if (!c || this.backupBusy) return;
    this.backupBusy = 'connect';
    this.render();
    try {
      await c.connectBackup();
      this.backupStatus = await c.backupStatus();
    } catch (e) {
      this.hooks.toast(describeError(e, hostFromMxid(this.hooks.myUserId())));
    } finally {
      this.backupBusy = null;
      this.render();
    }
  }

  private async onRestoreBackup(): Promise<void> {
    const c = this.hooks.crypto();
    if (!c || this.backupBusy) return;
    this.backupBusy = 'restore';
    this.importProgressPct = null;
    this.backupResult.hidden = true;
    this.render();
    try {
      const { total, imported } = await c.restoreBackup((pct) => {
        this.importProgressPct = pct;
        this.render();
      });
      this.backupResult.hidden = false;
      this.backupResult.textContent = `Restored ${imported} of ${total} keys.`;
    } catch (e) {
      this.hooks.toast(describeError(e, hostFromMxid(this.hooks.myUserId())));
    } finally {
      this.backupBusy = null;
      this.importProgressPct = null;
      this.render();
    }
  }

  private async onKeyFileChosen(): Promise<void> {
    const file = this.keyfilePicker.files?.[0] ?? null;
    this.keyfilePicker.value = '';
    if (!file) return;
    this.importErr.hidden = true;
    if (file.size > MAX_KEYFILE_BYTES) {
      this.importErr.hidden = false;
      this.importErr.textContent = 'That file is too large to be a key export.';
      return;
    }
    const text = await file.text();
    this.keyFileText = text;
    this.keyFileName = file.name;
    this.keyFileSize = file.size;
    this.render();
  }

  private onClearKeyFile(): void {
    this.keyFileText = null;
    this.keyFileName = '';
    this.keyFileSize = 0;
    this.importPassInput.value = '';
    this.importErr.hidden = true;
    this.importResult.hidden = true;
    this.render();
  }

  private async onImportKeys(): Promise<void> {
    const c = this.hooks.crypto();
    this.importErr.hidden = true;
    this.importResult.hidden = true;
    if (!c) return;
    if (!this.keyFileText) {
      this.importErr.hidden = false;
      this.importErr.textContent = 'Choose a key file first.';
      return;
    }
    const passphrase = this.importPassInput.value;
    let json: string;
    try {
      try {
        json = await decryptKeyFile(this.keyFileText, passphrase);
      } finally {
        this.importPassInput.value = '';
      }
    } catch (e) {
      this.importErr.hidden = false;
      this.importErr.textContent = describeKeyFileError(e, this.hooks.myUserId());
      this.render();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      this.importErr.hidden = false;
      this.importErr.textContent = 'That file is damaged.';
      this.render();
      return;
    }
    if (Array.isArray(parsed) && parsed.length === 0) {
      this.importResult.hidden = false;
      this.importResult.textContent = 'The file contained no keys.';
      this.render();
      return;
    }

    this.importBusy = true;
    this.importProgressPct = null;
    this.render();
    try {
      const result: MxKeyImportResult = await c.importRoomKeys(json, (pct) => {
        this.importProgressPct = pct;
        this.render();
      });
      this.importResult.hidden = false;
      this.importResult.textContent = `${describeImportResult(result)} Older messages should now be readable.`;
    } catch (e) {
      this.importErr.hidden = false;
      this.importErr.textContent = describeError(e, hostFromMxid(this.hooks.myUserId()));
    } finally {
      this.importBusy = false;
      this.importProgressPct = null;
      this.render();
    }
  }

  private async onExportKeys(): Promise<void> {
    const p1 = this.exportPassInput.value;
    const p2 = this.exportConfirmInput.value;
    this.exportErr.hidden = true;
    if (!p1 || !p2) {
      this.exportErr.hidden = false;
      this.exportErr.textContent = 'Enter a passphrase.';
      return;
    }
    if (p1.length < 8) {
      this.exportErr.hidden = false;
      this.exportErr.textContent = 'Passphrase must be at least 8 characters.';
      return;
    }
    if (p1 !== p2) {
      this.exportErr.hidden = false;
      this.exportErr.textContent = "Passphrases don't match.";
      return;
    }
    const c = this.hooks.crypto();
    if (!c) return;
    this.exportBusy = true;
    this.render();
    let url: string | null = null;
    try {
      const json = await c.exportRoomKeys();
      const text = await encryptKeyFile(json, p1);
      const blob = new Blob([text], { type: 'text/plain' });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildExportFilename(this.hooks.myUserId());
      document.body.appendChild(a);
      a.click();
      a.remove();
      this.hooks.toast('Exported room keys.');
    } catch (e) {
      this.exportErr.hidden = false;
      this.exportErr.textContent = describeError(e, hostFromMxid(this.hooks.myUserId()));
    } finally {
      // Blanked here, not inside the try — a throw from exportRoomKeys()/encryptKeyFile() (crypto
      // detached, OOM on a large export, a WebCrypto failure) must not leave either passphrase
      // sitting in a live DOM input for the rest of the session (§8.1's "blanked at the earliest
      // safe moment").
      this.exportPassInput.value = '';
      this.exportConfirmInput.value = '';
      const releaseUrl = url;
      if (releaseUrl) setTimeout(() => URL.revokeObjectURL(releaseUrl), 0);
      this.exportBusy = false;
      this.render();
    }
  }

  private onSignOut(): void {
    // MatrixUI.handleSignOut owns the confirmation dialog (the panel's top-strip sign-out button goes
    // through the same method) — asking twice for the one destructive action in this view trains
    // users to click through both and makes the copy that actually governs ambiguous.
    this.hooks.onSignOut();
  }

  // ------------------------------------------------------------- handle members

  focusUnlock(): void {
    if (this.recoveryLocked.hidden) return;
    this.recoveryLocked.scrollIntoView({ block: 'nearest' });
    this.recoveryInput.focus();
  }

  noteSecretRequest(req: MxSecretRequest): void {
    this.secretRequestHasPassphrase = req.hasPassphrase;
    this.render();
    this.focusUnlock();
  }

  destroy(): void {
    for (const unsub of this.cryptoUnsubs) unsub();
    this.cryptoUnsubs = [];
    this.boundCrypto = null;
    this.recoveryInput.value = '';
    this.recoveryRevealInput.value = '';
    this.importPassInput.value = '';
    this.exportPassInput.value = '';
    this.exportConfirmInput.value = '';
    this.revealedKey = null;
  }
}

// ---------------------------------------------------------------- DOM helpers

function groupLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'grouplbl';
  el.textContent = text;
  return el;
}

function mutedLine(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'muted';
  el.textContent = text;
  return el;
}

function labelEl(text: string): HTMLElement {
  const el = document.createElement('label');
  el.textContent = text;
  el.className = 'mx-lbl';
  return el;
}

function warnLine(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mx-warn';
  el.textContent = text;
  return el;
}

function hintLine(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mx-hint';
  el.textContent = text;
  return el;
}

function errSlot(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mx-err';
  el.hidden = true;
  return el;
}

function errText(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mx-err';
  el.textContent = text;
  return el;
}

function warnText(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mx-warn';
  el.textContent = text;
  return el;
}

/** Mirrors the login/join views' own Enter-to-submit wiring (MatrixUI.ts) — without this, the four
 *  highest-friction inputs in the feature (a 48-char recovery key, three passphrases) are mouse-only. */
function submitOnEnter(el: HTMLInputElement, fn: () => void): void {
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    ev.stopPropagation();
    fn();
  });
}

function pixelInput(type: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  el.className = 'pa-input';
  return el;
}

function pixelButton(text: string, mods: Array<'primary' | 'danger' | 'wide'>): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = text;
  el.className = ['pa-b', ...mods].join(' ');
  return el;
}

// ------------------------------------------------------------- pure helpers

function fmtFingerprint(fp: string): string {
  const groups: string[] = [];
  for (let i = 0; i < fp.length; i += 4) groups.push(fp.slice(i, i + 4));
  return groups.join(' ');
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function hostFromMxid(mxid: string): string {
  const idx = mxid.indexOf(':');
  return idx >= 0 ? mxid.slice(idx + 1) : mxid;
}

function localpartOf(mxid: string): string {
  const withoutSigil = mxid.startsWith('@') ? mxid.slice(1) : mxid;
  const idx = withoutSigil.indexOf(':');
  return idx >= 0 ? withoutSigil.slice(0, idx) : withoutSigil;
}

function buildExportFilename(mxid: string): string {
  const local = localpartOf(mxid)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
  const date = new Date().toISOString().slice(0, 10);
  return `pixel-agents-matrix-keys-${local || 'user'}-${date}.txt`;
}

function describeImportResult(result: MxKeyImportResult): string {
  if (result.counted === false) return 'Imported keys.';
  if (result.failures === 0) return `Imported ${result.imported} keys.`;
  return `Imported ${result.imported} of ${result.total} keys — ${result.failures} could not be read.`;
}

function describeKeyFileError(e: unknown, mxid: string): string {
  if (e instanceof KeyFileError) {
    switch (e.kind) {
      case 'bad-passphrase':
        return "That passphrase didn't open the file.";
      case 'not-a-key-file':
        return "That doesn't look like an Element room-key export.";
      case 'corrupt':
        return 'That file is damaged.';
    }
  }
  return describeError(e, hostFromMxid(mxid));
}

async function copyToClipboard(text: string, hooks: EncryptionViewHooks): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    hooks.toast('Copied.');
  } catch {
    hooks.toast('Could not copy — select and copy manually.');
  }
}
