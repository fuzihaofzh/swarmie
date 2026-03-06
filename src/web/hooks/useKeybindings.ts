import { create } from 'zustand';

export interface KeyBinding {
  code: string;       // e.code: "BracketLeft", "KeyF", "ArrowLeft", etc.
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type ActionId =
  | 'tab-switcher'
  | 'tab-switcher-prev'
  | 'search'
  | 'new-line';

export const ACTION_LABELS: Record<ActionId, string> = {
  'tab-switcher': 'Switch Tab (Next)',
  'tab-switcher-prev': 'Switch Tab (Prev)',
  'search': 'Search in Terminal',
  'new-line': 'New Line (Shift+Enter)',
};

export const DEFAULT_BINDINGS: Record<ActionId, KeyBinding> = {
  'tab-switcher':      { code: 'BracketLeft', alt: true },
  'tab-switcher-prev': { code: 'BracketLeft', alt: true, shift: true },
  'search':            { code: 'KeyF', meta: true, shift: true },
  'new-line':          { code: 'Enter', shift: true },
};

const STORAGE_KEY = 'swarmie-keybindings';

function loadBindings(): Record<string, KeyBinding> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveBindings(overrides: Record<string, KeyBinding>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

interface KeybindingStore {
  /** User overrides only (sparse) */
  overrides: Record<string, KeyBinding>;
  /** Get effective binding for an action */
  getBinding: (action: ActionId) => KeyBinding;
  /** Set a custom binding */
  setBinding: (action: ActionId, binding: KeyBinding) => void;
  /** Reset an action to default */
  resetBinding: (action: ActionId) => void;
  /** Reset all to defaults */
  resetAll: () => void;
}

export const useKeybindingStore = create<KeybindingStore>((set, get) => ({
  overrides: loadBindings(),

  getBinding: (action) => {
    return get().overrides[action] ?? DEFAULT_BINDINGS[action];
  },

  setBinding: (action, binding) => {
    const overrides = { ...get().overrides, [action]: binding };
    saveBindings(overrides);
    set({ overrides });
  },

  resetBinding: (action) => {
    const overrides = { ...get().overrides };
    delete overrides[action];
    saveBindings(overrides);
    set({ overrides });
  },

  resetAll: () => {
    localStorage.removeItem(STORAGE_KEY);
    set({ overrides: {} });
  },
}));

/** Check if a KeyboardEvent matches a binding */
export function matchesBinding(e: KeyboardEvent, binding: KeyBinding): boolean {
  if (e.code !== binding.code) return false;
  if (!!binding.alt !== e.altKey) return false;
  if (!!binding.ctrl !== e.ctrlKey) return false;
  if (!!binding.meta !== e.metaKey) return false;
  if (!!binding.shift !== e.shiftKey) return false;
  return true;
}

/** Check if a KeyboardEvent matches a named action */
export function matchesAction(e: KeyboardEvent, action: ActionId): boolean {
  const binding = useKeybindingStore.getState().getBinding(action);
  return matchesBinding(e, binding);
}

/** Format a KeyBinding for display */
export function formatBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  if (binding.meta) parts.push('Cmd');

  // Friendly names for common codes
  const codeLabels: Record<string, string> = {
    BracketLeft: '[', BracketRight: ']',
    Backquote: '`', Minus: '-', Equal: '=',
    Comma: ',', Period: '.', Slash: '/',
    Semicolon: ';', Quote: "'", Backslash: '\\',
    ArrowLeft: 'Left', ArrowRight: 'Right',
    ArrowUp: 'Up', ArrowDown: 'Down',
    Enter: 'Enter', Space: 'Space',
    Backspace: 'Backspace', Tab: 'Tab',
    Escape: 'Esc',
  };

  let keyLabel = codeLabels[binding.code] ?? binding.code;
  const keyMatch = binding.code.match(/^Key([A-Z])$/);
  if (keyMatch) keyLabel = keyMatch[1];
  const digitMatch = binding.code.match(/^Digit([0-9])$/);
  if (digitMatch) keyLabel = digitMatch[1];

  parts.push(keyLabel);
  return parts.join('+');
}
