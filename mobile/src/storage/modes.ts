// src/storage/modes.ts
// NOTE: App.tsx is the source of truth for modes at runtime.
// This file is used only by commandEngine.ts for non-React contexts (if ever needed).
// In practice, mode state is managed entirely in App.tsx via React state + refs.

import RNFS from 'react-native-fs';

const MODES_PATH = `${RNFS.DocumentDirectoryPath}/clawdaddy.modes.json`;

export interface Mode {
  id: string;
  name: string;
  systemPrompt: string;
  icon?: string;
  /** If true, this mode cannot be edited or deleted by the client. */
  locked?: boolean;
}

// Builtin modes — always present, never persisted (they're code-defined)
export const BUILTIN_MODES: Mode[] = [
  {
    id: 'default',
    name: 'Default',
    systemPrompt: 'You are a helpful assistant.',
    icon: '🏮',
    locked: true,
  },
  {
    id: 'crabby',
    name: 'Crabby Bot',
    systemPrompt: "You are Clawdaddy, a grumpy but helpful crab. You're easily annoyed and use crab puns. Keep it snappy.",
    icon: '🦀',
  },
];

/**
 * Returns builtins merged with any user-created modes saved on disk.
 * Builtins always take precedence — a saved mode with the same id as a builtin is ignored.
 */
export const getModes = async (): Promise<Mode[]> => {
  const builtinIds = new Set(BUILTIN_MODES.map(m => m.id));

  if (!(await RNFS.exists(MODES_PATH))) {
    return BUILTIN_MODES;
  }

  const saved: Mode[] = JSON.parse(await RNFS.readFile(MODES_PATH));
  const userModes = saved.filter(m => !builtinIds.has(m.id));
  return [...BUILTIN_MODES, ...userModes];
};

/**
 * Saves a user-created or user-edited mode.
 * Throws if the mode is locked (builtin).
 */
export const saveMode = async (mode: Mode) => {
  const builtinIds = new Set(BUILTIN_MODES.map(m => m.id));
  if (builtinIds.has(mode.id)) {
    throw new Error(`Mode "${mode.id}" is locked and cannot be edited.`);
  }

  // Load only the user modes file (not builtins — they're not on disk)
  let userModes: Mode[] = [];
  if (await RNFS.exists(MODES_PATH)) {
    userModes = JSON.parse(await RNFS.readFile(MODES_PATH));
  }

  const index = userModes.findIndex(m => m.id === mode.id);
  if (index > -1) userModes[index] = mode;
  else userModes.push(mode);

  await RNFS.writeFile(MODES_PATH, JSON.stringify(userModes));
};

/**
 * Deletes a user-created mode by id.
 * Throws if the mode is locked (builtin) or doesn't exist.
 */
export const deleteMode = async (id: string) => {
  const builtinIds = new Set(BUILTIN_MODES.map(m => m.id));
  if (builtinIds.has(id)) {
    throw new Error(`Mode "${id}" is locked and cannot be deleted.`);
  }

  let userModes: Mode[] = [];
  if (await RNFS.exists(MODES_PATH)) {
    userModes = JSON.parse(await RNFS.readFile(MODES_PATH));
  }

  const filtered = userModes.filter(m => m.id !== id);
  await RNFS.writeFile(MODES_PATH, JSON.stringify(filtered));
};