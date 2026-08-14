# SpaceMolt Bot Runner

> **A comprehensive fleet manager for [SpaceMolt](https://www.spacemolt.com) — manage unlimited automated bots from a single web dashboard.**

![Dashboard](https://img.shields.io/badge/interface-web_dashboard-blue) ![Runtime](https://img.shields.io/badge/runtime-bun-black) ![No Dependencies](https://img.shields.io/badge/deps-zero_runtime-green) ![Bots](https://img.shields.io/badge/bots-unlimited-orange) ![Language](https://img.shields.io/badge/language-TypeScript-blue) ![Platform](https://img.shields.io/badge/platform-cross--platform-green) ![License](https://img.shields.io/badge/license-MIT-yellow) ![Routines](https://img.shields.io/badge/routines-28_available-blueviolet)

---

## Table of Contents

- [What It Does](#what-it-does)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Bot Routines (28 Available)](#bot-routines)
  - [Economic Routines](#economic-routines)
  - [Combat Routines](#combat-routines)
  - [Coordination Routines](#coordination-routines)
  - [Utility Routines](#utility-routines)
- [Web Dashboard Features](#web-dashboard-features)
- [Advanced Multi-Bot Coordination](#advanced-multi-bot-coordination)
- [AI Integration](#ai-integration)
- [Combat System](#combat-system)
- [Rescue & Emergency Systems](#rescue--emergency-systems)
- [Galaxy Map & Exploration](#galaxy-map--exploration)
- [Security & Robustness](#security--robustness)
- [Drone Support](#drone-support)
- [Adding Bots](#adding-bots)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Testing](#testing)
- [About SpaceMolt](#about-spacemolt)
- [License & Credits](#license--credits)

---

## What It Does

Bot Runner is a **complete fleet management system** for [SpaceMolt](https://www.spacemolt.com), a text-based space MMO designed for AI agents. It provides:

- **Web Dashboard** — real-time monitoring, controls, and management at `http://localhost:3000`
- **28 Automated Routines** — mining, exploring, trading, combat, crafting, rescue, fuel selling, fuel transport, fuel service, module selling, civilian transport, market streaming, craft trade, stealth skill grind, anti-idle, and more
- **Multi-Bot Coordination** — flock mining, fleet combat, cargo hauling, trade routes, fuel logistics
- **AI-Powered Features** — LLM-driven autonomous play, intelligent chat responses, standalone CLI commander
- **Faction Management** — full in-game faction controls from your browser
- **Galaxy Map** — auto-built exploration data with filtering, pathfinding, and resource overlays
- **Zero Runtime Dependencies** — just Bun, no database, no frameworks
- **Cross-Platform** — runs on Windows, macOS (x64/ARM64), and Linux (x64/ARM64)

**Key Capabilities:**
- Run unlimited bots, each with independent routines and configurations
- Coordinate multiple bots for complex operations (flock mining, fleet combat, cargo moving, rescue cooperation, fuel logistics)
- Monitor everything from a live web dashboard with real-time WebSocket status updates
- Execute any game command manually from bot profile pages
- AI chat service with per-bot personalities, conversation memory, and channel-aware responses
- Automated rescue system with MAYDAY parsing, queue management, player reputation tracking, and billing
- Pirate avoidance with BFS-based stronghold proximity checks and temporary blacklisting
- Confederacy Customs inspection handling with AI-powered personality responses
- Mass disconnect detection and automatic restart via watchdog
- Battle interrupt detection across all routines (WebSocket + HTTP fallback)
- Skill level tracking with level-up notifications
- Player name discovery and persistent entity tracking (players, pirates, empire NPCs)
- Drone script management (mining, combat, repair, salvage, scout)
- Fuel transport logistics — move fuel cells between faction storage stations
- Pathfinder bearing calculations and travel time estimates
- Tax estimate tracking and comparison

**Architecture Highlights:**
- Single Bun process — no database, no external services
- File-based persistence in `data/` directory (JSON files, no database server needed)
- HTTP API v2 client with response caching, mutation-based cache invalidation, exponential backoff
- WebSocket push architecture from server to all connected browser tabs
- Session token persistence for instant reconnection across restarts
- Graceful shutdown with stats flush, bot stop, and optional session clearing on mass disconnect

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- A SpaceMolt account — register at [spacemolt.com/dashboard](https://www.spacemolt.com/dashboard) to get a registration code

### Install

```bash
git clone https://github.com/MotorMan/spacemolt_botrunner.git
cd spacemolt_botrunner
bun install
```

### Run

```
on windows:
watchdog.bat

on linux: sorry, i have not set that up yet, but you can still do:
bun start
but you would not get auto-restart for server patch/disconnects.
```

Open `http://localhost:3000` in your browser. Use `PORT=8080 bun start` for a different port.

**First-Time Setup:**
1. Open the dashboard at `http://localhost:3000`
2. Click **Register New** — enter a registration code from [spacemolt.com/dashboard](https://www.spacemolt.com/dashboard), pick a username and empire
3. The bot auto-logs in and appears in the dashboard table
4. Select a routine (e.g., Miner) and click **Start**
5. Add more bots and assign different routines to build your fleet

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Bun Process                          │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │  BotManager  │───▶│  Web Server  │──▶ Browser tabs  │
│  │ (entry point)│    │  (Bun.serve) │      (WebSocket)  │
│  └──────┬───────┘    └──────────────┘                   │
│         │                                               │
│  ┌──────▼───────┐    ┌──────────────┐                   │
│  │  Bot (×N)    │───▶│ SpaceMoltAPI │──▶ Game Server   │
│  │  (routines)  │    │  (HTTP v2)   │     (spacemolt)   │
│  └──────────────┘    └──────────────┘                   │
│         │                                               │
│  ┌──────▼───────┐    ┌──────────────┐                   │
│  │ AI Chat Svc  │    │ Map/Catalog  │                   │
│  │ (background) │    │ (persistent) │                   │
│  └──────────────┘    └──────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

### Core Modules

| Module | File | Purpose |
|--------|------|---------|
| **BotManager** | `src/botmanager.ts` (~1050 lines) | Entry point — discovers bots, starts web server, routes actions, manages AI chat service, mass disconnect detector, registers all 20 routines |
| **Bot** | `src/bot.ts` (~2525 lines) | Bot class — login, exec, status caching, routine runner, battle state, customs holds, skill tracking, pathfinder state |
| **API Client** | `src/api.ts` (~841 lines) | SpaceMolt REST client (V2) — session management, response caching, rate limiting, 502/524 retry, bandwidth monitoring, command-to-tool mapping |
| **Web Server** | `src/web/server.ts` (~1498 lines) | Bun.serve HTTP + WebSocket server, settings persistence, stats flushing, map data serving, fleet stats, bandwidth API |
| **Dashboard SPA** | `src/web/index.html` (~877KB) | Single-page application — dashboard, map, market, faction, shipyard, missions, stats, settings, bot profiles |
| **AI Chat Service** | `src/aichat_service.ts` (~2191 lines) | Global background service — monitors chat, per-bot personalities, conversation history, empire official filtering, map summary integration |
| **Map Store** | `src/mapstore.ts` (~2131 lines) | Galaxy map persistence — systems, POIs, connections, resources, market data, wormholes, BFS pathfinding, pathfinder bearing calculations |
| **Catalog Store** | `src/catalogstore.ts` (~362 lines) | Game catalog cache — items, ships, skills, recipes with 24h auto-refresh |
| **Session Manager** | `src/session.ts` (~118 lines) | Credential and session token persistence per bot |
| **Pathfinder** | `src/pathfinder.ts` | BFS pathfinding, bearing calculations, travel time estimates, landing predictions |
| **UI** | `src/ui.ts` (~509 lines) | Log routing, notification parsing, LLM debug formatting, YAML output, color-coded categories |
| **Debug** | `src/debug.ts` (~135 lines) | Per-bot and global debug logging, log rotation (200MB max) |
| **Customs** | `src/customs.ts` (~576 lines) | Confederacy Customs inspection service — detection, hold blocking, statistics, AI coordination |
| **Player Name Store** | `src/playernamestore.ts` (~720 lines) | Persistent player/pirate/NPC entity tracking with full details |
| **Faction Storage Cache** | `src/factionStorageCache.ts` (~218 lines) | Faction storage cache with debounced writes, per-station tracking |
| **Pilot Skill Tracker** | `src/pilotSkillTracker.ts` (~283 lines) | Pilot skill level tracking, XP gain logging, level-up detection |

### Data Flow

1. **BotManager** discovers saved bot sessions from `sessions/` directory on startup
2. Each **Bot** resumes its session (or performs full login) with staggered delays to avoid rate limiting
3. Bots run their assigned **routines** (async generators), executing game commands via the API client
4. The **API client** handles session creation, caching, retries, and error recovery automatically
5. **Log output** from each bot is routed through the Web Server to all connected browser tabs via WebSocket
6. The **Dashboard SPA** renders real-time status, map data, market info, and provides manual controls
7. All persistent data (map, catalog, settings, stats, player names) is saved to `data/` as JSON files

### Session Management

- **Session tokens** persisted to `sessions/<username>/session.json` for instant reconnection
- **Staggered startup** — 5s delay between session resumes, 13s between full logins (rate limit avoidance)
- **Session recovery** — up to 10 automatic session renewals before forcing full login
- **Failure tracking** — 3+ failures in 60 seconds triggers immediate full login (bypasses delay)
- **Mass disconnect** — 5+ bots losing sessions within 5 seconds triggers graceful shutdown + restart
- **Watchdog** (`watchdog.bat`) — restarts the process on exit code 100 (mass disconnect recovery), clears session files to force fresh logins

### File-Based Persistence

No database required. All state is stored as JSON files in `data/`:

| File | Purpose |
|------|---------|
| `settings.json` | Per-routine and per-bot configuration |
| `map.json` | Galaxy map (systems, POIs, connections, resources, market data) |
| `catalog.json` | Game catalog cache (items, ships, skills, recipes) |
| `stats.json` | Daily bot statistics (30-day retention) |
| `playerNames.json` | Discovered player/pirate/NPC names |
| `fullPlayerInfo.json` | Detailed entity info (faction, ship, location history) |
| `customsStops.json` | Customs inspection statistics |
| `rescueQueue.json` | Persistent rescue queue |
| `rescueBlackBook.json` | Player rescue reputation records |
| `ai_memory.json` | AI routine persistent memory |
| `ai_chat_memory.json` | AI chat conversation history |
| `pilotSkill.json` | Pilot skill level tracking |
| `skills.json` | Skill gain event log |
| `factionStorage.json` | Faction storage cache |
| `fcStations.json` | Fuel cell seller station tracking |
| `fuelTransfer.json` | Fuel transport trip tracking |
| `marketDetails.json` | Detailed market order data |
| `shipsForSale.json` | Ship listing data |
| `rawMissions.json` | Raw mission data from explorers |
| `facilities.json` | Facility type definitions |
| `taxes.json` | Tax estimate data |
| `main_logs.json` | Main log buffers (activity, broadcast, system, faction) |
| `IMPORTANTMESSAGES.json` | Important message tracking for AI chat |
| `personalities/*.md` | Per-bot AI chat personality definitions |
| `flock_signals/*` | Flock mining coordination files |
| `escort_signals/*` | Escort coordination files |
| `flock.json` | Flock group settings and assignments |
| `craftingLoadouts.json` | Crafting loadout configurations |
| `craft-goals.json` | Crafting goal configurations |
| `logs/debug.log` | Global debug log |
| `logs/{botName}_debug.log` | Per-bot debug logs |
| `logs/activity/{botName}_activity.log` | Per-bot activity logs |

---

## Bot Routines

The system includes **20 distinct automated routines**, each designed for specific gameplay roles. Bots can switch between routines at any time from the dashboard. Each routine is an async generator that yields state names as it progresses, allowing clean interruption and resumption.

### Economic Routines

#### ⛏️ Miner
Automated resource extraction with advanced coordination. (~5450 lines — the largest routine)

- **Auto-detects mining type** from ship modules (mining laser, gas harvester, ice harvester, radioactive equipment)
- **Supports all resource types:** ore, gas, ice, radioactive materials, deep core
- **Flock Mining:** Multi-bot coordinated mining with leader/follower roles via shared JSON files in `data/flock_signals/`
- **Deep Core Mining:** Hidden POI discovery with survey scanner + extractor equipment; supports partial miners (extractor-only) for known hidden POIs like `adamantite_core`
- **Field Test Mission:** Special handling for early-game extractor-only mining
- **Configurable:** target resources, cargo thresholds, deposit modes (storage/faction/sell)
- **Escort Integration:** Coordinate with combat escorts via faction chat, local signals, or file-based signaling
- **Stay-out-until-full mode** for extended mining trips
- **Ore jettison lists** for regular, deep core, and radioactive mining
- **Depletion timeout tracking** with configurable expiry (default 3 hours) and ignore option
- **Mission acceptance/completion** for mining missions
- **Battle interrupt handling** — detects combat during mining, flees immediately
- **Death detection and recovery** — handles respawn at home base
- **Persistent mining sessions** — activity tracking in `data/minerActivity.json` for crash recovery
- **Radioactive mining detection** — auto-detects radioactive equipment via `src/routines/miner_radioactive.ts`

#### 🔄 Trader
Automated buy/sell trading between stations with route optimization. (~3107 lines)

- **Trade route management** with working balance tracking (200k credits default)
- **Multi-bot coordination** — trade route locking via `data/tradeCoordination.json` prevents conflicts
- **Auto-insurance, auto-cloak, mod management** (ensures trade mods fitted)
- **Faction profit donation** support — auto-deposits excess credits above threshold
- **Pirate system avoidance** — BFS-based pathfinding skips dangerous systems
- **Trade session tracking** with persistent activity logs in `data/traderActivity.json`
- **Storage credit withdrawal** — checks station and faction storage for additional trading capital
- **Battle encounter handling** — immediate flee on combat detection
- **Death and recovery** — handles destruction and respawn

#### 🛒 Trade Buyer
Bulk purchasing of configured items from markets. (~1226 lines)

- **Configurable max spend** per item and total budget
- **Price limits** per item — won't buy above configured max price
- **Auto-travels** to stations with best prices
- **Minimum quantity** thresholds — skips stations with insufficient supply
- **Auto-insurance and auto-cloak** support
- **Session recovery** — handles interrupted buy sessions after crashes
- **Mod management** — ensures cargo mods fitted for maximum haul

#### 🏭 Faction Trader
Trading focused on faction economy — liquidates faction storage items. (~2052 lines)

- **Withdraws items from faction storage** and sells at best known buyer station
- **Never buys from markets** — pure liquidation routine
- **Configurable sell items** with per-item max quantity and min price
- **Station priority mode** — visits stations in configured order
- **Buy order coordination** — faction buy order locking via `data/factionTraderCoordination.json`
- **Persistent session tracking** for crash recovery
- **Faction storage cache** integration for efficient lookups

#### 🎨 Crafter
Automated crafting with intelligent material sourcing. (~1920 lines)

- **Goal-based crafting** with batch or round-robin processing
- **Auto-buy missing materials** from station market (configurable max price, budget, category exclusions)
- **Recursive prerequisite crafting** — automatically crafts sub-components up to 2 levels deep
- **Category-based crafting** (Refining, Components, Consumables, etc.)
- **Per-bot category assignments** and quota overrides
- **Uses all storage types:** personal, station, and faction storage
- **Filters out ship passive recipes** (cannot be crafted manually)
- **Crafting plan calculation** with profit analysis
- **Persistent crafting loadouts** in `data/craftingLoadouts.json`
- **Crafting goal management** via `src/routines/craft-goals.ts`

#### 🚚 Cargo Mover
Hauls specified items from source to destination station. (~2059 lines)

- **Multi-bot coordination** — item quantity locking allows 3-4 bots to work together on the same haul
- **Persistent activity tracking** in `data/cargoMoverActivity.json` for interruption recovery
- **Battle encounter handling** with state preservation
- **Automatic cleanup and resumption** after crashes/restarts
- **Destination types:** faction storage, personal storage, or `send_gift` to another bot
- **Source types:** faction storage or personal station storage
- **In-transit tracking** — prevents duplicate pickup after partial delivery via `src/routines/cargoMoverInTransit.ts`
- **Configurable per-item quantities** with total delivery targets
- **Coordination** via `src/routines/cargoMoverCoordination.ts`

#### 🧹 Cleanup
Consolidates scattered station storage to faction home base. (~1123 lines)

- **Storage hint detection** — parses `view_storage` hint field to discover which stations have stored items/credits
- **Remote station inspection** via `view_storage(station_id=...)` before traveling
- **Only visits stations** that have items/credits to collect
- **Efficient routing** to minimize travel time
- **Order cleanup** — also checks and cancels stale orders via `view_orders`
- **Mobile capital station tracking** for dynamic faction home locations
- **Focus station mode** — can target a single specific station

#### ⛽ Fuel Cell Seller
Travels to non-pirate stations posting fuel cell sell orders. (~798 lines)

- **Starts at faction home base** with maximum fuel cells
- **Auto-pricing** — midpoint between min/max or manual price override
- **Tracks placed orders** in `data/fcStations.json` with order history, remaining quantities, and fill tracking
- **Visits each configured station** and creates sell orders
- **Returns home to restock** and repeats
- **Pirate system avoidance** — only visits safe stations
- **Order status tracking** — monitors active orders, filled quantities, and unsold inventory

#### 🚛 Fuel Transport
Transfers fuel cells (and other items) from faction home storage to remote faction stations. (~535 lines)

- **Withdraws from home faction storage** and delivers to remote stations
- **Deposits to faction or personal storage** at destination — tries faction first, falls back to personal
- **Configurable stations and items** — target quantities per station per item
- **Trip tracking** — persistent delivery records in `data/fuelTransfer.json` with full event history
- **Auto-routing** — navigates home to withdraw, then to each remote station
- **Cargo-aware** — calculates item size and available cargo space before withdrawing
- **Battle and death handling** — standard safety checks integrated
- **Fleet activity logging** — logs deposits to faction activity via `logFactionActivity`

---

### Combat Routines

#### 🎯 Hunter
Patrols systems hunting pirate NPCs for bounties and loot. (~1515 lines)

- **Combat stances:** Fire (default), Brace (shields critical), Flee (hull critical)
- **Pirate tier filtering** (small/medium/large/capitol/boss) — configurable max attack tier
- **Auto-cloak support** for stealth approach
- **Ammo management** with automatic reload and configurable threshold
- **Huntable system detection** — identifies low security, frontier, lawless systems
- **BFS-based** nearest huntable/safe system finding
- **Mission completion, loot selling, ship insurance** — full post-patrol logistics
- **Mod management** — ensures combat modules fitted
- **Battle analysis** — evaluates existing battles before joining

#### ⚓ Fleet Hunter Commander
Leads a fleet of subordinate hunter bots in coordinated combat. (~1897 lines)

- **Decides patrol systems and POIs** for the fleet
- **Fleet commands:** MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
- **Fire modes:** Focus fire (all target one) or spread fire (independent targets)
- **Local fleet communication** — in-memory event system (no faction chat spam) via `src/fleet_comm.ts`
- **Optional faction chat broadcast** for wider coordination
- **Post-patrol logistics** — dock, repair, resupply automation
- **BFS-based safe system finding** for emergency retreat
- **Manual mode** — allows human to take control via dashboard

#### 🛡️ Fleet Hunter Subordinate
Follows commander's orders in fleet combat operations. (~637 lines)

- **Receives and executes** fleet commands via local communication
- **Combat stance management** (fire/brace/flee)
- **Pirate tier filtering** — respects commander's max attack tier
- **Auto-flee** when hull critical, then regroup at safe system
- **Battle commands:** BATTLE_ADVANCE, BATTLE_RETREAT, BATTLE_STANCE, BATTLE_TARGET

#### 🔧 Salvager
Travels POI to POI scavenging wrecks for valuable loot. (~1405 lines)

- **Full salvage mode** — complete wreck processing including modules
- **Towing support** — tow wrecks to salvage yard stations for maximum value
- **Module looting** — recover ship modules from wrecks with condition tracking
- **Loot All functionality** — one-click clearing of entire wrecks
- **Scrap preference** for processing
- **Roaming mode** with configurable base systems and max jumps
- **Salvage yard station detection** — known stations per empire
- **Mobile capital station tracking** for dynamic salvage yard locations
- **Flock salvage coordination** — multi-bot wreck claiming via shared state files
- **Temporary pirate blacklisting** — avoids systems with recent pirate activity

---

### Coordination Routines

#### 🛡️ Escort
Follows and protects a specified bot (typically a miner). (~1254 lines)

- **Tracks target's position** via bot-to-bot chat channel, fleet status, or file-based coordination via `src/cooperation/rescueCooperation.ts`
- **Multiple escorts** can follow one target simultaneously
- **Engages threats automatically** — both proactive (scanning) and reactive (battle pull)
- **Combat stance management** (fire/brace/flee)
- **Pirate tier filtering** — configurable max attack tier and flee-from tier
- **Ammo management** with automatic reload
- **Auto-cloak support**
- **Signal channel** — configurable communication channel for coordination

#### 🤖 AI
Uses an LLM to play SpaceMolt autonomously. (~920 lines)

- **Works with Ollama, LM Studio, vLLM, OpenAI, Anthropic, Groq, xAI, Mistral, OpenRouter** — any OpenAI-compatible endpoint
- **Tool-calling:** Game actions exposed as AI tools (execute any command, query state, read/write memory) via `src/tools.ts`
- **Persistent memory** in `data/ai_memory.json` — goals, insights, decisions across sessions
- **Captain's log entries** for periodic state summaries and long-term context
- **TODO tracking** — goal-oriented behavior with task lists
- **Session handoff** — clean restarts with state preservation via `src/loop.ts`
- **Context compaction** — handles long-running sessions by summarizing older messages (55% context budget)
- **OpenAPI spec loading** — fetches game command documentation for the LLM via `src/schema.ts`
- **Configurable model, cycle interval, max tool calls per cycle**
- **Model resolution** via `src/model.ts` using `pi-ai` library

#### 📊 Coordinator
Market analysis and craft order management. (~957 lines)

- **Fetches global market data** from `https://game.spacemolt.com/api/market`
- **Auto-adjusts** ore mining targets and craft limits based on market demand
- **Buy/sell order management** with budget limits and configurable expiry
- **Faction storage budget management** — tracks and limits faction credit usage
- **Recipe profit calculation** — analyzes crafting profitability across all known recipes
- **Configurable cycle interval** (default 300s) for market data refresh
- **Max buy/sell order limits** to prevent over-commitment

---

### Utility Routines

#### 🆘 Rescue / Fuel Rescue
Monitors fleet for stranded bots, delivers fuel cells or credits. (~6573 lines — the most complex routine)

- **MAYDAY handling** — parses emergency distress messages with regex via `src/mayday.ts`, validates legitimacy (fuel threshold check)
- **Pirate awareness** — BFS-based pirate stronghold proximity checks, MAYDAY lockouts near pirate bases
- **Pirate trap detection** — detects false flag operations using own bot names
- **Rescue cooperation** — multi-bot coordination via bot chat channel (distance-based priority, round-robin for ties) via `src/cooperation/rescueCooperation.ts`
- **Rescue queue** — route-optimized batch rescues with persistent queue in `data/rescueQueue.json` via `src/rescueQueue.ts`
- **Rescue BlackBook** — player reputation tracking (ghosts, successful rescues, billing) in `data/rescueBlackBook.json` via `src/rescueBlackBook.ts`
- **Rescue billing system** — charges per jump and fuel delivered
- **Target verification** before rescue (checks if target still needs help)
- **Customs inspection awareness** during rescue operations
- **Consecutive failure tracking** — aborts after 3 failed attempts to prevent spam loops
- **Blacklist validation** — refuses rescues to unreachable systems
- **Manual rescue requests** — dashboard-initiated rescues via `src/manualrescue.ts` and the bot profile page
- **Persistent rescue sessions** — activity tracking in `data/rescueActivity.json` via `src/routines/rescueActivity.ts`
- **Claim system** — bots claim rescues to prevent duplicate work, with 5-minute expiry
- **Rescue coordination tracking** — multi-bot announcement tracking via `src/rescuecoordination.ts`

#### 🧭 Explorer
Systematically maps the galaxy by visiting every POI. (~3560 lines)

- **Three modes:** `explore`, `trade_update`, `deep_core_scan`
- **POI classification:** scenic (visit once), resource (re-scan periodically), station (refresh market/missions)
- **System survey** to reveal hidden POIs (wormholes, secret ore belts)
- **Wormhole detection** and registration in map store with expiry tracking
- **Pirate avoidance** — BFS-based pirate stronghold proximity checks, temporary blacklisting, emergency flee
- **Focus area mode** — concentrate exploration on specific systems
- **Quick vs. thorough survey** modes
- **Scavenge wrecks** option during exploration
- **Load fuel cells at home** for long-range exploration
- **Direct-to-unknown** and group-unknowns navigation options
- **Auto-accepts exploration missions**
- **Market data recording** — saves detailed market orders to `data/marketDetails.json`
- **Ship listing recording** — saves shipyard data to `data/shipsForSale.json`
- **Mission recording** — saves raw mission data to `data/rawMissions.json`
- **Security level fetching** — records system security for route planning

#### 🏠 Return Home
Navigates bot back to configured home base. (~363 lines)

- **Emergency trigger** from dashboard — stops all running bots and sends them home
- **Per-bot home system/station** configuration with global fallback
- **15-second stop timeout** — waits for bots to stop gracefully, then forces state reset
- **2-second delay** after stop to let in-progress API calls complete
- **Refuel threshold** checking during journey
- **Battle check** before starting — won't navigate while in combat

#### 📡 Command Receiver
Keeps bot running and ready to receive manual commands. (~30 lines)

- **Minimal loop**, standing by for fleet-wide commands from the "Command All" dashboard tab
- **Emergency override** capability — can interrupt other routines

---

#### ��� Fuel Service
Automated fuel production facility management across multiple empire stations. (~1168 lines)

- **Automated facility management** — builds/manages fuel facilities (peroxide_reaction_cell, hydrogen_processor, etc.) at remote faction stations
- **Material transport** — hauls build materials from home faction storage to remote stations with resume capability
- **Remote fuel reserve monitoring** — checks `faction_fuel_reserve` without traveling to the station
- **Global craft queue monitoring** — reads queue from anywhere via `craft action=queue`
- **Best logistics ship selection** — picks highest cargo capacity ship at startup for all transport runs
- **Multi-empire support** — configurable target empires (Solarian, Voidborn, Nebula, Crimson, Outer Rim)
- **Facility build failure tracking** — 3 strikes = give up on that station/facility
- **Configurable refresh interval** (default 300s)

**Settings:** `stations[]`, `facilityConfigs[]`, `serviceAllEmpires`, `useAllStationsInEmpire`, `targetEmpires[]`, `refreshIntervalSec`, `refuelThreshold`, `repairThreshold`, `autoCloak`

---

#### ��� Module Seller
Sells ship modules (weapon/defense/utility slots) from faction storage. (~546 lines)

- **Smart pricing** — premium (+N%) or undercut (-N cr) modes
- **Auto-destination** — finds best buy-order station automatically from map data
- **Per-module config** — `maxQty`, `doNotSell`
- **Battle-aware** — periodic flee stance re-issue while in combat
- **Returns home** after each sell cycle
- **Configurable price floor** (100 cr minimum)

**Settings:** `homeSystem`, `homeStation`, `fuelCostPerJump`, `refuelThreshold`, `repairThreshold`, `priceMode`, `premiumPct`, `undercutCr`, `sellAtHome`, `maxQtyDefault`, `moduleItems[]`

---

#### ��� Civilian Transport
Passenger transport between stations with berth management. (~3694 lines — largest routine)

- **Berth management** — economy/business/first class with configurable limits per class
- **Cloaking support** — auto-recloak logic when decloaked
- **Transit Lounge handoff** — `unload_passenger target=lounge` for multi-bot relay
- **Achievement logging** — per-bot permanent record of transported passengers (`data/CivTransportLogs/`)
- **Empire station routing** — 5 empires × 5-8 stations each with multi-empire support
- **Mobile station resolution** — mobile_capital via `find_route`
- **Station reference file** — `data/stationRef.json` for destination resolution
- **Pirate station blocking** + manual blocked station list
- **Faction credit deposit threshold** — auto-deposits excess credits
- **Passenger priority filtering** — first/business/economy/off
- **Fleet ship discovery** — via `list_ships` with berth detection from modules/catalog
- **Persistent state** — `data/civilianTransport.json`

**Settings:** `maxJumps`, `roundsBeforeMoving`, `refuelThreshold`, `repairThreshold`, `homeSystem`, `homeStation`, `maxPassengers`, `maxEconomy`, `maxBusiness`, `maxFirst`, `blockPirateStations`, `blockedStationIds[]`, `passengerPriority`, `allowFirstClass`, `allowBusinessClass`, `allowEconomyClass`, `announceDestination`, `disableFactionMessage`, `enableCloak`, `factionDepositThreshold`

---

#### ��� Market
Market data streaming and collection routine. (~178 lines)

- **Market streaming** — subscribes to `subscribe_market` WebSocket for real-time updates
- **Docked collection** — collects market data while docked at stations
- **In-memory overlay** — publishes to `marketStreamStore` for instant routine access
- **Batched persistence** — writes to `marketDetails.json` via `marketDetailsStore` (2-min cadence)
- **Cross-client queries** — feeds `market_local_source` for remote market queries (~200B vs 10MB)
- **Heartbeat mechanism** — multi-client market routine detection

---

#### ������ Stealth Skill Grind
Simple cloaking loop for stealth skill XP. (~99 lines)

- **Cloak on/off loop** — 100ms each for stealth skill XP gain
- **Auto-dock and refuel** — when fuel < 5%
- **Runs until stopped**

---

#### ��� Pathfinder Test
Pathfinder bearing calculation testing routine.

---

#### ������ Craft Trade
Dual-role routine combining traders + single crafter via persisted order file + bot chat ping. (~664 lines)

- **Dual-role** — TRADERS (10+ bots) + CRAFTER (1 bot) in single routine
- **Traders** — find profitable deals for *craftable* items using market spreads + `analyze_market` insights
- **Crafter** — reads build orders from `data/craft_trade_orders.json`, crafts on owned facilities, deposits to faction storage
- **Coordination** — persisted order file (source of truth) + bot chat ping for wake-up
- **Reuses existing logic** — trader.ts for deal finding, crafter.ts for crafting, faction_trader for sell validation
- **Per-bot role assignment** — via settings (`crafterBots[]`, `traderBots[]`)
- **Margin analysis** — skips deals below `minMarginPct` (default 10%)
- **Max concurrent orders** — per trader (default 3)
- **Order timeout** — auto-expiry (default 360 min)
- **Uncraftable item alerts** — profitable buyers but no recipe exists
- **Facility build alerts** — when crafter lacks required facility
- **Buy order locking** — prevents duplicate sells (via `factionTraderCoordination`)
- **Remote market query** — craft cost estimation via client sync
- **Faction profit donation** support

**Settings:** `crafterBots[]`, `traderBots[]`, `enabledCategories[]`, `minProfitPerUnit`, `minFacilityAlertProfit`, `maxDealQty`, `maxCargoValue`, `fuelCostPerJump`, `refuelThreshold`, `repairThreshold`, `homeSystem`, `homeStation`, `useAnalyzeMarket`, `forceOwnFacility`, `craftingPreset`, `blacklistedRecipes[]`, `craftingHomeBase`, `maxConcurrentOrders`, `orderTimeoutMin`, `minMarginPct`, `useRemoteMarketQuery`

---

#### ��� 1-Idle / Observation
Anti-idle routine with passive observation subscription. (~151 lines)

- **Session keepalive** — lightweight `get_nearby` every 30 seconds
- **Status refresh** — refreshes cargo + location so dashboard/status stays current
- **Passive observation subscription** — `subscribeToObservation` for live nearby object/system agent/signature updates
- **Auto-resubscribe** — when bot's location (system/POI) changes
- **Observation logging** — first 5 full payloads, then keys + snippets; pirate detection alert
- **Zero game actions** — never moves ship, safe for any idle bot
- **Clean unsubscription** — on routine exit or location change

---

## Web Dashboard Features

The dashboard is a **comprehensive single-page application** (~877KB HTML + 78KB CSS) delivered by the Bun HTTP server. Real-time updates are pushed to all connected browser tabs via WebSocket. The dashboard auto-detects the server's local network IP for LAN access.

### Dashboard Tab
- **Bot table** with real-time status: name, ship, state, credits, fuel, hull/shield, cargo, location
- **Fleet stats bar:** total credits, fuel, cargo, faction funds
- **Grid view** and **compact mode** for different screen sizes
- **Search/filter** by routine, status, name
- **Bulk start/stop** for idle/running bots
- **Emergency Return Home** button — stops all bots, waits for them to fully stop, then sends them home
- **Bandwidth monitor** — real-time inbound/outbound bandwidth usage across all bots via `/api/bandwidth`
- **Color-coded state indicators** — idle (gray), running (green), stopping (yellow), error (red)

### Command All Tab
- **Fleet-wide command execution** — sends any game command to all running bots simultaneously
- **Broadcast messages** to all bots via in-game chat
- **Emergency overrides** and manual interventions
- **Targeted commands** — can also single out individual bots

### Map Tab
- **Galaxy map visualization** built from explorer data
- **Filterable** by security level (high, medium, low, lawless, frontier)
- **Resource overlays** showing ore, gas, ice locations with richness data
- **Station markers** with market data, services, and mission info
- **Pathfinding display** between systems with BFS-calculated routes and pathfinder bearings
- **Wormhole tracking** — shown with destination and time remaining
- **Pirate sighting indicators** — systems with recent pirate activity
- **System detail panel** — click any system to see full POI list, connections, market data, missions

### Market Tab
- **Market data browser** across all known stations
- **Price comparison** tools — sort by best buy/sell prices
- **Trade opportunity** identification — highlights profitable routes
- **Order book viewer** — detailed buy/sell order quantities
- **Ship for sale** browser — ships listed at shipyards with stats and prices

### Missions Tab
- **Browse available missions** per system
- **View/claim/complete** active missions per bot
- **Mission tracking** and progress monitoring
- **Reward display** — credits and items

### Faction Tab
- **Full faction management** from the browser
- **Overview:** leader, members, treasury, allies/enemies/wars, deposit/withdraw credits
- **Members:** role management (recruit/member/officer/leader), kick, invite players, quick-invite bots
- **Storage:** view/deposit/withdraw faction items, missing lockbox detection and build prompts
- **Facilities:** list faction facilities, toggle on/off, check upgrades, build new facilities
- **Diplomacy:** set ally/enemy, declare war, propose/accept peace
- **Intel:** query intel by system/player, view intel status, trade intel

### Shipyard Tab
- **Ship buying/selling** interface with price comparison
- **Mod management** for ship customization — install/uninstall modules
- **Recipe browser** for ship components
- **Ship listing** — list owned ships for sale to other players
- **Commission management** — order custom ships, check status, claim finished ships

### Stats Tab
- **Daily statistics** per bot with 30-day retention
- **Faction activity logs** with filtering — deposits, withdrawals, item transfers
- **Performance metrics** and trends over time
- **Per-bot activity log** — full history of bot actions

### Catalog Tab
- **Game catalog browser** — items, ships, skills, recipes with search and filtering
- **Item details** — stats, size, category, recipe outputs, facility requirements
- **Ship browser** — stats, modules, cargo capacity, speed, tier
- **Skill tree viewer** — skill dependencies, XP requirements, bonuses
- **Recipe explorer** — components, outputs, facility types, crafting time

### Achievements Tab
- **Player achievement tracking** — progress and completion status
- **Achievement categories** — exploration, combat, trading, crafting, social
- **Progress bars** and unlock requirements
- **Per-bot achievement breakdown** for fleet-wide tracking

### Creatures Tab
- **Wildlife/creature data browser** — discovered creatures with stats
- **Creature details** — health, damage, loot tables, behavior
- **Location tracking** — where each creature type spawns
- **Kill statistics** and loot drop tracking

### Settings Tab
- **Per-routine configuration** for all 28 routines
- **Per-bot overrides** for individual customization
- **Global settings** — port, home system, blacklist, faction storage
- **Settings saved** to `data/settings.json` with corruption recovery
- **Tooltips and descriptions** for each setting

### Bot Profile Page
Click any bot name to access full manual control panel:

- **Navigation:** travel, jump, dock/undock with system/POI selection
- **Actions:** mine, scan, refuel, repair, survey system
- **Combat:** attack targets, set battle stance, flee, reload ammo
- **Market:** buy/sell with live market prices and quantity selection
- **Crafting:** craft with recipe browser, material availability checking
- **Storage:** deposit/withdraw station storage and faction storage
- **Social:** send gifts/credits between bots, auto-withdraw for recipient
- **Wreck Salvage:** scanner with loot all/loot selected/loot modules/tow/scrap
- **Fleet management:** faction operations, facility management, diplomacy
- **Custom Commands:** execute any game API call manually with raw parameter input
- **Activity log** — per-bot action history
- **Ship info** — current module list, ammo counts, cargo contents

### Additional Pages

- **Engineering Calculator** (`src/web/engineeringCalc.html`) — ship engineering calculations
- **Player Browser** (`src/web/players.html`) — browse known players, pirates, empire NPCs
- **Ship Marketplace** (`src/web/shipsforsale.html`) — browse ships for sale across the galaxy
- **Ship Simulator** (`src/web/shipSim.html`) — compare ship stats and simulate combat
- **Chat Server** (`src/web/chatserver.ts`, port 4000) — dedicated WebSocket chat server with REST API
  - **REST API** for bots, channels, messages, sending chat
  - **Full chat UI** served from same server
  - **Cross-instance** — connects to botrunner for bot operations

---

## Advanced Multi-Bot Coordination

### Flock Mining
Multiple miner bots coordinate to mine together at the same location, enabling protection by combat escorts.

- **Leader-Follower Model:** One bot decides where to mine, others follow
- **File-Based Coordination:** Shared JSON files in `data/flock_signals/` for communication via `src/routines/flock.ts`
- **Multiple Groups:** Configure multiple flocks, each targeting different ores
- **Automatic Target Selection:** Leader chooses optimal mining location based on richness and distance
- **Synchronized Navigation:** Followers wait for leader to jump first, then follow
- **Escort Integration:** Each flock member can have dedicated escorts
- **Stale State Detection:** 60-second timeout prevents following dead leaders
- **Configurable flock groups** with per-group target ore/gas/ice/radioactive
- **Rally system** — bots gather at a designated system before traveling to mining location

### Bot-to-Bot Chat Channel
In-memory, client-side communication for fast coordination **without** API calls via `src/bot_chat_channel.ts`.

- **Zero API calls** — pure in-process messaging
- **4 channels:** `fleet`, `escort`, `coordination`, `general`
- **Directed or broadcast** messaging — send to specific bots or all
- **Message history** (last 100 messages retained per channel)
- **Metadata support** for structured data (coordinates, timestamps, etc.)
- **Used by:** Escort, Fleet Hunter, Cargo Mover, Commander, Fuel Transport routines
- **Global logging** — all messages logged to system panel for human monitoring

### Fleet Combat
Coordinated multi-bot combat with commander/subordinate hierarchy via `src/fleet_comm.ts`.

- **Fleet Commands:** MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
- **Battle Commands:** BATTLE_ADVANCE, BATTLE_RETREAT, BATTLE_STANCE, BATTLE_TARGET
- **Fire Modes:** Focus fire (all target one) or spread fire (independent targets)
- **Fleet Communication Service** — in-memory command broadcasting
- **Optional Faction Broadcast** for wider coordination with non-bot allies
- **Post-Patrol Logistics** — dock, repair, resupply automation
- **BFS-based safe system finding** for emergency retreat
- **Fleet state tracking** — hunting enabled/disabled, manual/auto mode, current target

### Trade Coordination
Prevents multiple bots from competing on the same trade routes via `src/routines/traderCoordination.ts`.

- **Route Locking** via `data/tradeCoordination.json`
- **Item-level locking** — prevents two bots from buying the same item at the same station
- **Trade Session Tracking** with persistent activity logs
- **Working Balance Management** (200k credits default, configurable)
- **Stale lock cleanup** — automatically releases locks from crashed bots

### Cargo Mover Coordination
Allows 3-4 bots to work together on the same cargo haul via `src/routines/cargoMoverCoordination.ts` and `src/routines/cargoMoverInTransit.ts`.

- **Item Quantity Locking** — prevents over-commitment
- **Persistent Activity Tracking** in `data/cargoMoverActivity.json` for crash recovery
- **Automatic Resumption** after interruptions — picks up where it left off
- **In-Transit Tracking** — tracks items currently being carried to prevent duplicate pickup
- **Per-bot claimed quantity** — each bot knows exactly how much it's responsible for

### Rescue Cooperation
Multi-bot rescue coordination with distance-based priority via `src/cooperation/rescueCooperation.ts`.

- **Claim System:** Bots claim rescues via bot chat channel with distance and timestamp
- **Distance Optimization:** Closer bot (fewer jumps) takes priority
- **Round-Robin:** For equidistant bots, alternates who takes the rescue
- **Claim Expiry:** 5-minute timeout prevents stale claims
- **Partner Bot Caching** for faster coordination
- **Announcement parsing** — reads rescue announcements in faction chat to avoid duplicate work via `src/rescuecoordination.ts`
- **10-minute rescue active window** — assumes rescue completed or failed after this period

### Fuel Transport Coordination
Fuel transport bots coordinate to keep remote faction stations stocked.

- **Station prioritization** — services stations in configured order
- **Quantity targeting** — delivers until remote station reaches target quantity
- **Failsafe deposit** — tries faction deposit first, falls back to personal storage
- **Trip tracking** — full delivery history with timestamps and event logs in `data/fuelTransfer.json`
- **Cargo optimization** — calculates item size and available cargo space

### Civilian Transport Cooperation
Multi-bot passenger transport coordination via `src/client_sync_hooks.ts` and `src/bot_chat_channel.ts`.

- **Transit Lounge handoff** — Bots relay passengers via faction Transit Lounge at home base
- **Achievement cross-reference** — Per-bot logs (`data/CivTransportLogs/`) prevent duplicate passenger transport
- **Cross-client sync** — Passenger manifests synchronized across connected clients
- **Empire routing** — Coordinated multi-empire station coverage via shared stationRef.json

### Bot-to-Bot Chat Channel Enhancements
In-memory, client-side communication for fast coordination **without** API calls via `src/bot_chat_channel.ts`.

- **Zero API calls** — pure in-process messaging
- **4 channels:** `fleet`, `escort`, `coordination`, `general`
- **Directed or broadcast** messaging — send to specific bots or all
- **Message history** (last 100 messages retained per channel)
- **Metadata support** for structured data (coordinates, timestamps, etc.)
- **Used by:** Escort, Fleet Hunter, Cargo Mover, Commander, Fuel Transport, Civilian Transport, Craft Trade routines
- **Global logging** — all messages logged to system panel for human monitoring

---

### Client Sync / Multi-Instance Coordination
**Files:** `client_sync_master.ts`, `client_sync_slave.ts`, `client_sync_light_slave.ts`, `client_sync_market_slave.ts`, `client_sync_files.ts`, `client_sync_hooks.ts`, `client_sync_types.ts`

Master/Slave architecture for running multiple botrunner instances sharing data.

- **Catalog version orchestration** — Single client elected to download `catalog.json` from gameserver, then relayed to all clients (avoids rate limits)
- **Cross-client fleet rescue polling** — Rescue bots see combined fleet status across ALL connected clients via `getCombinedFleetStatus()`
- **File synchronization** — Deep-merges JSON data files across clients (map, market, player names, cargo mover, fuel transfer, etc.)
- **Market query handler** — Remote traders query local `marketDetails.json` via master (~200 bytes vs 10MB transfer)
- **Catalog sync state tracking** — Per-client version reporting with master-side election
- **Passenger/Civilian transport sync** — Multi-client passenger handoff coordination

**Modes:** `master`, `slave`, `light` (minimal sync), `market` (market-only slave)

---

### Clerk API / Headless Client Integration
**Files:** `libClient.ts`, `botmanager.ts` (connectLibraryAccounts)

Headless client connections using `@spacemolt/lib` for bots owned by different accounts.

- **Multiple Clerk API keys** — primary + secondary for bots owned by different accounts
- **Player selection UI** — Dashboard "Add Bots from Account" lists all owned players with empire info
- **Auto-connect selected bots** on startup via `@spacemolt/lib`
- **Session management** — Library handles WebSocket, reconnection, auth
- **Staggered connection** — 5s between resumes, 13s between full logins
- **Selected bot persistence** in `settings.clerk.bots` (normalized to usernames)

---

### Enhanced Bot Management & Resilience
**Files:** `botmanager.ts`, `bot.ts`

Major resilience improvements for large fleet operations.

- **Instant routine resume** — For large fleets (>100 bots default threshold): bots start their routine the moment they connect, not waiting for fleet-wide sequential resume
- **Reconnection backoff with load-aware scaling** — Exponential backoff (5s→120s) scaled by event loop lag via `loadMonitor.ts`
- **Terminal close handling** — `session_replaced` (4001) / `auth_timeout` (4002) detection — bots connected elsewhere are NOT auto-reconnected (prevents endless storms)
- **Old socket close waiting** — Before forcing reconnect, waits for old WebSocket to fully close (8s timeout + 750ms settle)
- **Reconnect deduplication** — In-flight guard prevents concurrent reconnect attempts for same bot
- **First-reconnect jitter** — Random 0-8s delay (scaled by load) to desynchronize fleet-wide reconnect storms
- **Performance monitoring** (`perf.ts`) — Operation timing with `perf.timeSync()`
- **Load monitoring** (`loadMonitor.ts`) — Event loop lag detection for adaptive scaling

---

## AI Integration

### AI Routine (Autonomous Gameplay)
Bots can play the game autonomously using LLMs via the `pi-ai` library.

- **Model Support:** Ollama, LM Studio, vLLM, OpenAI, Anthropic, Groq, xAI, Mistral, OpenRouter — any OpenAI-compatible endpoint
- **Tool-Calling:** Game actions exposed as AI tools — execute any game command, query state, read/write memory via `src/tools.ts`
- **Persistent Memory:** `data/ai_memory.json` stores goals, insights, and decisions across sessions
- **Captain's Log:** Periodic state summaries written to `captains_log_add` for long-term context
- **TODO Tracking:** Goal-oriented behavior with task lists (`update_todo` / `read_todo`)
- **Session Handoff:** Clean restarts with state preservation via `src/loop.ts` — the LLM picks up where it left off
- **Context Compaction:** Handles long-running sessions by summarizing older messages (55% of context window budget, minimum 10 recent messages preserved)
- **OpenAPI Spec Loading:** Fetches game command documentation from the server via `src/schema.ts` for the LLM's reference
- **Model Resolution:** `src/model.ts` resolves model strings to pi-ai provider instances
- **Configurable:** model, base URL, API key, cycle interval, max tool calls per cycle, captain's log frequency
- **Max 30 tool rounds per turn** with 120-second LLM timeout and 3 retries on failure

### AI Chat Service
Global background service that monitors chat and responds with personality via `src/aichat_service.ts`.

- **Runs independently** of bot routines — monitors all bots' chat simultaneously
- **Per-Bot Personalities:** `data/personalities/{bot-name}.md` — markdown files defining each bot's character
- **Conversation History:** `data/ai_chat_memory.json` — maintains context across conversations
- **Bot Locking:** Prevents multiple bots responding simultaneously to the same message
- **Map Summary Integration:** Galaxy context included in LLM prompts for informed responses
- **Channel Support:** Local, faction, system, and private chat — responds appropriately per channel
- **Empire Official Filtering:** Blocks responses to known NPCs (Chancellor, Pathfinder, Warlord, etc.)
- **Mayday Coordination:** AI-powered emergency response integration
- **Customs Responses:** Personality-based customs interaction
- **Admin Broadcast Detection:** Routes admin messages to the broadcast panel
- **Important Messages File:** `data/IMPORTANTMESSAGES.json` tracks messages that should not be responded to

### Commander CLI
Standalone AI commander tool (`src/commander.ts`, ~462 lines) for direct LLM-driven gameplay.

- **Usage:** `bun run src/commander.ts --model <provider/model-id> "your instruction here"`
- **Session support:** Named sessions for credential persistence
- **File-based instructions:** `--file <path>` to read instructions from a file
- **Debug mode:** `--debug` shows LLM call details (token counts, retries, raw payloads)
- **Examples:**
  ```bash
  bun run src/commander.ts --model ollama/qwen3:8b "mine ore and sell it until you can buy a better ship"
  bun run src/commander.ts --model anthropic/claude-sonnet-4-20250514 --session explorer "explore unknown systems"
  ```
- **Cross-platform binaries** released via GitHub Actions (Linux x64/ARM64, macOS x64/ARM64, Windows x64)

### AI Integration Enhancements
**Files:** `tools.ts`, `loop.ts`, `schema.ts`, `model.ts`

- **Expanded tool definitions** — Game commands, memory operations, TODO tracking, credential management via `src/tools.ts`
- **Context compaction** — 55% context budget, minimum 10 messages preserved via `src/loop.ts`
- **OpenAPI spec loading** — Fetches game command documentation for LLM via `src/schema.ts` and `src/openapi.ts`
- **Model resolution** — `src/model.ts` uses `pi-ai` library for provider/model resolution
- **Commander CLI** — Session support, debug mode, file-based instructions via `src/commander.ts`

---

## Combat System

### Battle Detection
- **Global WebSocket tracking** — real-time battle state updated even during HTTP 524 timeouts
- **Battle interrupt detection** for jump/travel/mine/jettison commands — checks `currentBattle.inBattle` flag
- **Participant parsing** for pirate identification and tier analysis
- **HTTP 502/524 retry** with 3 retries and exponential backoff (3s, 6s, 9s) — cancelled if battle detected
- **Action pending detection** — waits for server tick (~10s) then retries

### Combat Stances
- **Fire:** 100% attack, 100% defense (default)
- **Brace:** 0% attack, 2x shield regeneration (used when shields critical)
- **Flee:** Automatic retreat to safe system (triggered when hull critical)

### Pirate Detection & Avoidance
- **Nearby entity scanning** identifies pirates using keyword matching (drifter, pirate, raider, outlaw, bandit, corsair, marauder, hostile)
- **Battle participant analysis** detects pirate involvement in ongoing fights
- **Pirate tier system:** small (1), medium (2), large (3), capitol (4), boss (5)
- **Stronghold proximity checks** via BFS pathfinding — avoids systems near pirate strongholds
- **Temporary blacklisting** of pirate-adjacent systems (30-minute expiry)
- **Emergency flee** with random safe route selection using BFS
- **Pirate trap detection** in rescue operations — detects false flag operations using own bot names
- **Configurable flee thresholds** — max attack tier, flee-from tier, minimum pirates to trigger flee

### Combat Features
- **Ammo management** with automatic reload and configurable threshold
- **Auto-cloak** support for stealth approach
- **Mod management** — ensures combat modules fitted before engaging
- **Ship insurance** auto-renewal on dock
- **Wreck looting** — cargo items + ship modules with condition tracking
- **Wreck towing** to salvage yard stations for maximum scrap value
- **Wreck scavenging** during routine operations (miner, explorer)
- **Weapon module tracking** — per-module ammo counts from `get_status`
- **Battle analysis** — evaluates whether to join existing battles based on pirate count and tier

---

## Rescue & Emergency Systems

### MAYDAY System
Parses emergency distress messages from chat via `src/mayday.ts`.

- **Regex-based parsing** of MAYDAY messages: `"MAYDAY: <player> is stranded at <poi> in <system> with <current>/<max> fuel!"`
- **Legitimacy validation** — fuel must be below threshold (default 25%) to prevent ambushes
- **Queue management** with 5-minute expiry — stale requests auto-expire
- **Duplicate prevention** — unique per player/system/minute
- **Pirate base proximity lockouts** — refuses MAYDAY near pirate strongholds
- **False flag detection** — ignores MAYDAY from own bot names

### Rescue Queue
Route-optimized batch rescues via `src/rescueQueue.ts`.

- **Persistent queue** in `data/rescueQueue.json` — survives restarts
- **Attempt tracking** and failure handling — max 3 attempts per rescue
- **Route optimization** — batches rescues by system for efficient travel
- **Claim system** — bots claim rescues to prevent duplicate work
- **Stale claim cleanup** — 5-minute expiry on claims

### Rescue BlackBook
Player reputation tracking for rescue decisions via `src/rescueBlackBook.ts`.

- **Tracks per player:** rescue requests, ghost count, successful rescues, total credits billed
- **Manual override** support — `always` or `never` rescue per player
- **Auto-decision** based on ghost threshold (default 3 ghosts = blacklist)
- **Own bot marking** — prevents friendly bots from being blacklisted
- **Persistent** in `data/rescueBlackBook.json`

### Rescue Billing
Automated billing for rescue services.

- **Cost per jump** and **cost per fuel cell** delivered (configurable)
- **Invoice generation** for rescued players
- **BlackBook integration** — billing history tracked per player

### Emergency Features
- **Emergency Return Home:** Dashboard button stops all running bots (15s timeout), waits for full stop, then starts all bots with `return_home` routine
- **Emergency Warp Stabilizer detection:** Auto-stops routine if stabilizer triggers — logs emergency and requires new stabilizer before resuming
- **Mass disconnect handling:** Graceful shutdown + restart + session clearing when 5+ bots lose sessions within 5 seconds via `src/massdisconnect.ts`
- **Emergency fuel recovery:** Sell cargo, scavenge wrecks for fuel cells, wait for rescue, or dock and wait for station restock
- **Death detection and recovery:** All routines handle death/respawn — hull <= 0 detection with state reset on respawn
- **Reconnection queue** — global sequential reconnection with 25s delays via `src/reconnectqueue.ts` to avoid rate limiting during mass recovery

---

## Galaxy Map & Exploration

### Map Store
Auto-built galaxy map from explorer data with persistent storage via `src/mapstore.ts`.

- **System BFS pathfinding** for route calculation between any two systems
- **Station finding** with hop counting and service filtering
- **Market data recording** per station — best buy/sell prices, quantities
- **Resource scan data** tracking — ore richness, remaining amounts, depletion percentages
- **Ore depletion tracking** with configurable timeout (default 3 hours)
- **Wormhole registration** and tracking with expiry timestamps
- **Mobile capital location** tracking for dynamic faction homes
- **Seed from public API** (`/api/map`) for initial galaxy data on first run
- **Pirate sighting tracking** per system with timestamps
- **Mission recording** per station with rewards and level requirements
- **Order tracking** per station — buy/sell orders with player names
- **Persistent** in `data/map.json` with corruption recovery and atomic writes
- **POI classification** — scenic, resource, station types with visit-once vs. re-scan logic
- **Hidden POI tracking** — wormholes, secret ore belts with reveal difficulty ratings
- **15-second periodic push** to dashboard keeps map data current
- **Pathfinder integration** — bearing calculations and travel time estimates via `src/pathfinder.ts`

### Explorer Features
- **Systematic galaxy mapping** — visits every POI in every system
- **Hidden POI discovery** via survey scanners — reveals wormholes, secret ore belts
- **Three modes:**
  - `explore` — full galaxy exploration with all POI types
  - `trade_update` — refreshes market data and missions at known stations
  - `deep_core_scan` — focuses on systems with deep core mining potential
- **Pirate avoidance** with BFS proximity checks and temporary blacklisting
- **Focus area mode** — concentrate exploration on specific systems
- **Quick vs. thorough survey** modes for speed vs. completeness
- **Resource scanning** for ore/gas/ice locations with richness data
- **Security level filtering** — avoid dangerous systems
- **Market data collection** — records full order books to `data/marketDetails.json`
- **Ship listing collection** — records shipyard listings to `data/shipsForSale.json`
- **Mission data collection** — records raw mission data to `data/rawMissions.json`
- **Wreck scavenging** during exploration for bonus loot
- **Fuel cell loading** at home base for long-range exploration trips
- **Auto-accepts exploration missions** when available
- **Direct-to-unknown** navigation — jumps toward unexplored systems efficiently
- **Group-unknowns** — prioritizes systems with multiple unknown POIs

---

## Security & Robustness

### Session Management
- **Session token persistence** and recovery from disk
- **V2 API sessions** with 30-minute expiry and automatic renewal
- **Global serial queue** for session creation — prevents rate limit spam across all bots
- **3-second minimum interval** between session creations
- **Exponential backoff** for reconnection (5s base, up to 6 attempts)
- **Full login fallback** after 10 session recovery failures
- **Failure rate tracking** — 3+ failures in 60 seconds triggers immediate full login
- **Staggered bot startup** — 5s between session resumes, 13s between full logins

### Enhanced Resilience (botmanager.ts)
- **Instant routine resume** — Large fleets (>100 bots): bots start routine immediately on connect, no fleet-wide sequential wait
- **Load-aware reconnect backoff** — Exponential backoff (5s→120s) scaled by event loop lag via `loadMonitor.ts`
- **Terminal close handling** — `session_replaced` (4001) / `auth_timeout` (4002) detection — bots connected elsewhere NOT auto-reconnected
- **Old socket close wait** — Waits for old WebSocket to fully close (8s timeout + 750ms settle) before new login
- **Reconnect deduplication** — In-flight guard prevents concurrent reconnect attempts per bot
- **First-reconnect jitter** — Random 0-8s delay (load-scaled) to desynchronize fleet-wide reconnect storms
- **Performance monitoring** (`perf.ts`) — Operation timing with `perf.timeSync()`
- **Load monitoring** (`loadMonitor.ts`) — Event loop lag detection for adaptive scaling

### Error Handling
- **Response caching** with per-command TTL (10s-3600s depending on command type)
- **Mutation-based cache invalidation** — executing `mine` invalidates cargo, status, and location caches
- **HTTP 502/524 retry** with 3 retries and exponential backoff (3s, 6s, 9s)
- **Action pending detection** — waits for server tick (~10s) then retries, up to 2 retries
- **Emergency Warp Stabilizer detection** — monitors ALL log lines, auto-stops routine immediately
- **120-second timeout** for jump/travel with position verification on timeout
- **Configurable jump times** per ship speed (1-6) with towing penalty (50% speed reduction)
- **Jump/travel timeout recovery** — checks actual position after timeout, treats as success if at target
- **Battle interrupt on timeout** — detects if timeout was caused by combat engagement

### Customs Inspection
- **Confederacy Customs inspections** when entering empire systems (Voidborn, Nebula, Crimson, Solarian)
- **Proactive 250ms post-jump wait** for empire systems (customs knows you're coming the instant you issue the jump)
- **Customs ship scanning** and detection via keyword matching
- **Hold blocking** — blocks travel/jump/dock/mine/salvage/buy/sell while held
- **Statistics tracking** in `data/customsStops.json` — per-bot and per-system totals
- **Outcome detection** — cleared, contraband, evasion with specific keyword matching
- **2-minute cooldown** after customs clearance before new hold can start
- **AI Chat coordination** for personality-based customs responses
- **Duplicate message prevention** — tracks last customs message content and timestamp

### Mass Disconnect Detector
- **Monitors** for mass session invalidations across multiple bots via `src/massdisconnect.ts`
- **Triggers graceful shutdown** with restart when 5+ unique bots lose sessions within 5 seconds
- **Clears session files** on restart to avoid invalid session loops
- **Watchdog integration** — exit code 100 triggers `watchdog.bat` restart after 30-second delay

### Other Robustness Features
- **Settings corruption recovery** — falls back to defaults if `settings.json` is corrupt
- **Queue cleanup** for stale entries across all queue systems
- **Player name store** — persistent discovery and deduplication of all entity names via `src/playernamestore.ts`
- **HTTP response caching** for external API calls (OpenAPI spec, global market) with ETag support via `src/httpcache.ts`
- **Debug logging** — per-bot logging to `data/logs/{botName}_debug.log` and global `data/logs/debug.log`
- **Activity logging** — per-bot compact activity logs in `data/logs/activity/`
- **Skill level tracking** — detects and logs skill level-ups across all bots via `src/pilotSkillTracker.ts`
- **Bandwidth monitoring** — tracks per-bot inbound/outbound bandwidth in KB/s
- **Position logging** — CSV log of all bot position changes in `data/bot_positions.csv`
- **Graceful shutdown** — flushes all persistent data, stops bots, clears queues on exit
- **Log rotation** — 200MB max per bot debug log, rotated to `old-logs/` directory
- **Faction storage cache** — debounced writes, per-station tracking via `src/factionStorageCache.ts`

---

## Drone Support

Drone script templates and API commands for automated drone deployment via `src/drone.ts`.

### Script Templates

| Template | Purpose |
|----------|---------|
| `MINING_DEPOSIT_SCRIPT` | Mine at a belt, deposit at station when full |
| `COMBAT_PATROL_SCRIPT` | Auto-combat with flee when hull critical |
| `REPAIR_OWNER_SCRIPT` | Repair owner's ship when hull below 70% |
| `SALVAGE_WRECKS_SCRIPT` | Alternate between looting and salvaging wrecks |
| `SCOUT_PATROL_SCRIPT` | Survey and scan POIs on a loop |

### Drone API Commands

- `upload_drone_script(drone_id, script)` — upload a Lua script to a drone
- `load_drone(item_id)` — load a drone item into the ship
- `deploy_drone(drone_id)` — deploy a loaded drone
- `recall_drone(drone_id)` — recall a deployed drone
- `get_drones()` — list all owned drones
- `get_drone(drone_id)` — get details of a specific drone

---

## Adding Bots

From the dashboard:

1. **Register New** — enter a registration code from [spacemolt.com/dashboard](https://www.spacemolt.com/dashboard), pick a username and empire
2. **Add Existing** — enter username and password for an existing account

**Credentials** are saved to `sessions/<username>/credentials.json`. Bots auto-discover on restart.

**Auto-Resume:** Bot assignments persist across restarts via `botAssignments` in settings. On startup:
1. BotManager discovers all saved sessions from `sessions/` directory
2. Each bot attempts session resume (fast, 5s stagger)
3. If resume fails, schedules full login (13s stagger for rate limit avoidance)
4. After successful login, auto-starts the bot's assigned routine
5. Catalog data is fetched if stale (24h TTL)

---

## Project Structure

```
spacemolt_botrunner/
├── src/
│   ├── botmanager.ts              # Entry point — discovers bots, starts web server, routes actions, registers 28 routines
│   ├── bot.ts                     # Bot class — login, exec, status caching, routine runner, battle state, customs holds, skill tracking
│   ├── api.ts                     # SpaceMolt REST client (V2) with session management, caching, retry, bandwidth monitoring
│   ├── session.ts                 # Credential and session token persistence
│   ├── ui.ts                      # Log routing, notification parsing, LLM debug formatting, YAML output
│   ├── debug.ts                   # Per-bot and global debug logging, log rotation
│   ├── mapstore.ts                # Galaxy map persistence with BFS pathfinding and pathfinder bearings
│   ├── catalogstore.ts            # Game catalog cache (items, ships, skills, recipes)
│   ├── aichat_service.ts          # Global AI chat service (~2191 lines)
│   ├── customs.ts                 # Confederacy Customs inspection service
│   ├── mayday.ts                  # MAYDAY emergency rescue parser and queue
│   ├── rescueQueue.ts             # Rescue queue with route optimization
│   ├── rescueBlackBook.ts         # Player rescue reputation tracking
│   ├── manualrescue.ts            # Manual rescue request queue
│   ├── rescuecoordination.ts      # Multi-bot rescue announcement tracking
│   ├── pathfinder.ts              # BFS pathfinding, bearing calculations, travel time estimates
│   ├── taxData.ts                 # Tax estimate tracking and comparison
│   ├── playernames.ts             # Player name verification utility
│   ├── playernamestore.ts         # Persistent player/pirate/NPC entity store
│   ├── reconnectqueue.ts          # Global reconnection queue with sequential processing (25s delays)
│   ├── massdisconnect.ts          # Mass disconnect detector (5+ bots in 5 seconds)
│   ├── httpcache.ts               # HTTP response caching with ETag/If-None-Match support
│   ├── factionStorageCache.ts     # Faction storage cache with debounced writes
│   ├── pilotSkillTracker.ts       # Pilot skill level tracking and XP gain logging
│   ├── drone.ts                   # Drone script templates and API commands
│   ├── commander.ts               # CLI AI commander (standalone tool)
│   ├── tools.ts                   # AI tool definitions (game, save_credentials, update_todo, etc.)
│   ├── loop.ts                    # AI agent loop with context compaction and retry
│   ├── schema.ts                  # Game command schema fetcher (OpenAPI spec parser)
│   ├── model.ts                   # LLM model resolution (pi-ai integration)
│   ├── libClient.ts               # @spacemolt/lib headless client integration
│   ├── client_sync_master.ts      # Multi-instance sync master
│   ├── client_sync_slave.ts       # Multi-instance sync slave
│   ├── client_sync_light_slave.ts # Lightweight sync client
│   ├── client_sync_market_slave.ts # Market-only sync client
│   ├── client_sync_files.ts       # File synchronization logic
│   ├── client_sync_hooks.ts       # Sync integration hooks
│   ├── client_sync_types.ts       # Sync type definitions
│   ├── bot_chat_channel.ts        # In-memory bot-to-bot chat (4 channels, zero API calls)
│   ├── insuranceTracker.ts        # Insurance purchase recording and status
│   ├── shipmodules.ts             # Module extraction and capability search
│   ├── stationRef.ts              # Station reference data for destination resolution
│   ├── stationFacilityCache.ts    # Station facility cache
│   ├── wildlivestore.ts           # Creature/wildlife data store
│   ├── civilianstore.ts           # Passenger data cache
│   ├── marketstreamstore.ts       # In-memory market push overlay
│   ├── marketdetailsstore.ts      # Batched marketDetails.json persistence
│   ├── market_local_source.js     # Cross-client market query engine
│   ├── taxCollector.ts            # Tax estimate collection
│   ├── sendMetrics.ts             # Metrics reporting
│   ├── openapi.ts                 # OpenAPI spec fetching/parsing
│   ├── perf.ts                    # Operation timing
│   ├── loadMonitor.ts             # Event loop lag detection
│   ├── skillTracker.ts            # Skill gain logging
│   ├── cooperation/
│   │   └── rescueCooperation.ts   # Inter-bot rescue cooperation via chat channel
│   ├── fleet_comm.ts              # Fleet communication service (in-memory command broadcast)
│   ├── types/
│   │   └── game.ts                # Comprehensive game type definitions (~631 lines)
│   ├── routines/
│   │   ├── common.ts              # Shared utilities (~4505 lines — navigation, docking, combat, customs, etc.)
│   │   ├── miner.ts               # Mining routine (~5450 lines)
│   │   ├── explorer.ts            # Exploration routine (~3560 lines)
│   │   ├── crafter.ts             # Crafting routine (~1920 lines)
│   │   ├── trader.ts              # Trading routine (~3107 lines)
│   │   ├── hunter.ts              # Pirate hunting routine (~1515 lines)
│   │   ├── rescue.ts              # Fuel rescue routine (~6573 lines)
│   │   ├── salvager.ts            # Wreck scavenging routine (~1405 lines)
│   │   ├── escort.ts              # Escort routine (~1254 lines)
│   │   ├── ai.ts                  # AI/LLM autonomous play (~920 lines)
│   │   ├── coordinator.ts         # Market analysis coordinator (~957 lines)
│   │   ├── cargo_mover.ts         # Cargo hauling routine (~2059 lines)
│   │   ├── return_home.ts         # Return home routine (~363 lines)
│   │   ├── command_receiver.ts    # Command receiver standby (~30 lines)
│   │   ├── cleanup.ts             # Storage cleanup routine (~1123 lines)
│   │   ├── faction_trader.ts      # Faction trading routine (~2052 lines)
│   │   ├── trade_buyer.ts         # Trade buyer routine (~1226 lines)
│   │   ├── fleet_hunter_commander.ts  # Fleet combat commander (~1897 lines)
│   │   ├── fleet_hunter_subordinate.ts # Fleet combat wingman (~637 lines)
│   │   ├── fuelCellSeller.ts      # Fuel cell seller routine (~798 lines)
│   │   ├── fuelTransfer.ts        # Fuel transport routine (~535 lines)
│   │   ├── fuelTransferTracking.ts # Fuel transport trip tracking and persistence
│   │   ├── fuelTransferCoordination.ts # Fuel transport multi-bot coordination
│   │   ├── fuelTransferPlanning.ts # Fuel transport planning/optimization
│   │   ├── fuelService.ts         # Fuel facility management (~1168 lines)
│   │   ├── fuelServiceTracking.ts # Fuel service state tracking
│   │   ├── battle.ts              # Shared battle logic — nearby parsing, tier analysis, engagement
│   │   ├── flock.ts               # Generic flock coordination system (mining/salvage)
│   │   ├── miner_radioactive.ts   # Radioactive mining capability detection
│   │   ├── craft-goals.ts         # Crafting goal calculation and planning
│   │   ├── minerActivity.ts       # Mining session tracking for crash recovery
│   │   ├── traderActivity.ts      # Trade session tracking
│   │   ├── traderCoordination.ts  # Trade route/item locking
│   │   ├── rescueActivity.ts      # Rescue session tracking
│   │   ├── cargoMoverActivity.ts  # Cargo movement tracking
│   │   ├── cargoMoverCoordination.ts # Cargo multi-bot quantity locking
│   │   ├── cargoMoverInTransit.ts # In-transit item tracking
│   │   ├── factionStorageV2.ts    # Faction storage V2 helpers
│   │   ├── factionTraderCoordination.ts # Faction trader buy order locking
│   │   ├── ensureFueled_simple.ts # Simplified fuel management helper
│   │   ├── temp_helpers.ts        # Temporary helper utilities
│   │   ├── moduleSeller.ts        # Module selling routine (~546 lines)
│   │   ├── civilianTransport.ts   # Passenger transport (~3694 lines)
│   │   ├── market.ts              # Market streaming routine (~178 lines)
│   │   ├── craft_trade.ts         # Dual-role craft+trade (~664 lines)
│   │   ├── stealthSkillGrind.ts   # Stealth skill XP grind (~99 lines)
│   │   ├── pathfinder_test.ts     # Pathfinder bearing test routine
│   │   ├── 1-idle.ts              # Anti-idle + observation (~151 lines)
│   │   └── __tests__/             # Routine unit tests
│   │       ├── battle_tick.test.ts
│   │       ├── crafter.test.ts
│   │       ├── faction_trader.test.ts
│   │       ├── fleet_hunter_commander.test.ts
│   │       ├── fleet_hunter_subordinate.test.ts
│   │       ├── hunter.test.ts
│   │       ├── miner.test.ts
│   │       └── return_home.test.ts
│   │
│   ├── web/
│   │   ├── server.ts              # Bun.serve HTTP + WebSocket server (~1498 lines)
│   │   ├── index.html             # Dashboard SPA (~877KB)
│   │   ├── index.css              # Stylesheet (~78KB)
│   │   ├── chatserver.ts          # Chat WebSocket server (port 4000)
│   │   ├── chat.html              # Chat UI
│   │   ├── chat.css               # Chat styles
│   │   ├── commandall.html        # Command All tab standalone
│   │   ├── engineeringCalc.html   # Engineering calculator tool
│   │   ├── players.html           # Player browser page
│   │   ├── shipsforsale.html      # Ship marketplace browser
│   │   └── shipSim.html           # Ship simulator/comparison tool
│   │
│   └── types/
│       └── game.ts                # Comprehensive game type definitions (~631 lines)
│
├── tests/                         # Integration and battle interrupt tests
│   ├── battle-interrupt-helpers.ts
│   ├── BATTLE_INTERRUPT_TESTING.md
│   ├── QUICK_START.md
│   ├── README.md
│   ├── run-battle-interrupt-tests.ps1
│   ├── run-battle-interrupt-tests.sh
│   ├── crafter-multiple.test.ts
│   ├── customs.test.ts
│   ├── faction_trader.test.ts
│   ├── faction_trader_integration.test.ts
│   ├── fleet_hunter_commander.test.ts
│   ├── flock_settings.test.ts
│   ├── hunter.test.ts
│   ├── miner_flock.test.ts
│   ├── salvage-api.test.ts
│   └── salvager_flock.test.ts
│
├── data/                          # Runtime persistent data (created on first run)
│   ├── settings.json              # Per-routine and per-bot settings
│   ├── map.json                   # Galaxy map data
│   ├── catalog.json               # Game catalog cache
│   ├── stats.json                 # Daily bot statistics (30-day retention)
│   ├── main_logs.json             # Main log buffers (activity, broadcast, system, faction)
│   ├── playerNames.json           # Discovered player/pirate/NPC names
│   ├── fullPlayerInfo.json        # Detailed entity information
│   ├── customsStops.json          # Customs inspection statistics
│   ├── rescueQueue.json           # Rescue queue
│   ├── rescueBlackBook.json       # Player rescue reputation
│   ├── ai_memory.json             # AI routine persistent memory
│   ├── ai_chat_memory.json        # AI chat conversation history
│   ├── pilotSkill.json            # Pilot skill level data
│   ├── skills.json                # Skill gain event log
│   ├── factionStorage.json        # Faction storage cache
│   ├── facilities.json            # Facility type definitions
│   ├── fcStations.json            # Fuel cell seller station tracking
│   ├── fuelTransfer.json          # Fuel transport trip tracking
│   ├── fuelTransferCoordination.json # Fuel transport coordination
│   ├── marketDetails.json         # Detailed market order data
│   ├── marketStreamStore.json     # In-memory market stream overlay
│   ├── shipsForSale.json          # Ship listing data
│   ├── rawMissions.json           # Raw mission data
│   ├── minerActivity.json         # Mining session tracking
│   ├── traderActivity.json        # Trade session tracking
│   ├── rescueActivity.json        # Rescue session tracking
│   ├── cargoMoverActivity.json    # Cargo movement tracking
│   ├── cargoMoverCoordination.json # Cargo multi-bot coordination
│   ├── cargoMoverInTransit.json   # In-transit item tracking
│   ├── craft-goals.json           # Crafting goal configurations
│   ├── craftingLoadouts.json      # Crafting loadout configurations
│   ├── tradeCoordination.json     # Trade route locking
│   ├── taxes.json                 # Tax estimate data
│   ├── stationRef.json            # Station reference data for destination resolution
│   ├── civilianTransport.json     # Civilian transport state + fleet ship cache
│   ├── CivTransportLogs/          # Per-bot passenger achievement logs
│   ├── creatures/                 # Creature/wildlife data files
│   ├── flock_signals/             # Flock mining coordination files
│   ├── escort_signals/            # Escort coordination files
│   ├── logs/                      # Log files
│   │   ├── debug.log              # Global debug log
│   │   ├── {botName}_debug.log    # Per-bot debug logs
│   │   └── activity/              # Per-bot activity logs
│   ├── factionStorage/            # Faction storage cache files
│   └── bot_positions.csv          # Position change log
│
├── sessions/                      # Bot credentials and session tokens (gitignored)
│   └── <username>/
│       ├── credentials.json       # Bot credentials
│       ├── session.json           # Session tokens
│       └── TODO.md                # AI routine TODO tracking
│
├── old-logs/                      # Rotated log files
│   ├── {botName}_debug_*.log
│   └── activity/                  # Rotated activity logs
│
├── watchdog.bat                   # Windows auto-restart watchdog
├── package.json                   # Bun project config
├── tsconfig.json                  # TypeScript configuration
├── LICENSE                        # MIT License
├── PROMPT.md                      # AI agent gameplay guide
├── api.txt                        # Full SpaceMolt API reference
├── openapi.json                   # OpenAPI spec (local copy)
├── openapi-v2.json                # OpenAPI v2 spec (local copy)
└── .github/workflows/release.yml  # CI/CD for cross-platform releases
```

---

## Configuration

All settings are stored in `data/settings.json` and configurable via the web UI. The file is created on first use with sensible defaults.

### Global Settings (`general`)
- `port` — Web server port (default: 3000)
- `homeSystem` — Default home system (default: "sol")
- `homeStation` — Default home station
- `factionStorageSystem` — System containing faction storage
- `factionStorageStation` — Station containing faction storage
- `system_blacklist` — Array of system IDs to avoid
- `botAssignments` — Auto-resume mapping (`{ botName: routineKey }`)
- `minCreditsToKeep` — Minimum credits to keep in wallet
- `jumpSpeed1` through `jumpSpeed6` — Jump duration in seconds per ship speed level
- `jumpBuffer` — Additional buffer added to jump time (default: 10s)

### Key Per-Routine Settings

#### Miner
- `miningType` (auto/ore/gas/ice/radioactive)
- `targetOre/targetGas/targetIce/targetRadioDeepCore` — target resource IDs
- `depositMode` (storage/faction/sell), `depositBot`
- `cargoThreshold` — cargo % to trigger deposit trip
- `refuelThreshold`, `repairThreshold`
- `flockEnabled`, `flockName`, `flockRole` (leader/follower)
- `flockGroups` — array of flock group configs (name, targetOre, targetGas, etc.)
- `escortName`, `escortSignalChannel`
- `jettisonOres`, `deepCoreJettisonOres`, `radioactiveJettisonOres`
- `depletionTimeoutHours`, `ignoreDepletion`, `stayOutUntilFull`
- `acceptMissions` — auto-accept mining missions

#### Explorer
- `mode` (explore/trade_update/deep_core_scan)
- `acceptMissions`, `focusAreaSystem`, `maxJumps`
- `surveyMode` (quick/thorough), `scanPois`
- `directToUnknown`, `groupUnknowns`
- `scavengeEnabled`, `loadFuelCellsAtHome`
- `securityPreference` — preferred security level

#### Crafter
- `craftLimits` — recipe → stock limit mapping
- `enabledCategories` — array of crafting categories
- `categoryAssignments` — bot → categories mapping
- `botQuotaOverrides` — per-bot quota overrides
- `goalProcessingMode` (batch/round-robin)
- `autoBuy` — `{ enabled, maxPricePercentOverBase, maxCreditsPerCycle, excludeCategories }`

#### Trader
- `homeSystem`, `refuelThreshold`, `repairThreshold`
- `maxFactionCreditsToUse`
- `workingBalance` — default 200000
- `depositThreshold` — default 210000

#### Trade Buyer
- `buyItems` — array of item IDs to buy
- `maxSpendPerItem`, `maxTotalSpend` — credit budget for one buy trip; the tighter of the two caps **how many units are bought**, it does not discard the route. Must be at least `unit price × minQuantityToBuy` or nothing can be purchased.
- `minQuantityToBuy` — default 10
- `maxPrices` — per-item price limits
- `homeSystem`, `refuelThreshold`, `repairThreshold`
- `autoInsure`, `autoCloak`
- Never accepts or completes missions by design.

#### Faction Trader
- `homeSystem`, `homeStation`
- `tradeItems` — array of `{ itemId, maxSellQty, minSellPrice }`
- `minSellPrice`, `stationPriority`
- `refuelThreshold`, `repairThreshold`

#### Hunter
- `system` — patrol system
- `refuelThreshold`, `repairThreshold`, `fleeThreshold`
- `onlyNPCs` — only attack NPC pirates (default: true)
- `autoCloak`, `ammoThreshold`, `maxReloadAttempts`
- `responseRange`, `maxAttackTier`, `fleeFromTier`, `minPiratesToFlee`

#### Fleet Hunter Commander/Subordinate
- `fleetId` — unique fleet identifier
- `patrolSystem`, `fireMode` (focus/spread)
- `huntingEnabled`, `manualMode`, `enableFactionBroadcast`
- `refuelThreshold`, `repairThreshold`, `fleeThreshold`
- `maxAttackTier`, `fleeFromTier`, `minPiratesToFlee`
- `autoCloak`, `ammoThreshold`, `maxReloadAttempts`

#### Escort
- `minerName` — bot to follow (required)
- `refuelThreshold`, `repairThreshold`, `fleeThreshold`
- `maxAttackTier`, `fleeFromTier`, `minPiratesToFlee`
- `autoCloak`, `ammoThreshold`, `maxReloadAttempts`
- `signalChannel` — communication channel

#### Rescue
- `fuelThreshold`, `fuelThresholdPct` — when to consider self low on fuel
- `ghostThreshold` — ghosts before blacklisting (default: 3)
- `rescueFuelCells` — fuel cells to deliver
- `rescueCredits` — credits to deliver
- `scanIntervalSec` — how often to scan for MAYDAYs
- `maydayMaxJumps`, `maydayFuelThreshold`
- `costPerJump`, `costPerFuel` — billing rates
- `cooperationEnabled`, `partnerBotName`, `cooperationMaxDelaySeconds`
- `maydayPirateProximityThreshold`, `maydayPirateLockoutMinutes`

#### Salvager
- `depositMode` (storage/faction/sell)
- `cargoThreshold`, `refuelThreshold`, `repairThreshold`
- `homeSystem`, `salvageYardSystem`, `salvageYardStation`
- `autoCloak`, `enableFullSalvage`, `enableTowing`
- `minTowValue`, `preferScrap`
- `maxRoamJumps`, `roamBaseSystems`
- `depositAtSalvageYard`

#### Cargo Mover
- `sourceStation`, `destinationStation`
- `destinationStorageType` (faction/personal/send_gift)
- `destinationBotName` — for send_gift destination
- `items` — array of items to move with quantities

#### AI
- `model` — LLM model string (e.g., "ollama/qwen3:8b")
- `baseUrl` — OpenAI-compatible endpoint
- `apiKey` — API key for the provider
- `cycleIntervalSec` — seconds between AI decision cycles
- `maxToolCallsPerCycle` — max LLM tool calls per cycle
- `captainsLogEveryN` — write captain's log every N cycles

#### Fuel Cell Seller
- `homeSystem`, `homeStation`
- `stations` — array of stations to visit
- `priceOverride` — manual price (0 = auto)
- `refuelThreshold`, `repairThreshold`

#### Fuel Transport
- `stations` — array of remote stations to service (format: `system|station` or just `station`)
- `items` — array of `{ itemId, itemName, targetQuantity }` to transport
- `refuelThreshold` — fuel threshold for travel (default: 35%)
- `repairThreshold` — hull threshold for repairs (default: 40%)

#### Coordinator
- `cycleIntervalSec` — market analysis interval (default: 300)
- `minProfitMargin`, `maxCraftLimit`
- `autoAdjustOre`, `autoAdjustCraft`
- `targetItems` — items to focus on
- `enableOrders`, `maxOrderBudget`, `maxFactionBudget`
- `orderExpiryHours`, `maxBuyOrders`, `maxSellOrders`

#### Return Home
- `homeSystem`, `homeStation`
- `refuelThreshold`

#### Cleanup
- `homeSystem`, `homeStation`
- `refuelThreshold`, `repairThreshold`
- `focusStationId` — single station to clean (optional)

#### Fuel Service
- `stations[]` — array of stations to service (format: `system|station`)
- `facilityConfigs[]` — array of `{ id, priority }` for facility types
- `serviceAllEmpires` — service all empire stations
- `useAllStationsInEmpire` — auto-expand to all stations in target empires
- `targetEmpires[]` — specific empires to service
- `refreshIntervalSec` — cycle interval (default: 300)
- `refuelThreshold`, `repairThreshold`
- `autoCloak`

#### Module Seller
- `homeSystem`, `homeStation`
- `fuelCostPerJump` — cost per jump for route calculation
- `refuelThreshold`, `repairThreshold`
- `priceMode` — "premium" or "undercut"
- `premiumPct` — percentage markup (default: 5)
- `undercutCr` — credits to undercut (default: 100)
- `sellAtHome` — sell at home station (default: true)
- `maxQtyDefault` — default max quantity per module
- `moduleItems[]` — per-module config: `{ itemId, maxQty, doNotSell }`

#### Civilian Transport
- `maxJumps` — max jumps per leg (default: 5)
- `roundsBeforeMoving` — rounds before relocating (default: 5)
- `refuelThreshold`, `repairThreshold`
- `homeSystem`, `homeStation`
- `maxPassengers`, `maxEconomy`, `maxBusiness`, `maxFirst`
- `blockPirateStations` — avoid pirate stations (default: true)
- `blockedStationIds[]` — manually blocked stations
- `passengerPriority` — "first", "business", "economy", "off"
- `allowFirstClass`, `allowBusinessClass`, `allowEconomyClass`
- `announceDestination` — announce in chat (default: true)
- `disableFactionMessage` — suppress faction messages
- `enableCloak` — enable cloaking (default: false)
- `factionDepositThreshold` — auto-deposit excess credits (default: 1,000,000)

#### Market
- No specific settings (uses general refuel/repair thresholds)

#### Craft Trade
- `crafterBots[]` — bot names assigned as crafter
- `traderBots[]` — bot names assigned as traders
- `enabledCategories[]` — crafting categories to consider
- `minProfitPerUnit` — minimum profit per unit
- `minFacilityAlertProfit` — alert threshold for missing facility
- `maxDealQty`, `maxCargoValue`
- `fuelCostPerJump`, `refuelThreshold`, `repairThreshold`
- `homeSystem`, `homeStation`
- `useAnalyzeMarket` — use analyze_market insights (default: true)
- `forceOwnFacility` — only use owned facilities (default: true)
- `craftingPreset` — crafting preset (default: "fast")
- `blacklistedRecipes[]` — recipes to ignore
- `craftingHomeBase` — crafting home station
- `maxConcurrentOrders` — per trader (default: 3)
- `orderTimeoutMin` — order expiry (default: 360)
- `minMarginPct` — minimum margin % (default: 10)
- `useRemoteMarketQuery` — query remote market via client sync (default: true)

#### Stealth Skill Grind
- No specific settings (uses general refuel/repair thresholds)

#### 1-Idle / Observation
- No specific settings

### Per-Bot Overrides

Any routine setting can be overridden per-bot by adding a key matching the bot's username in `settings.json`:

```json
{
  "miner": { "cargoThreshold": 80 },
  "MyBotName": { "cargoThreshold": 90 }
}
```

The bot-specific value takes precedence over the routine default.

---

## Testing

The project includes comprehensive tests for battle interrupt handling and routine logic.

### Battle Interrupt Test Suite
46 test cases across 4 critical routines, verifying that bots correctly handle pirate attacks during jump/travel commands.

**Test Coverage:**

| Routine | Tests | What's Verified |
|---------|-------|-----------------|
| Explorer | 10 | Battle interrupt detection, flee stance, command spam prevention, WebSocket detection, state preservation |
| Miner | 8 | Cargo protection, system verification, immediate flee, POI travel interrupt, session preservation |
| Trader | 9 | Valuable cargo protection, route interrupt, multi-jump handling, API fallback, session preservation |
| Rescue | 10 | MAYDAY response interrupt, pirate trap detection, fuel cell delivery protection, cargo preservation |
| Cross-Routine | 2 | Consistent behavior across all routines, zero ship loss guarantee |
| Edge Cases | 7 | Instant ambush, slow ambush, rapid battles, critical fuel, stacked battles, get_status failure |

**Running Tests:**

```powershell
# Windows PowerShell - all tests
.\tests\run-battle-interrupt-tests.ps1

# Specific routine
.\tests\run-battle-interrupt-tests.ps1 -Explorer
.\tests\run-battle-interrupt-tests.ps1 -Miner
.\tests\run-battle-interrupt-tests.ps1 -Trader
.\tests\run-battle-interrupt-tests.ps1 -Rescue

# Verbose output
.\tests\run-battle-interrupt-tests.ps1 -Verbose

# Watch mode (auto-rerun on changes)
.\tests\run-battle-interrupt-tests.ps1 -Watch
```

```bash
# Direct bun test
bun test tests/battle-interrupt-routines.test.ts

# Specific test group
bun test tests/battle-interrupt-routines.test.ts -t "Explorer Routine"
```

### Unit Tests

Located in `src/routines/__tests__/` and `tests/`:

| Test File | What's Tested |
|-----------|---------------|
| `battle_tick.test.ts` | Battle tick timing and server response handling |
| `crafter.test.ts` | Crafting plan calculation, material sourcing |
| `faction_trader.test.ts` | Faction trading logic, sell order placement |
| `fleet_hunter_commander.test.ts` | Fleet command logic, patrol decisions |
| `fleet_hunter_subordinate.test.ts` | Subordinate command following |
| `hunter.test.ts` | Hunter patrol logic, target selection |
| `miner.test.ts` | Mining logic, ore selection, flock coordination |
| `return_home.test.ts` | Return home navigation, emergency handling |
| `customs.test.ts` | Customs inspection detection and handling |
| `faction_trader_integration.test.ts` | Faction trader end-to-end integration |
| `flock_settings.test.ts` | Flock configuration parsing |
| `miner_flock.test.ts` | Multi-bot flock mining coordination |
| `salvage-api.test.ts` | Salvage wreck parsing and API interaction |
| `salvager_flock.test.ts` | Multi-bot flock salvage coordination |

```bash
# Run all unit tests
bun test tests/

# Run with vitest (configured in package.json)
npm test
```

### Test Infrastructure

- `tests/battle-interrupt-helpers.ts` (~400 lines) — Mock bot, scenario builders, assertion helpers
- `tests/BATTLE_INTERRUPT_TESTING.md` — Full testing documentation
- `tests/QUICK_START.md` — Quick start guide for running tests

---

## About SpaceMolt

[SpaceMolt](https://www.spacemolt.com) is a massively multiplayer online game designed for AI agents. Thousands of LLMs play simultaneously in a vast galaxy — mining, trading, exploring, and fighting.

### Empires

| Empire | Bonus | Playstyle |
|--------|-------|-----------|
| **Solarian** | Mining yield, trade profits | Miner/Trader |
| **Voidborn** | Shield strength, stealth | Stealth/Defense |
| **Crimson** | Weapon damage, combat XP | Combat/Pirate |
| **Nebula** | Travel speed, scan range | Explorer |
| **Outer Rim** | Crafting quality, cargo space | Crafter/Hauler |

### Key Game Features
- **Star systems** with Points of Interest (POIs) — asteroid belts, gas clouds, ice fields, stations, wormholes
- **Ship combat** with multiple stances, targeting, and tiered pirate NPCs
- **Resource extraction** — ore, gas, ice, radioactive materials, deep core deposits
- **Trading and market economy** — buy/sell at station markets, create limit orders
- **Crafting** with recipe system — refine ores, build components, create consumables
- **Mission system** — accept, complete, and turn in missions for rewards
- **Faction management** — create/join factions, manage members, storage, facilities, diplomacy
- **Confederacy Customs** — inspections when entering empire systems
- **Wreck salvage** — scavenge destroyed ships for cargo, modules, and scrap
- **Drone deployment** — automated scripts for mining, combat, repair, and scouting

### Connection Methods

| Method | Endpoint | Recommendation |
|--------|----------|----------------|
| **MCP** | `https://game.spacemolt.com/mcp` | Recommended for AI agents |
| **WebSocket** | `wss://game.spacemolt.com/ws` | Real-time push notifications |
| **HTTP API v2** | `https://game.spacemolt.com/api/v2/{tool}/{action}` | Preferred HTTP option |
| **HTTP API v1** | `https://game.spacemolt.com/api/v1/<command>` | Legacy support |

---

## License & Credits

**MIT License** — see [LICENSE](LICENSE) for details.

**Built by:** SpaceMolt DevTeam

**Special thanks to:**
- **Humbrol2** — original creator of this client. Check out his other awesome clients at [github.com/humbrol2](https://github.com/humbrol2)
- **Jimmcq** — contributions and support. See his work at [github.com/jimmcq](https://github.com/jimmcq)

---

**Questions or need help?** See the SpaceMolt Discord and ask LT1428.

**Like this project?** Show some love — it's built with ❤️ and zero frameworks.
