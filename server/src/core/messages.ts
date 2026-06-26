/**
 * WebSocket message protocol between the server and the webview.
 *
 * Hand-maintained TypeScript definitions (previously generated from an AsyncAPI
 * spec; that tooling was removed). Edit these types directly.
 */

export type ServerMessage =
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | AgentSelected
  | ExistingAgents
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | SubagentToolStart
  | SubagentToolDone
  | SubagentClear
  | SubagentToolPermission
  | AgentTeamInfo
  | AgentTokenUsage
  | LayoutLoaded
  | LayoutList
  | FurnitureAssetsLoaded
  | CharacterSpritesLoaded
  | PetSpritesLoaded
  | FloorTilesLoaded
  | WallTilesLoaded
  | SettingsLoaded
  | WorkspaceFolders
  | ViewerIdentity
  | AgentDiagnostics;

export type ClientMessage =
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SaveLayoutAs
  | LoadLayout
  | DeleteLayout
  | RequestLayouts
  | SetSoundEnabled
  | SetAlwaysShowLabels
  | SetAlertVolume
  | SetUsername
  | RequestDiagnostics;

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  id: number;
  folderName?: string;
  isExternal?: boolean;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  folderNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
}

export interface AgentSeatMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
}

export type AgentActivityStatus = 'active' | 'waiting';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  permissionActive?: boolean;
  runInBackground?: boolean;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface SubagentToolStart {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
}

export interface SubagentToolDone {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClear {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
}

export interface SubagentToolPermission {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
}

export interface AgentTeamInfo {
  type: 'agentTeamInfo';
  id: number;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface AgentTokenUsage {
  type: 'agentTokenUsage';
  id: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
  /** Name of the layout this data belongs to (active layout). */
  activeLayout?: string;
  /** When true, the webview replaces the layout even if the editor has unsaved
   *  changes (used for explicit user actions: load / save-as / delete). */
  force?: boolean;
}

/** One entry in the layout manager's list. */
export interface LayoutListItem {
  name: string;
  updatedAt: number;
  readOnly: boolean;
}

/** Server -> webview: the full set of saved layouts and which one is active. */
export interface LayoutList {
  type: 'layoutList';
  layouts: LayoutListItem[];
  active: string;
}

export interface FurnitureAssetsLoaded {
  type: 'furnitureAssetsLoaded';
  catalog: FurnitureAssetMessage[];
  sprites: Record<string, string[][]>;
}

export interface FurnitureAssetMessage {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface CharacterSpritesLoaded {
  type: 'characterSpritesLoaded';
  characters: CharacterSpriteSet[];
}

export interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface PetSpritesLoaded {
  type: 'petSpritesLoaded';
  dogs: PetSpriteSet[];
  cats: PetSpriteSet[];
  ducks: PetSpriteSet[];
}

export interface PetSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface FloorTilesLoaded {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoaded {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  soundEnabled: boolean;
  alwaysShowLabels: boolean;
  /** Master alert volume multiplier (0..1). */
  alertVolume: number;
  /** Persisted viewer username (empty string when unset). Used for per-user sound filtering. */
  username: string;
}

export interface WorkspaceFolders {
  type: 'workspaceFolders';
  folders: WorkspaceFolder[];
}

/** Server -> webview: the username this viewer logged in as (standalone auth).
 *  Undefined when no username was chosen (or in embedded mode); the webview then
 *  plays task sounds for all agents. When set, sounds play only for matching agents. */
export interface ViewerIdentity {
  type: 'viewerIdentity';
  username?: string;
}

export interface WorkspaceFolder {
  name: string;
  path: string;
}

export interface AgentDiagnostics {
  type: 'agentDiagnostics';
  agents: Record<string, any>[];
}

export interface WebviewReady {
  type: 'webviewReady';
}

export interface LaunchAgent {
  type: 'launchAgent';
  folderPath?: string;
  bypassPermissions?: boolean;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SaveAgentSeats {
  type: 'saveAgentSeats';
  seats: Record<string, SeatAssignment>;
}

export interface SeatAssignment {
  palette: number;
  hueShift: number;
  seatId: string | null;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
}

/** Save the current canvas as a new (or overwritten) named layout. */
export interface SaveLayoutAs {
  type: 'saveLayoutAs';
  name: string;
  layout: Record<string, any>;
}

/** Switch the active layout to an existing one (or the read-only Default). */
export interface LoadLayout {
  type: 'loadLayout';
  name: string;
}

/** Delete a named layout (the Default cannot be deleted). */
export interface DeleteLayout {
  type: 'deleteLayout';
  name: string;
}

/** Ask the server to (re)send the current layoutList. */
export interface RequestLayouts {
  type: 'requestLayouts';
}

export interface SetSoundEnabled {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export interface SetAlwaysShowLabels {
  type: 'setAlwaysShowLabels';
  enabled: boolean;
}

/** Webview -> server: change the persisted master alert volume (0..1). */
export interface SetAlertVolume {
  type: 'setAlertVolume';
  volume: number;
}

/** Webview -> server: change the persisted viewer username (server sanitizes/truncates). */
export interface SetUsername {
  type: 'setUsername';
  username: string;
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}
