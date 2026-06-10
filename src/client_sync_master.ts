import type {
  RegisteredClient,
  PoiPayload,
  MarketPayload,
  CoordinationPayload,
  PlayerNamePayload,
  PassengerPayload,
  BotStatusPush,
  HelloResponse,
} from "./client_sync_types.js";

export type {
  RegisteredClient,
  PoiPayload,
  MarketPayload,
  CoordinationPayload,
  PlayerNamePayload,
  PassengerPayload,
  BotStatusPush,
  HelloResponse,
} from "./client_sync_types.js";

export class ClientSyncMaster {
  private settings: Record<string, unknown>;
  private clients = new Map<string, RegisteredClient>();
  private readonly version = "1.0.0";

  constructor(settings: Record<string, unknown>) {
    this.settings = settings;
  }

  public getSettings(): Record<string, unknown> {
    return this.settings;
  }

  public getClients(): RegisteredClient[] {
    return Array.from(this.clients.values());
  }

  public hello(clientId: string): HelloResponse {
    const clients: RegisteredClient[] = [];
    for (const c of this.clients.values()) clients.push({ ...c });
    return { ok: true, version: this.version, clientId, connectedClients: clients };
  }

  public async register(payload: { label: string; apiKey: string; password?: string }): Promise<{ clientId: string }> {
    const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.clients.set(id, {
      clientId: id,
      label: payload.label || id,
      apiKey: payload.apiKey,
      password: payload.password,
      connectedAt: now,
      lastSeen: now,
    });
    return { clientId: id };
  }

  public disconnect(clientId: string): boolean {
    return this.clients.delete(clientId);
  }

  public touch(clientId: string): void {
    const c = this.clients.get(clientId);
    if (c) c.lastSeen = Date.now();
  }

  public chatRelay(_body: { channel: string; content: string; sender?: string }): { ok: boolean } {
    return { ok: true };
  }

  public botStatusPush(clientId: string, _statuses: BotStatusPush[]): boolean {
    const c = this.clients.get(clientId);
    if (!c) return false;
    c.lastSeen = Date.now();
    return true;
  }

  public poiUpdate(_payload: PoiPayload): boolean {
    return true;
  }

  public marketUpdate(_payload: MarketPayload): boolean {
    return true;
  }

  public coordinationSync(_payload: CoordinationPayload): boolean {
    return true;
  }

  public playerNamesUpdate(_payload: PlayerNamePayload): boolean {
    return true;
  }

  public civilianTransportUpdate(_payload: PassengerPayload): boolean {
    return true;
  }

  public getBots(): unknown[] {
    return [];
  }
}
