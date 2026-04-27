/**
 * Fleet Hunter Commander routine â€” leads a fleet of subordinate hunters.
 *
 * Responsibilities:
 * - Decide patrol systems and POIs
 * - Send movement commands via local fleet communication
 * - Call targets for fleet to engage
 * - Coordinate fleet positioning during combat
 * - Order retreats when danger is detected
 * - Manage post-patrol logistics (dock, repair, resupply)
 *
 * Communication:
 * - Uses local fleet comm service (no faction chat spam)
 * - Commands: MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
 * - Optional: Also broadcast to faction chat if enableFactionBroadcast is true
 *
 * Settings (data/settings.json under "fleet_hunter"):
 *   fleetId              â€” unique identifier for this fleet
 *   patrolSystem         â€” system ID to patrol (default: current system)
 *   refuelThreshold      â€” fuel % to trigger refuel stop (default: 40)
 *   repairThreshold      â€” hull % to abort patrol and dock (default: 30)
 *   fleeThreshold        â€” hull % to flee an active fight (default: 20)
 *   maxAttackTier        â€” highest pirate tier to engage (default: "large")
 *   fleeFromTier         â€” pirate tier that triggers fleet flee (default: "boss")
 *   minPiratesToFlee     â€” number of pirates that triggers fleet flee (default: 3)
 *   fireMode             â€” "focus" (all fire same target) or "spread" (split targets)
 *   fleetSize            â€” expected number of subordinates (for coordination)
 *   huntingEnabled       â€” enable/disable hunting (default: true)
 *   manualMode           â€” manual control mode (default: false)
 *   enableFactionBroadcast â€” also send commands to faction chat (default: false)
 */

import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { fleetCommService } from "../fleet_comm.js";
import { getBotChatChannel } from "../botmanager.js";
import type { BotChatMessage } from "../bot_chat_channel.js";
import {
  findStation,
  isStationPoi,
  getSystemInfo,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  fetchSecurityLevel,
  scavengeWrecks,
  depositNonFuelCargo,
  ensureInsured,
  detectAndRecoverFromDeath,
  getModProfile,
  ensureModsFitted,
  readSettings,
  logStatus,
  getBattleStatus,
  fleeFromBattle,
} from "./common.js";
import {
  engageTarget,
} from "./battle.js";
 * Fleet Hunter Commander routine â€” leads a fleet of subordinate hunters.
 *
 * Responsibilities:
 * - Decide patrol systems and POIs
 * - Send movement commands via local fleet communication
 * - Call targets for fleet to engage
 * - Coordinate fleet positioning during combat
 * - Order retreats when danger is detected
 * - Manage post-patrol logistics (dock, repair, resupply)
 *
 * Communication:
 * - Uses local fleet comm service (no faction chat spam)
 * - Commands: MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
 * - Optional: Also broadcast to faction chat if enableFactionBroadcast is true
 *
 * Settings (data/settings.json under "fleet_hunter"):
 *   fleetId              â€” unique identifier for this fleet
 *   patrolSystem         â€” system ID to patrol (default: current system)
 *   refuelThreshold      â€” fuel % to trigger refuel stop (default: 40)
 *   repairThreshold      â€” hull % to abort patrol and dock (default: 30)
 *   fleeThreshold        â€” hull % to flee an active fight (default: 20)
 *   maxAttackTier        â€” highest pirate tier to engage (default: "large")
 *   fleeFromTier         â€” pirate tier that triggers fleet flee (default: "boss")
 *   minPiratesToFlee     â€” number of pirates that triggers fleet flee (default: 3)
 *   fireMode             â€” "focus" (all fire same target) or "spread" (split targets)
 *   fleetSize            â€” expected number of subordinates (for coordination)
 *   huntingEnabled       â€” enable/disable hunting (default: true)
 *   manualMode           â€” manual control mode (default: false)
 *   enableFactionBroadcast â€” also send commands to faction chat (default: false)
 */

import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { fleetCommService } from "../fleet_comm.js";
import { getBotChatChannel } from "../botmanager.js";
import type { BotChatMessage } from "../bot_chat_channel.js";
import {
  findStation,
  isStationPoi,
  getSystemInfo,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  navigateToSystem,
  fetchSecurityLevel,
  scavengeWrecks,
  depositNonFuelCargo,
  ensureInsured,
  detectAndRecoverFromDeath,
  getModProfile,
  ensureModsFitted,
  readSettings,
  sleep,
  logStatus,
  ensureFueled,
  getBattleStatus,
  fleeFromBattle,


