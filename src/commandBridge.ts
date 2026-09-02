// Command bridge types and maps relocated from the retired `api.ts` HTTP client.
// `bot.exec`/`libExec` still normalize library results into `ApiResponse` while
// individual call sites migrate to the typed `account.commands` facade (P3).

import type { Account } from "@spacemolt/lib";
import { isConnectionError } from "./connection.js";

export interface ApiSession {
  id: string;
  playerId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApiResponse {
  result?: unknown;
  notifications?: unknown[];
  session?: ApiSession;
  error?: { code: string; message: string; wait_seconds?: number } | null;
  details?: unknown;
}

// Command-to-Tool Mapping for V2 API
// Note: Direct-path commands (like /command instead of /tool/command) are no longer used

export const COMMAND_TOOL_MAP: Record<string, string> = {
  // Auth commands
  'login': 'spacemolt_auth',
  'register': 'spacemolt_auth',
  'claim': 'spacemolt_auth',
  'logout': 'spacemolt_auth',

  // Default spacemolt tool commands
  'get_status': 'spacemolt',
  'get_player': 'spacemolt',
  'get_ship': 'spacemolt',
  'get_cargo': 'spacemolt',
  'get_skills': 'spacemolt',
  'get_queue': 'spacemolt',
  'get_missions': 'spacemolt',
  'get_active_missions': 'spacemolt',
  'completed_missions': 'spacemolt',
  'view_completed_mission': 'spacemolt',
  'get_commands': 'spacemolt',
  'get_version': 'spacemolt',
  'get_base': 'spacemolt',
  'get_poi': 'spacemolt',
  'get_system': 'spacemolt',
   'get_system_agents': 'spacemolt',
   'get_nearby': 'spacemolt',
   'get_location': 'spacemolt',
   'get_map': 'spacemolt',
   'get_tax_estimate': 'spacemolt',
   'list_passengers': 'spacemolt',
   'list_station_passengers': 'spacemolt',
   'load_passenger': 'spacemolt',
   'unload_passenger': 'spacemolt',
   'find_route': 'spacemolt',
  'search_systems': 'spacemolt',
  'survey_system': 'spacemolt',
  'jump': 'spacemolt',
  'travel': 'spacemolt',
  'dock': 'spacemolt',
  'undock': 'spacemolt',
  'mine': 'spacemolt',
  'sell': 'spacemolt',
  'buy': 'spacemolt',
  'jettison': 'spacemolt',
  'use_item': 'spacemolt',
  'craft': 'spacemolt',
  'attack': 'spacemolt',
  'cloak': 'spacemolt',
  'scan': 'spacemolt',
  'distress_signal': 'spacemolt',
  'self_destruct': 'spacemolt',
  'install_mod': 'spacemolt',
  'uninstall_mod': 'spacemolt',
  'repair': 'spacemolt',
  'repair_module': 'spacemolt',
  'refuel': 'spacemolt',
  'get_achievements': 'spacemolt',
  'accept_mission': 'spacemolt',
  'complete_mission': 'spacemolt',
  'abandon_mission': 'spacemolt',
  'decline_mission': 'spacemolt',

  // Ship commands
  'browse_ships': 'spacemolt_ship',
  'buy_listed_ship': 'spacemolt_ship',
  'list_ships': 'spacemolt_ship',
  'switch_ship': 'spacemolt_ship',
  'sell_ship': 'spacemolt_ship',
   'commission_ship': 'spacemolt_ship',
   'commission_status': 'spacemolt_ship',
  'cancel_commission': 'spacemolt_ship',
  'list_ship_for_sale': 'spacemolt_ship',
  'cancel_ship_listing': 'spacemolt_ship',
  'commission_quote': 'spacemolt_ship',
  'refit_ship': 'spacemolt_ship',
  'rename_ship': 'spacemolt_ship',
  'supply_commission': 'spacemolt_ship',

  // Storage commands (actions differ from command names)
   'deposit_items': 'spacemolt_storage',
   'withdraw_items': 'spacemolt_storage',
   'view_storage': 'spacemolt_storage',
   'view_faction_storage': 'spacemolt_storage',
   'send_gift': 'spacemolt_storage',
   'faction_deposit_items': 'spacemolt_storage',  // auto-add target: 'faction'
   'faction_withdraw_items': 'spacemolt_storage', // auto-add source: 'faction'
   'faction_deposit_credits': 'spacemolt_storage', // auto-add item_id: 'credits', target: 'faction'
   'faction_withdraw_credits': 'spacemolt_storage', // auto-add item_id: 'credits', source: 'faction'
   'withdraw_credits': 'spacemolt_storage', // auto-add item_id: 'credits' (self withdrawal)
   'storage': 'spacemolt_storage',

  // Market commands
  'view_market': 'spacemolt_market',
  'view_orders': 'spacemolt_market',
  'subscribe_market': 'spacemolt_market',
  'unsubscribe_market': 'spacemolt_market',
  'create_buy_order': 'spacemolt_market',
  'create_sell_order': 'spacemolt_market',
  'cancel_order': 'spacemolt_market',
  'modify_order': 'spacemolt_market',
  'estimate_purchase': 'spacemolt_market',
  'analyze_market': 'spacemolt_market',

   // Faction commands
  'create_faction': 'spacemolt_faction',
  'join_faction': 'spacemolt_faction',
  'leave_faction': 'spacemolt_faction',
  'faction_prepay_tax': 'spacemolt_faction', // action 'prepay_tax' (spacemolt_faction/prepay_tax)

   // Tax commands
   'prepay_tax': 'spacemolt',
   'get_faction_tax_estimate': 'spacemolt_faction',
   'faction_info': 'spacemolt_faction',
  'faction_list': 'spacemolt_faction',
  'faction_invite': 'spacemolt_faction',
  'faction_kick': 'spacemolt_faction',
  'faction_accept_peace': 'spacemolt_faction',
  'faction_declare_war': 'spacemolt_faction',
  'faction_decline_invite': 'spacemolt_faction',
  'faction_get_invites': 'spacemolt_faction',
  'faction_set_ally': 'spacemolt_faction',
  'faction_set_enemy': 'spacemolt_faction',
  'faction_propose_peace': 'spacemolt_faction',
  'faction_remove_ally': 'spacemolt_faction',
  'faction_remove_enemy': 'spacemolt_faction',
  'faction_rooms': 'spacemolt_faction',
  'faction_visit_room': 'spacemolt_faction',
  'faction_list_missions': 'spacemolt_faction',

  // Faction commerce (only orders - credits moved to storage)
  'faction_create_buy_order': 'spacemolt_faction_commerce',
  'faction_create_sell_order': 'spacemolt_faction_commerce',

  // Faction admin
  'faction_edit': 'spacemolt_faction_admin',
  'faction_create_role': 'spacemolt_faction_admin',
  'faction_edit_role': 'spacemolt_faction_admin',
  'faction_post_mission': 'spacemolt_faction_admin', // spacemolt_faction_admin/post_mission
  'faction_promote': 'spacemolt_faction_admin',
  'faction_write_room': 'spacemolt_faction_admin',

  // Faction admin actions that actually live under spacemolt_faction
  'faction_delete_role': 'spacemolt_faction',    // spacemolt_faction/delete_role
  'faction_cancel_mission': 'spacemolt_faction', // spacemolt_faction/cancel_mission
  'faction_delete_room': 'spacemolt_faction',    // spacemolt_faction/delete_room

  // Social commands
  'chat': 'spacemolt_social',
  'captains_log_add': 'spacemolt_social',
  'captains_log_get': 'spacemolt_social',
  'captains_log_list': 'spacemolt_social',
  'create_note': 'spacemolt_social',
  'read_note': 'spacemolt_social',
  'write_note': 'spacemolt_social',
  'get_action_log': 'spacemolt_social',
  'get_chat_history': 'spacemolt_social',
  'forum_create_thread': 'spacemolt_social',
  'forum_reply': 'spacemolt_social',
  'forum_list': 'spacemolt_social',
  'forum_get_thread': 'spacemolt_social',
  'forum_upvote': 'spacemolt_social',
  'forum_delete_thread': 'spacemolt_social',
  'forum_delete_reply': 'spacemolt_social',
  'set_colors': 'spacemolt_social',
  'set_status': 'spacemolt_social',

  // Catalog
  'catalog': 'spacemolt_catalog',

  // Intel
  'faction_submit_intel': 'spacemolt_intel',
  'faction_query_intel': 'spacemolt_intel',
  'faction_submit_trade_intel': 'spacemolt_intel',
  'faction_query_trade_intel': 'spacemolt_intel',
  'faction_intel_status': 'spacemolt_intel',
  'faction_trade_intel_status': 'spacemolt_intel',

  // Facility (special: uses /tool/{action} pattern)
  'facility': 'spacemolt_facility',

   // Battle
   'battle': 'spacemolt_battle',
   'get_battle_status': 'spacemolt_battle',
   'reload': 'spacemolt_battle',

   // Observation
   'subscribe_observation': 'spacemolt',

  // Salvage
  'get_wrecks': 'spacemolt_salvage',
  'loot_wreck': 'spacemolt_salvage',
  'scrap_wreck': 'spacemolt_salvage',
  'tow_wreck': 'spacemolt_salvage',
  'sell_wreck': 'spacemolt_salvage',
  'release_tow': 'spacemolt_salvage',
  'buy_insurance': 'spacemolt_salvage',
  'claim_insurance': 'spacemolt_salvage',
  'get_insurance_quote': 'spacemolt_salvage',
  'view_insurance': 'spacemolt_salvage',
   'set_home_base': 'spacemolt_salvage',
   'claim_prize': 'spacemolt_salvage',
   'service_prize': 'spacemolt_salvage',

  // Fleet
  'fleet': 'spacemolt_fleet',
};

// Maps commands to their API action names (when different from command name)
export const COMMAND_ACTION_MAP: Record<string, string> = {
  // Battle
  'get_battle_status': 'status',      // spacemolt_battle_status -> action is 'status'

  // Storage (actions differ from command names)
  'deposit_items': 'deposit',          // spacemolt_storage/deposit
  'withdraw_items': 'withdraw',        // spacemolt_storage/withdraw
  'view_storage': 'view',              // spacemolt_storage/view
   'faction_deposit_items': 'deposit',    // auto-add target: 'faction'
   'faction_withdraw_items': 'withdraw',   // auto-add source: 'faction'
   'faction_deposit_credits': 'deposit',   // auto-add item_id: 'credits', target: 'faction'
   'faction_withdraw_credits': 'withdraw', // auto-add item_id: 'credits', source: 'faction'
    'send_gift': 'deposit',                // gift = deposit with target=<player name>
    'withdraw_credits': 'withdraw',        // auto-add item_id: 'credits' (self withdrawal)
    'get_faction_tax_estimate': 'tax_estimate',

  // Faction storage
  'view_faction_storage': 'view',  // auto-add source: 'faction'
  'create_faction': 'create',
  'join_faction': 'join',
  'leave_faction': 'leave',
  'faction_prepay_tax': 'prepay_tax', // spacemolt_faction/prepay_tax
  'faction_info': 'info',
  'faction_list': 'list',
  'faction_invite': 'invite',
  'faction_kick': 'kick',
  'faction_accept_peace': 'accept_peace',
  'faction_declare_war': 'declare_war',
  'faction_decline_invite': 'decline_invite',
  'faction_get_invites': 'get_invites',
  'faction_set_ally': 'propose_ally',
  'faction_set_enemy': 'set_enemy',
  'faction_propose_peace': 'propose_peace',
  'faction_remove_ally': 'remove_ally',
  'faction_remove_enemy': 'remove_enemy',
  'faction_rooms': 'rooms',
  'faction_visit_room': 'visit_room',
  'faction_list_missions': 'list_missions',

   // Faction commerce (remove 'faction_' prefix) - orders only, credits moved to storage
   'faction_create_buy_order': 'create_buy_order',
   'faction_create_sell_order': 'create_sell_order',


   // Faction admin (remove 'faction_' prefix)
   'faction_edit': 'edit',
   'faction_create_role': 'create_role',
   'faction_edit_role': 'edit_role',
   'faction_delete_role': 'delete_role',
   'faction_post_mission': 'post_mission',
   'faction_cancel_mission': 'cancel_mission',
   'faction_promote': 'promote',
   'faction_write_room': 'write_room',
   'faction_delete_room': 'delete_room',

   // Intel (remove 'faction_' prefix)
   'faction_submit_intel': 'submit_intel',
   'faction_query_intel': 'query_intel',
   'faction_submit_trade_intel': 'submit_trade_intel',
   'faction_query_trade_intel': 'query_trade_intel',
   'faction_intel_status': 'intel_status',
   'faction_trade_intel_status': 'trade_intel_status',

   // Catalog
   'catalog': 'catalog',

   // Salvage (map command names to API action names)
   'get_wrecks': 'wrecks',
   'loot_wreck': 'loot',
   'tow_wreck': 'tow',
   'sell_wreck': 'sell',
   'scrap_wreck': 'scrap',
 'release_tow': 'release',
   'buy_insurance': 'insure',
   'claim_insurance': 'policies', // spacemolt_salvage/policies returns ClaimInsuranceResponse
   'get_insurance_quote': 'quote',
    'view_insurance': 'policies',
  'set_home_base': 'set_home',
 };

// Commands that use payload.action for the action (like facility and battle)
export const COMMANDS_WITH_PAYLOAD_ACTION = new Set(['facility', 'battle', 'storage', 'fleet']);

/**
 * Normalize a library command result into the bare `{ result }` envelope the
 * rest of the runner consumes.
 *
 * The library returns a few different envelopes depending on the command kind:
 *   - Query:    `{ structuredContent: T }`
 *   - Mutation: `{ delta: StateDelta & { details?: TDetails } }`  (the
 *               action result, e.g. MineResponse, lives under `delta.details`)
 *   - Raw:      the result object itself (e.g. a MineResponse) with no
 *               `delta`/`structuredContent`/`result` wrapper at all.
 *
 * Previously only `delta.details` was honored, so when the facade resolved a
 * mutation to its raw result body (no `delta` wrapper) the value collapsed to
 * `undefined` — callers like `mine` then saw no resource id/quantity and
 * logged "Mined 1x unknown". We now also fall back to a top-level `details`
 * and finally to the raw body so the action result is never lost.
 */
export function extractLibResult(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;

  if ("delta" in r) {
    const d = r.delta;
    if (
      d &&
      typeof d === "object" &&
      "details" in d &&
      (d as Record<string, unknown>).details
    ) {
      return (d as Record<string, unknown>).details;
    }
    return d;
  }
  if ("structuredContent" in r && r.structuredContent && typeof r.structuredContent === "object") {
    const sc = r.structuredContent as Record<string, unknown>;
    const hasData = Object.values(sc).some((v) => {
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === "object") return Object.keys(v).length > 0;
      return v !== null && v !== undefined && v !== "";
    });
    if (hasData) {
      return sc;
    }
  }
  if ("details" in r && r.details) {
    return r.details;
  }
  if ("result" in r) {
    return r.result;
  }
  // No recognized wrapper — the body is the result itself.
  return raw;
}

