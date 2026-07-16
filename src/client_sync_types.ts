export type BotSyncMode = "disabled" | "master" | "slave" | "light";

export interface SyncSettings {
  enabled: boolean;
  mode: BotSyncMode | string;
  masterUrl: string;
  apiKey: string;
  password?: string;
  label: string;
  pollIntervalSec: number;
  syncMap: boolean;
  syncMarket: boolean;
  syncCatalog: boolean;
  syncStats: boolean;
  syncBotChat: boolean;
  syncPlayerNames: boolean;
  syncCoordination: boolean;
  syncCivilianTransport: boolean;
  syncRescue: boolean;
  syncWildlife: boolean;
  allowRemoteBotsInDropdowns: boolean;
  remoteBotNameStyle: "prefix" | "suffix";
  pushLocalDiscoveries: boolean;
  selfUrl?: string;
  /**
   * Per-file opt-out list for the raw file sync. Any relative data-dir path
   * (e.g. `lastUsedRoutine.json`, `personalities/foo.json`) present here is
   * neither pulled/overwritten from the master nor pushed up to it. This lets
   * a client keep personal per-client state (last used routine, stopped state,
   * loadouts, …) instead of having it clobbered by the combined repo.
   */
  disabledSyncFiles?: string[];
}

export interface RegisteredClient {
  clientId: string;
  label: string;
  password?: string;
  apiKey?: string;
  connectedAt: number;
  lastSeen: number;
  ip?: string;
  selfUrl?: string;
  /** True when this client connected in lightweight ("light") mode: it only
   * shares bot names/statuses + the non-API bot chat channel and never takes
   * part in the heavy two-way file sync. */
  light?: boolean;
}

export interface PoiPayload {
  systemId: string;
  poi: Record<string, unknown>;
}

export interface MarketPayload {
  station: string;
  orders: Array<Record<string, unknown>>;
}

export interface CoordinationPayload {
  file: string;
  data: unknown;
}

export interface PlayerNamePayload {
  name: string;
  faction?: string;
  lastSeen?: string;
}

export interface PassengerPayload {
  manifest: Record<string, unknown>;
}

export interface BotStatusPush {
  username: string;
  state: string;
  routine?: string | null;
  credits?: number;
  fuel?: number;
  stats?: Record<string, unknown>;
}

export interface HelloResponse {
  ok: boolean;
  version: string;
  clientId: string;
  connectedClients: RegisteredClient[];
}

export type SyncEventType =
  | "poi"
  | "market"
  | "playerName"
  | "coordination"
  | "civilianTransport"
  | "rescue"
  | "wildlife";

export interface SyncHookContext {
  enabled: boolean;
  pushToMaster?: (type: SyncEventType, payload: Record<string, unknown>) => Promise<void>;
}
