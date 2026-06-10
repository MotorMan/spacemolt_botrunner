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

function generateApiKey(): string {
  return `master_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class ClientSyncMaster {
  private settings: Record<string, unknown>;
  private clients = new Map<string, RegisteredClient>();
  private readonly version = "1.0.0";
  private apiKey: string;
  private password: string;
  private mode: string;

  constructor(settings: Record<string, unknown>) {
    this.settings = settings;
    this.mode = (settings.mode as string) || "slave";
    const storedApiKey = settings.apiKey as string | undefined;
    this.apiKey = storedApiKey || "";
    this.password = (settings.password as string) || "";
    if (!this.apiKey) {
      this.apiKey = generateApiKey();
      this.settings.apiKey = this.apiKey;
    }
  }

  public getMode(): string {
    return this.mode;
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  public getPassword(): string {
    return this.password;
  }

  public setApiKey(key: string): void {
    this.apiKey = key;
    this.settings.apiKey = key;
  }

  public setPassword(pwd: string): void {
    this.password = pwd;
    this.settings.password = pwd;
  }

  public saveSettings(): void {
    this.settings.apiKey = this.apiKey;
    this.settings.password = this.password;
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

  public register(payload: { label: string; apiKey: string; password?: string }): Promise<{ clientId: string; ok?: boolean; error?: string }> {
    if (this.mode !== "master") {
      return Promise.resolve({ clientId: "", ok: false, error: "Master not in master mode" });
    }
    if (payload.apiKey !== this.apiKey) {
      return Promise.resolve({ clientId: "", ok: false, error: "Invalid API key" });
    }
    if (this.password && payload.password !== this.password) {
      return Promise.resolve({ clientId: "", ok: false, error: "Invalid password" });
    }
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
    return Promise.resolve({ clientId: id, ok: true });
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