/**
 * Pure translation of a legacy `exec(command, params)` call into the typed
 * `account.send(tool, action, params)` facade. Both `bot.ts` `libExec` (the
 * path every runtime `bot.exec` call site uses) and `commandBridge.ts`
 * `libExecute` (the CLI/drone path) must route through this single function so
 * the param renames below can never drift between the two dispatch surfaces.
 */
export interface LibDispatch {
  tool: string;
  action: string;
  body: Record<string, unknown>;
}

export function buildLibDispatch(
  command: string,
  payload?: Record<string, unknown>,
): LibDispatch {
  const tool = COMMAND_TOOL_MAP[command] || "spacemolt";
  let action = COMMAND_ACTION_MAP[command] || command;
  const body: Record<string, unknown> = payload ? { ...payload } : {};

  // Wrapper commands carry the real action in payload.action (battle/storage/facility/fleet).
  if (COMMANDS_WITH_PAYLOAD_ACTION.has(command) && payload?.action) {
    action = String(payload.action);
    delete body.action;
  }

  // Param translations (mirror api.ts makeHttpRequest so call sites stay unchanged).
  if (command === "faction_deposit_items" && !body.target) body.target = "faction";
  if (command === "faction_withdraw_items" && !body.source) body.source = "faction";
  if (command === "view_faction_storage" && !body.target) body.target = "faction";
  if (command === "faction_deposit_credits") {
    body.item_id = "credits";
    if (body.amount !== undefined) { body.quantity = body.amount; delete body.amount; }
    if (!body.target) body.target = "faction";
  }
  if (command === "faction_withdraw_credits") {
    body.item_id = "credits";
    if (body.amount !== undefined) { body.quantity = body.amount; delete body.amount; }
    if (!body.source) body.source = "faction";
  }
  if (command === "withdraw_credits") {
    body.item_id = "credits";
    if (body.amount !== undefined) { body.quantity = body.amount; delete body.amount; }
  }
  if (command === "prepay_tax" && body.amount !== undefined) { body.quantity = body.amount; delete body.amount; }
  // faction_prepay_tax posts to spacemolt_faction/prepay_tax, whose required
  // field is `amount` (NOT `quantity` like the personal prepay_tax). Keep it as-is.
  // Gifting is a storage DEPOSIT into someone else's locker:
  //   storage {action:"deposit", target:"<player>", item_id:"credits", quantity:N}
  // NOT a withdraw — `withdraw` only accepts target "self"/"faction" and rejects a
  // player name with `invalid_target: Cannot withdraw from another player's storage`.
  // Only default item_id to "credits" when the caller did not name an item/ship,
  // otherwise item gifts (rescue fuel cells, cargo mover) silently turn into credit
  // transfers.
  if (command === "send_gift") {
    if (body.recipient !== undefined) { body.target = body.recipient; delete body.recipient; }
    if (body.ship_id !== undefined && body.item_id === undefined) {
      // A stored ship instance UUID is passed as item_id for gift_ship.
      body.item_id = body.ship_id;
      delete body.ship_id;
      delete body.quantity;
    } else if (body.credits !== undefined) {
      body.item_id = "credits";
      body.quantity = body.credits;
      delete body.credits;
    } else if (body.item_id === undefined) {
      body.item_id = "credits";
      if (body.amount !== undefined) { body.quantity = body.amount; delete body.amount; }
    }
  }
  if (command === "find_route") {
    delete body.target_poi;
    if (body.target !== undefined && body.target_system === undefined) { body.target_system = body.target; delete body.target; }
  }
  if (command === "jump" && typeof body.target_system === "string") { body.id = body.target_system; delete body.target_system; }
  if (command === "jump" && body.target !== undefined && body.id === undefined) { body.id = body.target; delete body.target; }
  if (command === "jump" && body.target_poi !== undefined && body.id === undefined) { body.id = body.target_poi; delete body.target_poi; }
  if (command === "travel" && body.target_poi !== undefined) { body.id = body.target_poi; delete body.target_poi; }
  if (command === "set_home_base" && body.base_id !== undefined) { body.id = body.base_id; delete body.base_id; }

  return { tool, action, body };
}

