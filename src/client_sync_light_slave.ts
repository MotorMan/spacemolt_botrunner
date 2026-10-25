import { type SyncSettings, type MarketQueryRequest, type MarketQueryResult, type CreatureClaimPayload, type WildlifeDeltasResponse } from "./client_sync_types.js";
import { botChatChannel } from "./bot_chat_channel.js";
import { wildlifeStore, type SystemWildlife, type WildlifeFullData } from "./wildlivestore.js";
import { setPushFn } from "./client_sync_hooks.js";

/**
 * Lightweight client connect.
 *
 * This is a slim alternative to the full `ClientSyncSlave`. Where the slave does
 * a heavy two-way *file* sync (which deep-merges every data file and can clobber
 * personal per-client state on the other clients), the light client ONLY shares:
 *
 *   1. Bot names + full statuses for every bot (so the master — and therefore
 *      every other client — can see who's running, where, and at what fuel), and
 *   2. The non-API bot chat channel (relayed both ways through the master), so
 *      routines can run cross-client MAYDAY calls or periodic automatic status
 *      checks against the whole connected fleet without ever touching files.
 *
 * No map/market/catalog/coordination/wildlife sync, and crucially no
 * `syncFiles()`. That keeps the footprint tiny and avoids the overwrite problems
 * the full connect has. The master still lets light clients register (tagged
 * `light`) and the cross-client fleet-rescue poll (`/api/client-sync/fleet-poll`
 * and `/api/client-sync/bots`) works exactly the same, because it is built on
 * the per-client status pushes — not on shared files.
 */
export class ClientSyncLightSlave {
  private settings: SyncSettings;
  private clientId: string | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSync = 0;
  /** How long since the last *successful* push before we treat the connection as
   *  stale and force a re-register. Set from pollIntervalSec on start; this is
   *  what catches the "master restarted, our pushes are silently failing, but
   *  settings still says Connected" case — without it the clientId stays valid
   *  forever and the slave never reconnects. */
  private staleMs = 60000;
  private lastError: string | null = null;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private lastConnectAttempt = 0;
  /** Reason the last cross-client fleet pull fell back to local-only. Surfaced
   *  to the rescue routine so a connectivity failure is visible in the rescue
   *  log (otherwise it's only on this node's console). */
  private lastPullError: string | null = null;
  /** Roster of clients the master reported in the last fleet poll. */
  private lastClients: Array<Record<string, unknown>> = [];
  /** Hash of the last bot-chat message we relayed, to avoid echo loops. */
  private lastRelayedChat: string | null = null;
  /** Last time we ran the catalog-sync step (throttled to avoid spamming the
   *  master with version reports every poll cycle). */
  private lastCatalogSync = 0;
  /** Whether this node can serve market data queries. Refreshed every poll
   *  cycle from the presence of a local `data/marketDetails.json`; we only tell
   *  the master we can answer market queries when we really can. */
  private hasMarketData = false;
  private pendingCreatureClaims: CreatureClaimPayload[] = [];

  // ── Lightweight wildlife / creature sync ──────────────────────────────
  // On first connect the light client pulls the master's full creature list
  // once. From then on it only exchanges individual system updates: its bots'
  // discoveries are pushed to the master as single-system deltas (via the shared
  // `setPushFn` hook wired to wildlivestore.drainPushes), and on each poll cycle
  // the light client GETs only the systems that changed on the master since its
  // last-known version. This keeps steady-state bandwidth at a few KB instead of
  // the multi-MB full-galaxy push the heavy slave does every 15 s.
  /** Has the one-time full wildlife pull completed since the last (re)register? */
  private wildlifeSynced = false;
  /** Master's wildlife version we last observed. Sent back as `since` on the
   *  next delta poll so the master knows what we already have. */
  private wildlifeVersion = 0;
  /** True once we've installed our push fn via setPushFn (avoids double-install). */
  private pushFnInstalled = false;

  constructor(settings: SyncSettings) {
    this.settings = settings;
  }

