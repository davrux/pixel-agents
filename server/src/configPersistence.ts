import * as fs from 'fs';

import { CONFIG_FILE_NAME } from './constants.js';
import { dataPath } from './paths.js';

export interface AdapterSettings {
  soundEnabled: boolean;
  alwaysShowLabels: boolean;
  /** Viewer username for per-user sound filtering ('' = unset). */
  username: string;
}

/** All keys in AdapterSettings. Used by the adapter to map `pixel-agents.foo` → `foo`. */
export const ADAPTER_SETTING_KEYS = ['soundEnabled', 'alwaysShowLabels', 'username'] as const;

export type AdapterSettingKey = (typeof ADAPTER_SETTING_KEYS)[number];

/** Adapter identity / section within config.json. */
export type ConfigNamespace = 'standalone';

export interface PixelAgentsConfig {
  standalone: AdapterSettings;
}

const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  soundEnabled: true,
  alwaysShowLabels: false,
  username: '',
};

function getConfigFilePath(): string {
  return dataPath(CONFIG_FILE_NAME);
}

/** Coerce a loose object into a valid AdapterSettings with defaults for missing/wrong-typed fields. */
function parseAdapterSettings(raw: unknown): AdapterSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AdapterSettings>;
  return {
    soundEnabled:
      typeof obj.soundEnabled === 'boolean'
        ? obj.soundEnabled
        : DEFAULT_ADAPTER_SETTINGS.soundEnabled,
    alwaysShowLabels:
      typeof obj.alwaysShowLabels === 'boolean'
        ? obj.alwaysShowLabels
        : DEFAULT_ADAPTER_SETTINGS.alwaysShowLabels,
    username:
      typeof obj.username === 'string'
        ? obj.username.slice(0, 16)
        : DEFAULT_ADAPTER_SETTINGS.username,
  };
}

export function readConfig(): PixelAgentsConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return { standalone: { ...DEFAULT_ADAPTER_SETTINGS } };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PixelAgentsConfig>;
    return { standalone: parseAdapterSettings(parsed.standalone) };
  } catch (err) {
    console.error('[Pixel Agents] Failed to read config file:', err);
    return { standalone: { ...DEFAULT_ADAPTER_SETTINGS } };
  }
}

export function writeConfig(config: PixelAgentsConfig): void {
  const filePath = getConfigFilePath(); // dataPath() ensures the directory exists
  try {
    const json = JSON.stringify(config, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[Pixel Agents] Failed to write config file:', err);
  }
}