/**
 * Dispatch a legacy command name through a connected library `Account`,
 * normalizing the typed `QueryResult`/`MutationResult` back into the legacy
 * `ApiResponse` shape (`.result` / `.notifications` / `.error`) so the CLI
 * agent stack and `drone.ts` can drive entirely through `@spacemolt/lib`
 * without the retired HTTP transport. Param translations mirror `bot.ts`
 * `libExec` / `api.ts` `makeHttpRequest` so call sites stay unchanged.
 *
 * Notifications arrive via the library's event subscriptions, not as a query
 * result, so `.notifications` is always empty here (the CLI buffers pushes via
 * `account.onAny`).
 */
export async function libExecute(
  account: Account,
  command: string,
  payload?: Record<string, unknown>,
  retries = 2,
): Promise<ApiResponse> {
  // Transport-level auth is already handled by connectOwned()/clerk — no-op.
  if (COMMAND_TOOL_MAP[command] === "spacemolt_auth") {
    return { result: { ok: true }, error: undefined, notifications: [] };
  }
  // Notifications arrive via event subscriptions, not as a query result.
  if (command === "get_notifications") {
    return { result: { notifications: [] }, error: undefined, notifications: [] };
  }

  const { tool, action, body } = buildLibDispatch(command, payload);

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await account.send(tool, action, body);
      const result = extractLibResult(res);
      return { result, error: undefined, notifications: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastErr = err instanceof Error ? err : new Error(message);
      // Only retry transport-level connection drops; surface everything else.
      if (!isConnectionError(message)) {
        return { error: { code: "lib_error", message }, result: undefined, notifications: [] };
      }
      if (attempt < retries) {
        // Back off briefly before the next attempt so the library/transport
        // can finish whatever reconnect it's doing.
        await new Promise((r) => setTimeout(r, Math.min(1000 * (attempt + 1), 5000)));
      }
    }
  }
  return { error: { code: "lib_error", message: lastErr?.message ?? "connection error" }, result: undefined, notifications: [] };
}