   public start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[ClientSync-Light] Starting lightweight client connect`);
    const intervalMs = Math.max(5, this.settings.pollIntervalSec * 1000);
    // Treat the link as stale after ~4 missed poll cycles (min 30s). The master
    // prunes silent clients at 10min, so this is well within that window and
    // lets a client self-heal long before the master forgets us.
    this.staleMs = Math.max(30000, intervalMs * 4);
    // Wire up the wildlife push hook so local creature discoveries
    // (wildlivestore.drainPushes → onWildlifeUpdate) are forwarded to the
    // master as single-system deltas instead of sitting in memory.
    this.installPushFn();
    this.timer = setInterval(() => this.pollCycle(), intervalMs);
    this.pollCycle();
  }

   public stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clientId = null;
    this.connectionState = 'disconnected';
    // Tear down our push fn so the wildlife store stops trying to relay
    // deltas to a master we're no longer connected to.
    if (this.pushFnInstalled) {
      setPushFn(null);
      this.pushFnInstalled = false;
    }
    this.wildlifeSynced = false;
    this.wildlifeVersion = 0;
  }

   public getState(): { connected: boolean; lastSync: number; lastError: string | null; connectionState: string; lastConnectAttempt: number; wildlifeSynced: boolean; wildlifeVersion: number } {
     return { connected: !!this.clientId, lastSync: this.lastSync, lastError: this.lastError, connectionState: this.connectionState, lastConnectAttempt: this.lastConnectAttempt, wildlifeSynced: this.wildlifeSynced, wildlifeVersion: this.wildlifeVersion };
   }

  /** Push any pending local bot-chat messages to the master immediately, outside the normal poll cycle. */
  public async pushChatNow(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pushChat();
    } catch {
      // best-effort; the next poll cycle will retry
    }
  }

  public queueCreatureClaim(claim: CreatureClaimPayload): void {
    this.pendingCreatureClaims.push(claim);
  }

  /**
   * Install the global wildlife push hook so the local wildlifeStore's
   * `drainPushes` timer forwards individual system discoveries to the master
   * as single-system deltas — exactly the "live updates to individual creatures"
   * the light client exchanges instead of re-uploading the full galaxy.
   *
   * `setPushFn` is process-global, so we guard with `pushFnInstalled` to avoid
   * double-installs across start/stop cycles. The master node sets its own
   * push fn (for its own bot discoveries); this method is only called on a
   * light-slave node where no other push fn is active.
   */
  private installPushFn(): void {
    if (this.pushFnInstalled) return;
    setPushFn(async (type, payload) => {
      if (type !== "wildlife") return;
      const wrapper = payload.data as { system?: string; data?: SystemWildlife } | undefined;
      const sysData = wrapper?.data;
      const sysId = wrapper?.system || (sysData as SystemWildlife | undefined)?.system;
      if (!sysData || !sysId) return;
      if (!this.clientId) return;
      try {
        await this.request<{ ok: boolean }>("/api/client-sync/wildlife-update", { method: "POST" }, {
          system: sysId,
          data: sysData,
        });
      } catch {
        // best-effort; the next poll-cycle delta pull will reconcile any missed
        // sighting that was also picked up by the master from another client.
      }
    });
    this.pushFnInstalled = true;
  }

  /**
   * One-time full wildlife sync: pull the master's authoritative creature list
   * and merge it into the local wildlifeStore. Only runs once per (re)connect —
   * after this, the light client only exchanges individual system deltas.
   */
  private async syncWildlife(): Promise<void> {
    if (!this.settings.syncWildlife) return;
    try {
      const data = await this.request<WildlifeFullData>("/api/client-sync/wildlife");
      if (data && typeof data === "object" && data.systems) {
        wildlifeStore.mergeFrom(data);
        this.wildlifeSynced = true;
        this.log(`Full wildlife sync: merged ${Object.keys(data.systems).length} system(s) from master`);
      }
    } catch (err) {
      this.logError(`Wildlife full sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Poll the master for incremental wildlife updates — only the systems that
   * changed since our last-known version. If the master signals `needsFull`
   * (we fell too far behind, e.g. master restarted) we re-do the full sync.
   * Never throws.
   */
  private async pullWildlifeDeltas(): Promise<void> {
    if (!this.settings.syncWildlife) return;
    if (!this.clientId || !this.wildlifeSynced) return;
    try {
      const data = await this.request<WildlifeDeltasResponse>(
        `/api/client-sync/wildlife-deltas?since=${this.wildlifeVersion}`,
      );
      if (!data || typeof data !== "object") return;
      if (data.needsFull) {
        this.log(`Wildlife delta gap too large — re-pulling full sync`);
        this.wildlifeSynced = false;
        await this.syncWildlife();
        return;
      }
      this.wildlifeVersion = data.version;
      const systemCount = Object.keys(data.systems || {}).length;
      if (systemCount > 0) {
        wildlifeStore.mergeFrom({
          systems: data.systems as Record<string, SystemWildlife>,
          lastUpdated: new Date().toISOString(),
          counts: wildlifeStore.getCounts(),
        });
        this.log(`Wildlife deltas: merged ${systemCount} system(s) since v${this.wildlifeVersion - 1}`);
      }
    } catch (err) {
      this.logError(`Wildlife delta pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async pushCreatureClaims(): Promise<void> {
    if (!this.clientId || !this.pendingCreatureClaims.length) return;
    const claims = this.pendingCreatureClaims.splice(0, this.pendingCreatureClaims.length);
    try {
      await Promise.all(claims.map(claim => this.request<{ ok: boolean }>("/api/client-sync/creature-claim", { method: "POST" }, claim)));
    } catch {
      // best-effort; if this fails, the claim still exists locally and will be retried next cycle
    }
  }

  private async pullCreatureClaims(): Promise<void> {
    const claims = await this.request<CreatureClaimPayload[]>("/api/client-sync/creature-claims");
    if (!Array.isArray(claims)) return;
    for (const claim of claims) {
      botChatChannel.send({
        sender: claim.claimer,
        recipients: [],
        channel: "coordination",
        content: `[CREATURE CLAIM] ${claim.claimer} claiming ${claim.targetName} (${claim.targetId}) at ${claim.system}/${claim.poi}`,
        metadata: {
          type: "creature_claim",
          system: claim.system,
          poi: claim.poi,
          targetName: claim.targetName,
          targetId: claim.targetId,
        },
      });
    }
  }

  /** Whether this node currently can serve market data queries. */
  public getHasMarketData(): boolean {
    return this.hasMarketData;
  }

  /** Manually set the market data flag (kept for parity with the market slave). */
  public setHasMarketData(value: boolean): void {
    this.hasMarketData = value;
  }

  public updateSettings(s: SyncSettings): void {
    this.settings = s;
  }

  /**
   * Send a market data query to the master, which routes it to the client that
   * has the freshest market data (advertised via syncMarketAvailability). This
   * lets light clients answer low-bandwidth market queries without the heavy
   * file sync — same contract as ClientSyncMarketSlave.queryRemoteMarket.
   */
  public async queryRemoteMarket(query: MarketQueryRequest): Promise<MarketQueryResult> {
    if (!this.clientId) {
      return { ok: false, results: [], error: "Not connected to master" };
    }
    try {
      const result = await this.request<MarketQueryResult>("/api/client-sync/market-query", { method: "POST" }, query);
      return result;
    } catch (err) {
      this.logError(`Market query failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, results: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  private log(msg: string): void {
    console.log(`[ClientSync-Light] ${msg}`);
  }

  private logError(msg: string): void {
    console.error(`[ClientSync-Light] ${msg}`);
  }

  private async request<T>(path: string, init?: RequestInit, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
    if (this.settings.apiKey) headers["X-API-Key"] = this.settings.apiKey;
    if (this.settings.password) headers["X-Password"] = this.settings.password;
    if (this.clientId) headers["X-Client-Id"] = this.clientId;

    // Normalize masterUrl so a trailing slash can't produce a malformed
    // double-slash path (register() uses new URL() which already normalizes,
    // but the plain fetch here must match).
    const base = (this.settings.masterUrl || "").replace(/\/+$/, "");
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, { ...init, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal });
      clearTimeout(timeoutId);
      const text = await res.text();
      try { return JSON.parse(text) as T; } catch { return text as T; }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        this.logError(`Timeout connecting to master`);
        throw new Error(`Connection timeout to ${this.settings.masterUrl}`);
      }
      this.logError(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

   private async register(): Promise<{ ok: boolean; error?: string; wildlifeVersion?: number }> {
    const url = new URL("/api/client-sync/register", this.settings.masterUrl).toString();
    this.connectionState = 'connecting';
    this.lastConnectAttempt = Date.now();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: this.settings.apiKey,
          label: this.settings.label || "light",
          password: this.settings.password,
          url: this.settings.selfUrl || "",
          light: true,
        }),
      });
      let payload: { ok: boolean; clientId?: string; error?: string; wildlifeVersion?: number };
      try {
        payload = await res.json();
      } catch {
        payload = { ok: false, error: "invalid response" };
      }
      if (payload.ok && payload.clientId) {
        this.clientId = payload.clientId;
        this.connectionState = 'connected';
        this.lastError = null;
        // Capture the master's wildlife version at registration time. On a
        // fresh connect (or after a master restart that reset its version) we
        // will do a one-time full creature sync; the version here seeds the
        // subsequent delta polling.
        this.wildlifeVersion = payload.wildlifeVersion ?? 0;
        this.wildlifeSynced = false;
        this.log(`Connected to master as ${this.settings.label || "light"} (${payload.clientId})`);
      } else {
        this.connectionState = 'disconnected';
        this.lastError = payload.error || `HTTP ${res.status}`;
      }
      return payload;
    } catch (err) {
      this.connectionState = 'disconnected';
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      return { ok: false, error: msg };
    }
  }

  /** Force (re)registration with the master. Used by one-shot fleet pulls so a
   *  rescue scan always reaches a registered state even if the normal poll cycle
   *  hasn't run yet (e.g. right after a client restart). */
  public async forceRegister(): Promise<void> {
    if (this.running) return; // poll cycle will register on its own
    const reg = await this.register();
    if (reg.ok) this.connectionState = "connected";
  }

  /** Push this node's bot names + full statuses up to the master.
   *  Returns true if the master accepted the push (client is known), false if
   *  the master rejected it (e.g. "client not found" after a master restart) —
   *  in which case the caller should force a re-register. */
  private async pushStatuses(): Promise<boolean> {
    let statuses: Record<string, unknown>[] = [];
    try {
      const { getBotStatuses } = await import("./botmanager.js");
      statuses = (getBotStatuses() as unknown[]) as Record<string, unknown>[];
    } catch {
      // best-effort: ignore if bot manager is unavailable
    }
    try {
      const res = await this.request<{ ok: boolean }>("/api/client-sync/bot-status", { method: "POST" }, { clientId: this.clientId, statuses });
      return !!(res && (res as { ok?: boolean }).ok);
    } catch {
      return false;
    }
  }

  /**
   * Relay this client's local bot-chat messages up to the master so every other
   * connected client (and routines on the master) can see them — this is the
   * cross-client non-API chat channel that powers MAYDAY calls and periodic
   * status checks. We only relay messages that haven't been relayed yet to avoid
   * echo loops, and we seed the dedup cursor from current history on connect.
   */
  private async pushChat(): Promise<void> {
    const history = botChatChannel.getHistory(undefined, 100);
    for (const m of history) {
      const sig = `${m.sender}|${m.channel}|${m.content}|${m.timestamp}`;
      if (sig === this.lastRelayedChat) continue;
      try {
        await this.request<{ ok: boolean }>("/api/client-sync/chat-relay", { method: "POST" }, {
          channel: m.channel,
          content: m.content,
          sender: m.sender,
          metadata: m.metadata,
        });
      } catch {
        break;
      }
      this.lastRelayedChat = sig;
    }
  }

  /**
   * Pull the master's combined bot-chat history (the union of every connected
   * client's relayed chat) back into this client's bot chat channel so local
   * routines can read cross-client messages. Messages already present locally
   * (by timestamp + content) are skipped to avoid duplicates/echoes.
   */
  private async pullChat(): Promise<void> {
    const data = await this.request<Array<Record<string, unknown>>>("/api/client-sync/chat-history");
    if (!Array.isArray(data)) return;
    const local = botChatChannel.getHistory(undefined, 200);
    const seen = new Set(local.map((m) => `${m.sender}|${m.channel}|${m.content}|${m.timestamp}`));
    for (const m of data) {
      const sig = `${m.sender || ""}|${m.channel || ""}|${m.content || ""}|${m.timestamp || ""}`;
      if (seen.has(sig)) continue;
      botChatChannel.send({
        sender: String(m.sender || "remote"),
        recipients: [],
        channel: (m.channel as any) || "general",
        content: String(m.content || ""),
        metadata: m.metadata as Record<string, unknown> | undefined,
      });
    }
  }

  /** Read our local catalog version + lastFetched without forcing a load. */
  private async localCatalogInfo(): Promise<{ version: string | null; lastFetched: string | null }> {
    try {
      const { catalogStore } = await import("./catalogstore.js");
      const all = catalogStore.getAll();
      return {
        version: typeof all.version === "string" ? all.version : null,
        lastFetched: typeof all.lastFetched === "string" ? all.lastFetched : null,
      };
    } catch {
      return { version: null, lastFetched: null };
    }
  }

  /**
   * Fleet-wide catalog convergence.
   *
   * Every connected client used to independently download `catalog.json` from the
   * gameserver, which rate-limits that endpoint — so only one client actually
   * got the fresh file and the rest were stuck on stale versions. Instead, we
   * report our local catalog version to the master, which elects exactly ONE
   * client to fetch it from the gameserver and then relays that single copy to
   * the rest of us. The master's verdict tells us which role to play:
   *
   *  - `none`: we're already current (or orchestration is inactive) — nothing to do.
   *  - `accept_catalog`: adopt the catalog the master relays and replace ours.
   *  - `upload`: we already have the gameserver version — send our copy up so the
   *     master can relay it to the others.
   *  - `download_and_upload`: we're the elected one — fetch once from the
   *     gameserver, then upload so everyone converges.
   *
   * Never throws.
   */
  private async syncCatalog(): Promise<void> {
    if (!this.settings.syncCatalog) return;
    const now = Date.now();
    // Throttle the version report so we don't hit the master every poll cycle;
    // the master's election is sticky enough that 30s granularity is plenty.
    if (now - this.lastCatalogSync < 30000) return;
    this.lastCatalogSync = now;

    const { version, lastFetched } = await this.localCatalogInfo();
    let resp: { ok?: boolean; gameServerVersion?: string | null; action?: string; catalog?: Record<string, unknown>; version?: string | null };
    try {
      resp = await this.request<typeof resp>("/api/client-sync/catalog-version", { method: "POST" }, { version, lastFetched });
    } catch {
      return;
    }
    const action = resp?.action;
    try {
      const { catalogStore } = await import("./catalogstore.js");
      if (action === "accept_catalog" && resp.catalog && typeof resp.catalog === "object") {
        catalogStore.replaceWith(resp.catalog as Record<string, unknown>);
        this.log(`Adopted up-to-date catalog from master (was v${version ?? "?"})`);
      } else if (action === "upload") {
        await this.request<{ ok?: boolean }>("/api/client-sync/catalog-upload", { method: "POST" }, { catalog: catalogStore.getAll() });
        this.log(`Uploaded local catalog (v${version ?? "?"}) to master`);
      } else if (action === "download_and_upload") {
        await catalogStore.fetchFromLib(true);
        await this.request<{ ok?: boolean }>("/api/client-sync/catalog-upload", { method: "POST" }, { catalog: catalogStore.getAll() });
        this.log(`Downloaded fresh catalog (v${catalogStore.getAll().version ?? "?"}) from gameserver and shared to master`);
      }
    } catch (err) {
      this.logError(`Catalog sync (${action}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Pull the master's cross-client fleet rescue poll: a single request that asks
   * every connected client for its local bots' fuel status + positions and
   * returns the union. Used by rescue routines to see the whole connected fleet
   * (named + full status) without each stranded bot having to request a rescue.
   * Never throws.
   */
  public async pullFleetRescue(): Promise<{ bots: Array<Record<string, unknown>>; clients: Array<Record<string, unknown>> }> {
    this.lastPullError = null;
    // If we aren't registered yet (e.g. this runs from a rescue scan that fired
    // before our poll cycle completed a register after a client restart), try a
    // one-shot register now so we still pull the master's full combined fleet
    // instead of silently falling back to local-only and "losing" every remote
    // bot. Never throws.
    if (!this.clientId) {
      try {
        const reg = await this.register();
        if (reg.ok) {
          this.connectionState = "connected";
        }
      } catch (err) {
        this.lastPullError = `register failed: ${err instanceof Error ? err.message : String(err)}`;
        this.logError(`pullFleetRescue: ${this.lastPullError}`);
        return this.localFleetStatuses();
      }
    }
    if (!this.clientId) {
      this.lastPullError = "not registered (no clientId)";
      this.log("pullFleetRescue: no clientId (not registered) — returning local-only fleet");
      return this.localFleetStatuses();
    }
    try {
      const data = await this.request<{ bots?: Array<Record<string, unknown>>; clients?: Array<Record<string, unknown>> }>("/api/client-sync/fleet-poll");
      if (data && Array.isArray(data.bots)) {
        this.lastClients = Array.isArray(data.clients) ? data.clients : [];
        this.log(`pullFleetRescue: got ${data.bots.length} remote bot(s) from master`);
        return { bots: data.bots, clients: this.lastClients };
      }
      this.lastPullError = `master returned unexpected shape (${typeof data})`;
      this.logError(`pullFleetRescue: ${this.lastPullError} — falling back to local-only`);
    } catch (err) {
      this.lastPullError = `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logError(`pullFleetRescue: ${this.lastPullError} — falling back to local-only`);
    }
    return this.localFleetStatuses();
  }

  /** Last reason the cross-client fleet pull fell back to local-only, or null
   *  if the last pull succeeded. Used by the rescue routine for diagnostics. */
  public getLastPullError(): string | null {
    return this.lastPullError;
  }

  /** Roster of clients the master reported in the last fleet poll (label +
   *  botCount + lastSeen). Used by the rescue routine to show which clients are
   *  connected and which one is missing. */
  public getLastClients(): Array<Record<string, unknown>> {
    return this.lastClients;
  }

  /** This node's own local bot statuses (used as a fallback for fleet rescue). */
  private async localFleetStatuses(): Promise<{ bots: Array<Record<string, unknown>>; clients: Array<Record<string, unknown>> }> {
    try {
      const { getBotStatuses } = await import("./botmanager.js");
      return { bots: (getBotStatuses() as unknown[]) as Array<Record<string, unknown>>, clients: [] };
    } catch {
      return { bots: [], clients: [] };
    }
  }

  private async pollCycle(): Promise<void> {
    if (!this.running) return;
    try {
      // Stale-connection self-heal: if we had synced before but haven't pushed
      // successfully in staleMs (e.g. the master restarted and now silently
      // rejects/ignores our pushes), force a re-register so we don't sit there
      // "connected" forever while actually dead. This is what catches the case
      // where settings says Connected but no data is flowing.
      if (this.clientId && this.lastSync !== 0 && Date.now() - this.lastSync > this.staleMs) {
        this.log(`Connection stale (last sync ${Math.round((Date.now() - this.lastSync) / 1000)}s ago) — forcing re-register`);
        this.clientId = null;
        this.connectionState = 'disconnected';
      }
      if (!this.clientId) {
        this.log('Registering with master...');
        const reg = await this.register();
        if (!reg.ok) {
          // Registration failed — only now drop our client id so we retry next
          // cycle. A transient failure here (bad network, master restart) must
          // NOT poison a client that already registered successfully.
          this.clientId = null;
          this.connectionState = 'disconnected';
          throw new Error(reg.error || "register failed");
        }
        this.connectionState = 'connected';
      }
      // The ONLY two things a light client shares are bot statuses + the
      // non-API bot chat channel. No file sync, no map/market/etc.
      const pushed = await this.pushStatuses();
      if (!pushed) {
        // Master rejected the push (client not found — e.g. master restarted and
        // forgot us). Force a re-register next cycle so we don't keep pushing to
        // a stale clientId forever. The rest of this cycle can still run.
        this.clientId = null;
        this.connectionState = 'disconnected';
        this.logError(`Status push rejected by master — will re-register next cycle`);
      }
      await this.pushChat();
      await this.pullChat();
      await this.pushCreatureClaims();
      await this.pullCreatureClaims();
      // Lightweight creature sync: one-time full pull on (re)connect, then
      // incremental per-system deltas on every cycle so steady-state bandwidth
      // stays tiny. The master's own discoveries and every other light client's
      // sightings arrive via the deltas — no full-galaxy re-download needed.
      if (!this.wildlifeSynced) {
        await this.syncWildlife();
      } else {
        await this.pullWildlifeDeltas();
      }
      // Fleet-wide catalog convergence: the master elects ONE client to fetch
      // catalog.json from the gameserver and relays that single copy to the
      // rest of us — so we don't all hammer the (rate-limited) endpoint and end
      // up on stale versions.
      await this.syncCatalog();
      // Advertise that we can serve market data queries. Light clients always
      // keep a local marketDetails.json, so the master knows it can route
      // market queries to us (low-bandwidth, no file sync required).
      await this.syncMarketAvailability();
      this.lastSync = Date.now();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // NB: we intentionally do NOT null clientId here on a generic error
      // (chat pull, transient network blip, …). Nuking the id on every blip
      // churned re-registrations and left clients stuck "connected" but never
      // pushing. Only registration failure / rejected push drops the id.
      if (!this.clientId) this.connectionState = 'disconnected';
      this.logError(`Sync failed: ${this.lastError}`);
    }
  }

  /**
   * Tell the master whether we currently have market data to share.
   *
   * This used to be advertised unconditionally, which meant a light client with
   * no local `marketDetails.json` could still win the master's market-query
   * routing and answer every query with "no matching orders" — the remote
   * trader then logged "no remote deals found" and never learned why. We now
   * advertise only when the file actually exists locally.
   */
  private async syncMarketAvailability(): Promise<void> {
    if (!this.clientId) return;
    try {
      const { getLocalMarketFileInfo } = await import("./market_local_source.js");
      const info = getLocalMarketFileInfo();
      const has = info.exists && info.sizeBytes > 2;
      if (has !== this.hasMarketData) {
        this.log(`Market data availability -> ${has ? "yes" : "no (no local data/marketDetails.json)"}`);
        this.hasMarketData = has;
      }
    } catch {
      // Keep the previous value rather than flapping on a transient fs error.
    }
    try {
      await this.request("/api/client-sync/market-data-status", { method: "POST" }, {
        clientId: this.clientId,
        hasMarketData: this.hasMarketData,
      });
    } catch {
      // Non-fatal: master will simply stop routing market queries to us until
      // the next successful cycle.
    }
  }
}
