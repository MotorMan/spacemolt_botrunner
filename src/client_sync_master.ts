import { join } from "path";
import {
  mergeIntoFile,
  seedIntoFile,
  readSyncedFile,
  peerRequest,
  peerRequestText,
  type FileEntry,
} from "./client_sync_files.js";
import { botChatChannel } from "./bot_chat_channel.js";
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
  private botStatuses = new Map<string, unknown[]>();
  private readonly version = "1.0.0";
  /** Max time to wait for a single full slave's selfUrl fleet poll before
   *  skipping it. Kept short so one slow/unreachable slave can't stall the
   *  whole cross-client fleet poll (which would time out light/slave rescue
   *  bots' `pullFleetRescue` and make them fall back to local-only). */
  private static readonly FLEET_POLL_TIMEOUT_MS = 3000;
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

  /**
   * Merge in updated settings (e.g. after the user edits the Connect Clients
   * page) so a live master picks up changes like the per-file opt-out list
   * without needing a restart.
   */
  public updateSettings(settings: Record<string, unknown>): void {
    this.settings = settings;
    if (typeof settings.apiKey === "string" && settings.apiKey) this.apiKey = settings.apiKey;
    if (typeof settings.password === "string") this.password = settings.password;
    if (typeof settings.mode === "string") this.mode = settings.mode;
  }

  /** Relative data-dir paths the master opted out of merging in from slaves. */
  private disabledSyncFiles(): string[] {
    const d = this.settings.disabledSyncFiles;
    return Array.isArray(d) ? (d as string[]) : [];
  }

  public getClients(): RegisteredClient[] {
    const out: RegisteredClient[] = [];
    for (const c of this.clients.values()) {
      const entry: RegisteredClient = { ...c };
      const statuses = this.botStatuses.get(c.clientId) || [];
      entry.botCount = statuses.length;
      out.push(entry);
    }
    return out;
  }

  public hello(clientId: string): HelloResponse {
    const clients: RegisteredClient[] = [];
    for (const c of this.clients.values()) clients.push({ ...c });
    return { ok: true, version: this.version, clientId, connectedClients: clients };
  }

  public register(payload: { label: string; apiKey: string; password?: string; url?: string; light?: boolean }): Promise<{ clientId: string; ok?: boolean; error?: string }> {
    if (this.mode !== "master") {
      return Promise.resolve({ clientId: "", ok: false, error: "Master not in master mode" });
    }
    if (payload.apiKey !== this.apiKey) {
      return Promise.resolve({ clientId: "", ok: false, error: "Invalid API key" });
    }
    if (this.password && payload.password !== this.password) {
      return Promise.resolve({ clientId: "", ok: false, error: "Invalid password" });
    }
    const now = Date.now();
    const label = payload.label || "";
    // Reuse an existing client with the same non-empty label instead of always
    // minting a brand-new clientId. Otherwise every reconnect / "Test Connection"
    // click piles up a duplicate entry (and a fresh clientId), and the master's
    // client list grows without bound while the old entries keep their (now
    // orphaned) bot statuses. Labels are user-assigned and meant to be unique
    // per physical client, so deduping on label is the correct identity.
    let id: string | undefined;
    if (label) {
      for (const [cid, c] of this.clients) {
        if (c.label === label) { id = cid; break; }
      }
    }
    if (!id) {
      id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    this.clients.set(id, {
      clientId: id,
      label: label || id,
      apiKey: payload.apiKey,
      password: payload.password,
      connectedAt: this.clients.get(id)?.connectedAt ?? now,
      lastSeen: now,
      selfUrl: payload.url || undefined,
      light: !!payload.light,
    });
    return Promise.resolve({ clientId: id, ok: true });
  }

  /**
   * Pull a slave's synced files into this master's combined repository.
   * Missing files are seeded; existing files are deep-merged by key. Returns a
   * count of how many files were touched.
   */
  public async pullFromSlave(clientId: string): Promise<number> {
    const client = this.clients.get(clientId);
    // Lightweight clients never participate in the heavy file sync: skip them
    // entirely so their data dirs can't be touched/overwritten (this is the
    // whole point of light mode — no file-level clobbering of other clients).
    if (!client || !client.selfUrl || client.light) return 0;
    const dataDir = join(process.cwd(), "data");
    const disabled = this.disabledSyncFiles();
    let listed: { files: FileEntry[] };
    try {
      listed = await peerRequest(client.selfUrl, "/api/client-sync/local-files", this.apiKey, this.password || "");
    } catch {
      return 0;
    }
    let touched = 0;
    for (const f of listed.files) {
      // Respect the master's own per-file opt-out: don't let a slave's copy
      // overwrite/merge into this master's personal state.
      if (disabled.includes(f.path)) continue;
      const content = readSyncedFile(dataDir, f.path);
      // Fetch the slave's raw file body regardless; seed if missing, merge if present.
      const remote = await peerRequestText(client.selfUrl, `/api/client-sync/local-file?path=${encodeURIComponent(f.path)}`, this.apiKey, this.password || "");
      if (typeof remote !== "string" || !remote) continue;
      const hash = content === null
        ? seedIntoFile(dataDir, f.path, remote)
        : mergeIntoFile(dataDir, f.path, remote);
      if (hash) touched++;
    }
    return touched;
  }

  /** Pull every registered slave that advertised a reachable URL. */
  public async pullAllSlaves(): Promise<number> {
    let total = 0;
    for (const id of this.clients.keys()) {
      total += await this.pullFromSlave(id);
    }
    return total;
  }

  private fileSyncTimer: ReturnType<typeof setInterval> | null = null;
  /** Clients not seen for this long are considered dead and pruned (their
   *  botStatuses dropped too). 10min >> any sane pollIntervalSec (<=120s), so a
   *  healthy client mid-cycle is never evicted; only genuinely gone clients
   *  (and the orphaned duplicates left by the old always-new-clientId register)
   *  are cleaned up. */
  private static readonly STALE_CLIENT_MS = 10 * 60 * 1000;

  /** Drop clients we haven't heard from in STALE_CLIENT_MS, clearing their
   *  cached bot statuses so getBots()/requestFleetRescuePoll stop serving
   *  stale bots for a client that's no longer connected. */
  public pruneStaleClients(): void {
    const now = Date.now();
    for (const [cid, c] of this.clients) {
      if (now - (c.lastSeen || 0) > ClientSyncMaster.STALE_CLIENT_MS) {
        this.clients.delete(cid);
        this.botStatuses.delete(cid);
      }
    }
  }

  /** Periodically re-poll slaves so files changed without a push still converge,
   *  and prune clients that have gone silent. */
  public startFileSync(intervalSec: number): void {
    if (this.fileSyncTimer) return;
    const ms = Math.max(5000, intervalSec * 1000);
    this.fileSyncTimer = setInterval(() => {
      this.pruneStaleClients();
      this.pullAllSlaves().catch(() => {});
    }, ms);
  }

  public stopFileSync(): void {
    if (this.fileSyncTimer) {
      clearInterval(this.fileSyncTimer);
      this.fileSyncTimer = null;
    }
  }

  public disconnect(clientId: string): boolean {
    this.botStatuses.delete(clientId);
    return this.clients.delete(clientId);
  }

  public touch(clientId: string): void {
    const c = this.clients.get(clientId);
    if (c) c.lastSeen = Date.now();
  }

  public chatRelay(body: { channel: string; content: string; sender?: string; clientId?: string }): { ok: boolean } {
    // Relay a client's non-API bot-chat message into this master's in-memory
    // bot chat channel so routines on the master (mayday calls, periodic status
    // checks, …) can see it. The message is tagged with the originating client
    // label so every connected client (slave + light) that pulls `chat-history`
    // sees the union of all clients' bot chat. This is what lets the lightweight
    // connect mode share the cross-client bot chat channel without any of the
    // heavy file sync that the full slave mode does.
    const client = body.clientId ? this.clients.get(body.clientId) : undefined;
    const label = client?.label;
    const prefix = label ? `[${label}] ` : "";
    botChatChannel.send({
      sender: `${prefix}${body.sender || "remote"}`,
      recipients: [],
      channel: (body.channel as any) || "general",
      content: String(body.content || ""),
    });
    return { ok: true };
  }

  public botStatusPush(clientId: string, statuses: BotStatusPush[]): boolean {
    const c = this.clients.get(clientId);
    if (!c) return false;
    c.lastSeen = Date.now();
    this.botStatuses.set(clientId, statuses as unknown[]);
    return true;
  }

  /**
   * Validate a prospective client's credentials WITHOUT permanently registering
   * it. Used by the dashboard "Test Connection" button, which must prove the
   * master is reachable and the apiKey/password/mode are correct but must NOT
   * leave a lingering client entry every time it's clicked (that's what caused
   * the master's connected-clients list to pile up with one-shot pings).
   */
  public validateConnection(payload: { apiKey: string; password?: string }): { ok: boolean; error?: string } {
    if (this.mode !== "master") {
      return { ok: false, error: "Master not in master mode" };
    }
    if (payload.apiKey !== this.apiKey) {
      return { ok: false, error: "Invalid API key" };
    }
    if (this.password && payload.password !== this.password) {
      return { ok: false, error: "Invalid password" };
    }
    return { ok: true };
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

  public wildlifeUpdate(_payload: { data: unknown }): boolean {
    return true;
  }

  public getBots(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const [clientId, c] of this.clients) {
      const statuses = this.botStatuses.get(clientId) || [];
      for (const s of statuses) {
        const entry = { ...(s as Record<string, unknown>) } as Record<string, unknown>;
        entry._clientId = clientId;
        entry._clientLabel = c.label;
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Cross-client fleet rescue poll.
   *
   * Instead of having every stranded bot broadcast a rescue request (which has
   * to round-trip through the synced bot-chat channel and is easy to miss), the
   * rescue bot *itself* polls each connected client for that client's local
   * bots' fuel status + positions — exactly the data the rescue bot would read
   * if it were running locally inside every other client. We hit each client's
   * own `/api/client-sync/bots` endpoint (the non-API, client-connect side of
   * the sync channel) and return the union of every client's bots.
   *
   * This is what powers fleet rescue across the whole connected fleet without
   * the stranded bots needing to do anything special: a single rescue bot polls
   * all clients and sees every bot's fuel/position in one place. Returns an
   * empty array (never throws) if no clients advertise a reachable URL.
   */
  public async requestFleetRescuePoll(): Promise<Array<Record<string, unknown>>> {
    const combined: Array<Record<string, unknown>> = [];
    // Lightweight clients push their bot statuses to us (they don't expose a
    // reachable server / file sync), so their bots already live in `botStatuses`
    // — fold those in directly instead of polling a self URL that may not exist.
    for (const b of this.getBots()) {
      combined.push(b);
    }
    // Full slaves still advertise a reachable selfUrl; poll those for live bots.
    // Their pushed statuses already live in `botStatuses` (folded in above), so
    // this is just a freshness re-poll. Bound it tightly: a single unreachable/
    // slow full slave must NEVER stall the whole fleet poll (which would make a
    // light/slave rescue bot's `pullFleetRescue` time out and fall back to
    // local-only). Skip any client that can't answer within FLEET_POLL_TIMEOUT.
    for (const [clientId, c] of this.clients) {
      if (c.light || !c.selfUrl) continue;
      try {
        const data = await Promise.race([
          peerRequest(c.selfUrl, "/api/client-sync/bots", this.apiKey, this.password || ""),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ClientSyncMaster.FLEET_POLL_TIMEOUT_MS)),
        ]);
        if (Array.isArray(data)) {
          for (const s of data) {
            const entry = { ...(s as Record<string, unknown>) } as Record<string, unknown>;
            entry._clientId = clientId;
            entry._clientLabel = c.label;
            combined.push(entry);
          }
        }
      } catch {
        // A single unreachable client must not break the whole fleet poll.
        continue;
      }
    }
    return combined;
  }
}

export async function pollFleetRescue(): Promise<Array<Record<string, unknown>>> {
  const master = (globalThis as { syncMaster?: ClientSyncMaster }).syncMaster;
  if (!master) return [];
  return master.requestFleetRescuePoll();
}