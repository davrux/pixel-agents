import { useEffect, useState } from 'react';

import {
  getAlertVolume,
  isSoundEnabled,
  playDoneSound,
  setAlertVolume,
  setSoundEnabled,
} from '../notificationSound.js';
import { transport } from '../transport/index.js';
import { getViewerUsername, setSettingsUsername } from '../viewerIdentity.js';
import { Checkbox } from './ui/Checkbox.js';
import { Modal } from './ui/Modal.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
}

const MAX_USERNAME = 16;

/** Printable ASCII only, trimmed, capped — mirrors the server-side sanitizer. */
function sanitizeUsername(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[^\x21-\x7e]/g, '').slice(0, MAX_USERNAME);
}

export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const [volumeLocal, setVolumeLocal] = useState(getAlertVolume);
  const [username, setUsername] = useState(getViewerUsername);

  // Re-sync the fields from current state each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setUsername(getViewerUsername());
      setVolumeLocal(getAlertVolume());
      setSoundLocal(isSoundEnabled());
    }
  }, [isOpen]);

  const commitVolume = (value: number) => {
    setVolumeLocal(value);
    setAlertVolume(value);
    transport.send({ type: 'setAlertVolume', volume: value });
  };

  const commitUsername = () => {
    const clean = sanitizeUsername(username);
    if (clean !== username) setUsername(clean);
    if (clean === getViewerUsername()) return;
    setSettingsUsername(clean);
    transport.send({ type: 'setUsername', username: clean });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings">
      <Checkbox
        label="Sound Notifications"
        checked={soundLocal}
        onChange={() => {
          const newVal = !isSoundEnabled();
          setSoundEnabled(newVal);
          setSoundLocal(newVal);
          transport.send({ type: 'setSoundEnabled', enabled: newVal });
        }}
      />

      <div className="flex flex-col gap-1">
        <label htmlFor="settings-volume" className="text-text text-sm">
          Alert Volume
        </label>
        <div className="flex items-center gap-3">
          <input
            id="settings-volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volumeLocal}
            disabled={!soundLocal}
            onChange={(e) => commitVolume(Number(e.target.value))}
            onPointerUp={() => soundLocal && playDoneSound()}
            className="flex-1 accent-text disabled:opacity-40"
          />
          <span className="text-text-muted text-xs w-9 text-right tabular-nums">
            {Math.round(volumeLocal * 100)}%
          </span>
        </div>
      </div>

      <Checkbox
        label="Always Show Labels"
        checked={alwaysShowOverlay}
        onChange={onToggleAlwaysShowOverlay}
      />
      <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />

      <div className="flex flex-col gap-1">
        <label htmlFor="settings-username" className="text-text text-sm">
          Username
        </label>
        <input
          id="settings-username"
          type="text"
          value={username}
          maxLength={MAX_USERNAME}
          placeholder="Your name"
          onChange={(e) => setUsername(e.target.value)}
          onBlur={commitUsername}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitUsername();
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="bg-btn-bg border-2 border-border rounded-none px-4 py-2 text-text"
        />
        <span className="text-text-muted text-xs">
          Task sounds play only for agents matching this name. Leave empty to hear all.
        </span>
      </div>
    </Modal>
  );
}
