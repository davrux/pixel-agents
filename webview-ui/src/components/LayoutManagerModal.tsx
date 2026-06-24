import { useState } from 'react';

import type { LayoutListItem } from '../hooks/useExtensionMessages.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface LayoutManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  layouts: LayoutListItem[];
  active: string;
  /** True when the current canvas has unsaved edits (warn before switching away). */
  isDirty: boolean;
  /** Snapshot of the current canvas layout, for "new from current". */
  getCurrentLayout: () => Record<string, unknown>;
}

const MAX_NAME = 40;

/** A name is valid when it is 1..40 printable chars and not the reserved Default. */
function isValidName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= MAX_NAME && n !== 'Default';
}

export function LayoutManagerModal({
  isOpen,
  onClose,
  layouts,
  active,
  isDirty,
  getCurrentLayout,
}: LayoutManagerModalProps) {
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = (name: string): void => {
    if (name === active) return;
    if (isDirty && !window.confirm('Discard unsaved layout changes and switch layout?')) return;
    transport.send({ type: 'loadLayout', name });
    onClose();
  };

  const saveAsNew = (): void => {
    const name = newName.trim();
    if (!isValidName(name)) return;
    transport.send({ type: 'saveLayoutAs', name, layout: getCurrentLayout() });
    setNewName('');
  };

  const confirmDelete = (name: string): void => {
    transport.send({ type: 'deleteLayout', name });
    setPendingDelete(null);
  };

  const nameTaken = layouts.some((l) => l.name.toLowerCase() === newName.trim().toLowerCase());

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Layouts" className="min-w-2xl">
      <div className="flex flex-col gap-2 max-h-96 overflow-y-auto px-2">
        {layouts.map((l) => {
          const isActive = l.name === active;
          return (
            <div
              key={l.name}
              className={`flex items-center gap-4 p-2 border-2 ${
                isActive ? 'border-accent bg-active-bg' : 'border-transparent'
              }`}
            >
              <button
                className="flex-1 text-left cursor-pointer bg-transparent border-0 text-text"
                onClick={() => load(l.name)}
                title={isActive ? 'Current layout' : 'Load this layout'}
                disabled={isActive}
              >
                <span className="text-lg">{l.name}</span>
                {l.readOnly && <span className="ml-4 text-2xs text-text-muted">read-only</span>}
                {isActive && <span className="ml-4 text-2xs text-accent-bright">active</span>}
              </button>
              {!isActive && (
                <Button variant="default" size="sm" onClick={() => load(l.name)}>
                  Load
                </Button>
              )}
              {!l.readOnly &&
                (pendingDelete === l.name ? (
                  <>
                    <span className="text-sm text-reset-text">Delete?</span>
                    <Button
                      variant="default"
                      size="sm"
                      className="bg-danger text-white"
                      onClick={() => confirmDelete(l.name)}
                    >
                      Yes
                    </Button>
                    <Button variant="default" size="sm" onClick={() => setPendingDelete(null)}>
                      No
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Delete layout"
                    onClick={() => setPendingDelete(l.name)}
                  >
                    x
                  </Button>
                ))}
            </div>
          );
        })}
      </div>

      <div className="border-t border-border mt-4 pt-4 px-2">
        <div className="text-sm text-text-muted mb-2">New from current layout</div>
        <div className="flex items-center gap-4">
          <input
            type="text"
            value={newName}
            maxLength={MAX_NAME}
            placeholder="Layout name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveAsNew();
            }}
            className="flex-1 bg-btn-bg border-2 border-border rounded-none px-4 py-2 text-text"
          />
          <Button
            variant={isValidName(newName) ? 'accent' : 'disabled'}
            size="md"
            onClick={isValidName(newName) ? saveAsNew : undefined}
            title="Save the current canvas as a new layout"
          >
            {nameTaken ? 'Overwrite' : 'Create'}
          </Button>
        </div>
        <div className="text-2xs text-text-muted mt-2">
          The Default layout is read-only — save a copy here to keep your changes.
        </div>
      </div>
    </Modal>
  );
}
