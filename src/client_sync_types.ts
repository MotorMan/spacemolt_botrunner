export interface SyncSettings {
  enabled: boolean;
  mode: "master" | "slave" | string;
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
  allowRemoteBotsInDropdowns: boolean;
  remoteBotNameStyle: "prefix" | "suffix";
  pushLocalDiscoveries: boolean;
}

export interface RegisteredClient {
  clientId: string;
  label: string;
  password?: string;
  apiKey?: string;
  connectedAt: number;
  lastSeen: number;
  ip?: string;
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
  | "rescue";

export interface SyncHookContext {
  enabled: boolean;
  pushToMaster?: (type: SyncEventType, payload: Record<string, unknown>) => Promise<void>;
}
