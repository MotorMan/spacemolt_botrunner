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
  /** Number of bot statuses this client last pushed (0 means it's connected
   * but contributed no bots — usually because none of its bots are currently
   * game-connected at push time). Surfaced in the master's client list so a
   * "connected but NOT VISIBLE" client is diagnosable at a glance. */
  botCount?: number;
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

/**
 * A light/slave client reports its local `catalog.json` version to the master
 * so the master can orchestrate a single fleet-wide catalog download instead of
 * every connected client hammering the gameserver's `catalog.json` endpoint
 * (which rate-limits, so only one client succeeds and the rest stay stale).
 */
export interface CatalogVersionReport {
  /** This client's current `catalog.json` `version`, or null if it has none. */
  version: string | null;
  /** This client's `catalog.json` `lastFetched` timestamp, or null. */
  lastFetched: string | null;
}

/**
 * The master's verdict on what a reporting client should do about its catalog:
 *  - `none`: already up to date (or orchestration not active) — do nothing.
 *  - `upload`: you have a catalog matching the gameserver version but the master
 *    still needs your copy so it can relay it to the other clients — send it.
 *  - `download_and_upload`: you are the one designated client that should fetch
 *    the fresh `catalog.json` from the gameserver (once!), then upload it.
 *  - `accept_catalog`: take the `catalog` payload the master relays and replace
 *    your local copy with it.
 */
export interface CatalogVersionResponse {
  ok: boolean;
  /** The gameserver version (from `get_version` / the OpenAPI spec). */
  gameServerVersion: string | null;
  action: "none" | "upload" | "download_and_upload" | "accept_catalog";
  /** Present on `accept_catalog`: the up-to-date catalog to adopt. */
  catalog?: Record<string, unknown>;
  /** This client's reported version, echoed back for logging. */
  version?: string | null;
}

export interface CatalogSyncStateClient {
  clientId: string;
  version: string | null;
  lastFetched: string | null;
}

/** Diagnostic snapshot of the master's catalog orchestration state. */
export interface CatalogSyncState {
  gameServerVersion: string | null;
  latestCatalogVersion: string | null;
  latestCatalogFrom: string | null;
  /** The client currently designated to download from the gameserver. */
  downloader: string | null;
  clients: CatalogSyncStateClient[];
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
