import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILE_NAME, LAYOUT_FILE_DIR } from './constants.js';

export interface AdapterSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  hooksInfoShown: boolean;
}

/** All keys in AdapterSettings. Used by the adapter to map `pixel-agents.foo` → `foo`. */
export const ADAPTER_SETTING_KEYS = [
  'soundEnabled',
  'lastSeenVersion',
  'alwaysShowLabels',
  'hooksInfoShown',
] as const;

export type AdapterSettingKey = (typeof ADAPTER_SETTING_KEYS)[number];

/** Adapter identity / section within config.json. */
export type ConfigNamespace = 'standalone';

export interface PixelAgentsConfig {
  standalone: AdapterSettings;
}

const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  hooksInfoShown: false,
};

function getConfigFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
}

/** Coerce a loose object into a valid AdapterSettings with defaults for missing/wrong-typed fields. */
function parseAdapterSettings(raw: unknown): AdapterSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AdapterSettings>;
  return {
    soundEnabled:
      typeof obj.soundEnabled === 'boolean'
        ? obj.soundEnabled
        : DEFAULT_ADAPTER_SETTINGS.soundEnabled,
    lastSeenVersion:
      typeof obj.lastSeenVersion === 'string'
        ? obj.lastSeenVersion
        : DEFAULT_ADAPTER_SETTINGS.lastSeenVersion,
    alwaysShowLabels:
      typeof obj.alwaysShowLabels === 'boolean'
        ? obj.alwaysShowLabels
        : DEFAULT_ADAPTER_SETTINGS.alwaysShowLabels,
    hooksInfoShown:
      typeof obj.hooksInfoShown === 'boolean'
        ? obj.hooksInfoShown
        : DEFAULT_ADAPTER_SETTINGS.hooksInfoShown,
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
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(config, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[Pixel Agents] Failed to write config file:', err);
  }
}
