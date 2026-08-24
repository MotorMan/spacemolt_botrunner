import { join } from "path";
import {
  mergeIntoFile,
  seedIntoFile,
  readSyncedFile,
  peerRequest,
  peerRequestText,
  type FileEntry,
} from "./client_sync_files.js";
import {
  deriveOpenApiMeta,
  fetchOpenApiV2Spec,
  loadLatestOpenApiV2Spec,
} from "./openapi.js";
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
  CatalogVersionReport,
  CatalogVersionResponse,
  CatalogSyncState,
  CatalogSyncStateClient,
  MarketQueryRequest,
  MarketQueryResponse,
  MarketQueryResult,
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
  CatalogVersionReport,
  CatalogVersionResponse,
  CatalogSyncState,
  CatalogSyncStateClient,
  MarketQueryRequest,
  MarketQueryResponse,
  MarketQueryResult,
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
  /**
   * The MAYDAY rescue primary designated by the user, shared across every
   * connected client. A single selection on any client is stored here on the
   * master and read by all clients' rescue routines, so they all agree on the
   * same primary even though each client only knows its own local settings.
   */
  private designatedMaydayPrimary: string | null = null;

  // ── Catalog orchestration ──────────────────────────────────
  // Instead of every connected client independently downloading the gameserver's
  // `catalog.json` (which rate-limits, so only one succeeds and the rest stay
  // stale), the master elects a *single* client to fetch it and then relays that
  // one copy to every other client. State below tracks who has what version.
  /** Per-client last-reported catalog version + when we heard it. */
  private catalogVersions = new Map<string, { version: string | null; lastFetched: string | null; lastSeen: number }>();
  /** The one good catalog copy the master is relaying (matches the gameserver
   *  version), plus where it came from and its version string. */
  private latestCatalog: Record<string, unknown> | null = null;
  private latestCatalogVersion: string | null = null;
  private latestCatalogFrom: string | null = null;
  /** The client currently designated to download `catalog.json` from the
   *  gameserver. Only this one is allowed to do the expensive fetch. */
  private downloaderClientId: string | null = null;
  /** True while the master itself is fetching the catalog from the gameserver
   *  (the common post-patch case where no client yet has the new version). Guards
   *  against multiple clients each triggering a master fetch in the same window. */
  private masterFetchPending = false;
  /** Cached gameserver version (from `get_version` / the OpenAPI spec). */
  private gsVersionCache: { v: string | null; at: number } | null = null;
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

  private log(msg: string): void {
    console.log(`[ClientSync] ${msg}`);
  }

  /**
   * Resolve the gameserver version (e.g. "0.501.0") — the version a client's
   * `catalog.json` must match to be considered up to date. Derived from the
   * OpenAPI spec's `info.x-gameserver-version` (the same value `get_version`
   * reports), which is the authoritative gameserver version. Cached for 5min so
   * the per-cycle version reports don't re-read/re-fetch the spec every time.
   */
  private async getGameServerVersion(): Promise<string | null> {
    const now = Date.now();
    if (this.gsVersionCache && now - this.gsVersionCache.at < 5 * 60 * 1000) {
      return this.gsVersionCache.v;
    }
    let v: string | null = null;
    try {
      let spec = loadLatestOpenApiV2Spec(process.cwd());
      if (!spec) {
        const r = await fetchOpenApiV2Spec();
        spec = r.spec;
      }
      if (spec) v = deriveOpenApiMeta(spec).gameServerVersion;
    } catch {
      v = null;
    }
    this.gsVersionCache = { v, at: now };
    return v;
  }

  /**
   * A connected client reports its local `catalog.json` version. The master runs
   * the single-download election and returns what that client should do:
   *
   *  - If the master already holds a copy matching the gameserver version, it
   *    tells every client whose version differs to `accept_catalog` (relay), and
   *    clients already matching get `none`.
   *  - Otherwise (no good copy yet): a client that already has the gameserver
   *    version is told to `upload` its copy so the master can relay it; failing
   *    that, exactly one client is elected `download_and_upload` (the lone
   *    gameserver fetch), and everyone else waits (`none`).
   *
   * Never throws. If the gameserver version can't be determined we fall back to
   * `none` everywhere so clients keep their current behaviour rather than
   * orchestrating against an unknown target.
   */
  public async reportCatalogVersion(
    clientId: string,
    version: string | null,
    lastFetched: string | null,
  ): Promise<CatalogVersionResponse> {
    this.catalogVersions.set(clientId, { version, lastFetched, lastSeen: Date.now() });
    this.touch(clientId);

    const G = await this.getGameServerVersion();
    if (!G) {
      return { ok: true, gameServerVersion: null, action: "none", version };
    }

    // We already hold a fleet-converged copy matching the gameserver version —
    // relay it to anyone who doesn't have it yet.
    if (this.latestCatalog && this.latestCatalogVersion === G) {
      const local = this.catalogVersions.get(clientId);
      if (local && local.version === G) {
        return { ok: true, gameServerVersion: G, action: "none", version: local.version };
      }
      return { ok: true, gameServerVersion: G, action: "accept_catalog", catalog: this.latestCatalog, version: local?.version ?? null };
    }

    // No good copy yet. If this client already has the right version, have it
    // upload its copy so the master can start relaying. (If multiple clients
    // report a match before the upload lands, both may upload — harmless and
    // idempotent; once `latestCatalog` is set the relay phase takes over.)
    if (version === G) {
      return { ok: true, gameServerVersion: G, action: "upload", version };
    }

    // Nobody has the gameserver version yet. After a patch this is the common
    // case: every client is still on the old catalog and none can serve the new
    // one. Rather than elect a *client* to download (which would still hammer the
    // gameserver from a client node), the master itself fetches the fresh
    // catalog.json ONCE and relays it to the whole fleet. This keeps the actual
    // gameserver download on the master and lets clients stay connected (no mass
    // disconnect / re-register storm).
    if (!this.masterFetchPending) {
      this.masterFetchPending = true;
      this.log(`No client has catalog v${G} yet — master will fetch it from the gameserver and relay to the fleet`);
      return { ok: true, gameServerVersion: G, action: "master_fetch", version };
    }
    return { ok: true, gameServerVersion: G, action: "none", version };
  }

  /**
   * A client uploads its catalog (after `upload` or `download_and_upload`). The
   * master stores it as the fleet-converged copy so subsequent version reports
   * relay it to everyone else. Returns the adopted version.
   */
  public catalogUpload(clientId: string, catalog: Record<string, unknown> | null): { ok: boolean; version: string | null } {
    if (!catalog || typeof catalog !== "object") return { ok: false, version: null };
    const v = typeof catalog.version === "string" ? catalog.version : null;
    this.latestCatalog = catalog;
    this.latestCatalogVersion = v;
    this.latestCatalogFrom = clientId;
    const lastFetched = typeof catalog.lastFetched === "string" ? catalog.lastFetched : new Date().toISOString();
    this.catalogVersions.set(clientId, { version: v, lastFetched, lastSeen: Date.now() });
    this.downloaderClientId = null;
    this.log(`Adopted catalog v${v ?? "?"} from ${clientId} — relaying to the rest of the fleet`);
    return { ok: true, version: v };
  }

  /**
   * Called by the server after it performs the master-side gameserver fetch (the
   * `master_fetch` action) and uploads the result. Clears the `masterFetchPending`
   * guard so the next reporting client sees the now-relayable copy. If the fetch
   * failed (no catalog supplied), the guard is cleared so a later client can
   * retry without being permanently stuck.
   */
  public masterCatalogFetched(catalog: Record<string, unknown> | null): { ok: boolean; version: string | null } {
    this.masterFetchPending = false;
    if (!catalog || typeof catalog !== "object") return { ok: false, version: null };
    return this.catalogUpload("master", catalog);
  }

  /** Diagnostic snapshot of the catalog orchestration state. */
  public getCatalogSyncState(): CatalogSyncState {
    const clients: CatalogSyncStateClient[] = [];
    for (const [id, v] of this.catalogVersions) {
      clients.push({ clientId: id, version: v.version, lastFetched: v.lastFetched });
    }
    return {
      gameServerVersion: this.gsVersionCache?.v ?? null,
      latestCatalogVersion: this.latestCatalogVersion,
      latestCatalogFrom: this.latestCatalogFrom,
      downloader: this.downloaderClientId,
      clients,
    };
  }

  public getSettings(): Record<string, unknown> {
    return this.settings;
  }

  /** The user-designated MAYDAY primary, shared across all connected clients. */
  public getDesignatedMaydayPrimary(): string | null {
    const s = this.settings as Record<string, unknown>;
    return typeof s.designatedMaydayPrimary === "string" ? (s.designatedMaydayPrimary as string) : null;
  }

  /** Set (or clear, with `null`) the shared MAYDAY primary. Persisted via the
   *  master settings so it survives a restart. */
  public setDesignatedMaydayPrimary(username: string | null): void {
    const s = this.settings as Record<string, unknown>;
    s.designatedMaydayPrimary = username || null;
    this.saveSettings();
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
        this.catalogVersions.delete(cid);
        if (this.downloaderClientId === cid) this.downloaderClientId = null;
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
    this.catalogVersions.delete(clientId);
    if (this.downloaderClientId === clientId) this.downloaderClientId = null;
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

  public setMarketDataAvailability(clientId: string, hasMarketData: boolean): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.hasMarketData = hasMarketData;
    this.touch(clientId);
    return true;
  }

  public async handleMarketQuery(query: MarketQueryRequest, requestingClientId?: string): Promise<MarketQueryResult> {
    const marketClients: { clientId: string; client: RegisteredClient }[] = [];
    for (const [cid, c] of this.clients) {
      if (c.hasMarketData && c.selfUrl) {
        marketClients.push({ clientId: cid, client: c });
      }
    }
    if (marketClients.length === 0) {
      return { ok: false, results: [], error: "No client with market data available" };
    }
    if (marketClients.length > 1) {
      this.log(`Market query forwarded to first of ${marketClients.length} market clients`);
    }
    const target = marketClients[0];
    const targetUrl = target.client.selfUrl as string;
    try {
      const result = await Promise.race([
        peerRequest(targetUrl, "/api/client-sync/market-query-handler", this.apiKey, this.password || "", undefined, query),
        new Promise<MarketQueryResult>((resolve) => setTimeout(() => resolve({ ok: false, results: [], error: "Market client timed out" }), 10000)),
      ]) as MarketQueryResult;
      return result;
    } catch {
      return { ok: false, results: [], error: `Failed to reach market client ${target.clientId}` };
    }
  }

  public getMarketClients(): Array<{ clientId: string; label: string; lastSeen: number }> {
    const out: Array<{ clientId: string; label: string; lastSeen: number }> = [];
    for (const [cid, c] of this.clients) {
      if (c.hasMarketData) {
        out.push({ clientId: cid, label: c.label, lastSeen: c.lastSeen });
      }
    }
    return out;
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
  /** Result of a cross-client fleet poll: the union of every client's bots, plus
   *  a roster of every registered client (label + how many bots it last pushed +
   *  when it was last seen). The roster lets a rescue bot on a slave/light node
   *  see at a glance which clients are connected and — crucially — which one is
   *  missing from the combined fleet (e.g. a client that registered but hasn't
   *  pushed any statuses yet, or was pruned for being silent). */
  public async requestFleetRescuePoll(): Promise<{ bots: Array<Record<string, unknown>>; clients: Array<Record<string, unknown>> }> {
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
    const clients = this.getClients().map((c) => ({
      label: c.label,
      botCount: c.botCount,
      lastSeen: c.lastSeen,
      light: c.light,
    }));
    return { bots: combined, clients };
  }
}

export async function pollFleetRescue(): Promise<{ bots: Array<Record<string, unknown>>; clients: Array<Record<string, unknown>> }> {
  const master = (globalThis as { syncMaster?: ClientSyncMaster }).syncMaster;
  if (!master) return { bots: [], clients: [] };
  return master.requestFleetRescuePoll();
}