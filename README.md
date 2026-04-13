# SpaceMolt Bot Runner

> **A comprehensive fleet manager for [SpaceMolt](https://www.spacemolt.com) — manage unlimited automated bots from a single web dashboard.**

![Dashboard](https://img.shields.io/badge/interface-web_dashboard-blue) ![Runtime](https://img.shields.io/badge/runtime-bun-black) ![No Dependencies](https://img.shields.io/badge/deps-zero_runtime-green) ![Bots](https://img.shields.io/badge/bots-unlimited-orange)

---

## Table of Contents

- [What It Does](#what-it-does)
- [Quick Start](#quick-start)
- [Bot Routines (20 Available)](#bot-routines)
  - [Economic Routines](#economic-routines)
  - [Combat Routines](#combat-routines)
  - [Coordination Routines](#coordination-routines)
  - [Utility Routines](#utility-routines)
- [Web Dashboard Features](#web-dashboard-features)
- [Advanced Multi-Bot Coordination](#advanced-multi-bot-coordination)
- [AI Integration](#ai-integration)
- [Combat System](#combat-system)
- [Rescue & Emergency Systems](#rescue--emergency-systems)
- [Faction Management](#faction-management)
- [Galaxy Map & Exploration](#galaxy-map--exploration)
- [Security & Robustness](#security--robustness)
- [Adding Bots](#adding-bots)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [About SpaceMolt](#about-spacemolt)
- [License](#license)

---

## What It Does

Bot Runner is a **complete fleet management system** for SpaceMolt, an MMO game designed for AI agents. It provides:

- **Web Dashboard** — real-time monitoring, controls, and management at `http://localhost:3000`
- **20 Automated Routines** — mining, exploring, trading, combat, crafting, rescue, and more
- **Multi-Bot Coordination** — flock mining, fleet combat, cargo hauling, trade routes
- **AI-Powered Features** — LLM-driven autonomous play, intelligent chat responses, market analysis
- **Faction Management** — full in-game faction controls from your browser
- **Galaxy Map** — auto-built exploration data with filtering and pathfinding
- **Zero Runtime Dependencies** — just Bun, no database, no frameworks

**Key Capabilities:**
- Run unlimited bots, each with independent routines and configurations
- Coordinate multiple bots for complex operations (flock mining, fleet combat, cargo moving)
- Monitor everything from a live web dashboard with real-time status updates
- Execute any game command manually from bot profile pages
- AI chat service with per-bot personalities and memory persistence
- Automated rescue system with MAYDAY parsing, queue management, and billing
- Pirate avoidance and combat-aware navigation
- Confederacy Customs inspection handling
- Mass disconnect detection and recovery

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- A SpaceMolt account — register at [spacemolt.com/dashboard](https://spacemolt.com/dashboard) to get a registration code

### Install

```bash
git clone https://github.com/MotorMan/spacemolt_botrunner.git
cd spacemolt_botrunner
bun install
```

### Run

```bash
on windows:
watchdog.bat
on linux: sorry, i haven't set that up yet, but you can still do:
bun start
but you won't get auto-restart for server patch/disconnects.
```

Open `http://localhost:3000` in your browser. Use `PORT=8080 bun start` for a different port.

---

## Bot Routines

The system includes **20 distinct automated routines**, each designed for specific gameplay. Bots can switch between routines at any time from the dashboard.

### Economic Routines

#### ⛏️ Miner
Automated resource extraction with advanced coordination.

- **Auto-detects mining type** from ship modules (mining laser, gas harvester, ice harvester, radioactive equipment)
- **Supports all resource types:** ore, gas, ice, radioactive materials, deep core
- **Flock Mining:** Multi-bot coordinated mining with leader/follower roles (see [Flock Mining Guide](FLOCK_MINING_GUIDE.md))
- **Deep Core Mining:** Hidden POI discovery with survey scanner + extractor equipment
- **Field Test Mission:** Special handling for early-game extractor-only mining
- **Configurable:** target resources, cargo thresholds, deposit modes (storage/faction/sell)
- **Escort Integration:** Coordinate with combat escorts via faction chat, local signals, or file-based signaling
- **Stay-out-until-full mode** for extended mining trips
- **Ore jettison lists** for regular, deep core, and radioactive mining
- **Depletion timeout tracking** with ignore option
- **Mission acceptance/completion** for mining missions

#### 🔄 Trader
Automated buy/sell trading between stations with route optimization.

- **Trade route management** with working balance tracking
- **Multi-bot coordination** — trade route locking prevents conflicts between traders
- **Auto-insurance, auto-cloak, mod management**
- **Faction profit donation** support
- **Pirate system avoidance**
- **Trade session tracking** with persistent activity logs

#### 🛒 Trade Buyer
Bulk purchasing of configured items from markets.

- **Configurable max spend** per item and total budget
- **Price limits** per item
- **Auto-travels** to stations with best prices
- **Minimum quantity** thresholds

#### 🏭 Faction Trader
Trading focused on faction economy and storage management.

- Faction-specific market operations
- Uses faction storage for bulk trades

#### 🎨 Crafter
Automated crafting with intelligent material sourcing.

- **Goal-based crafting** with batch or round-robin processing
- **Auto-buy missing materials** from station market (configurable max price, budget, category exclusions)
- **Recursive prerequisite crafting** — automatically crafts sub-components up to 2 levels deep
- **Category-based crafting** (Refining, Components, Consumables, etc.)
- **Per-bot category assignments** and quota overrides
- **Uses all storage types:** personal, station, and faction storage
- **Filters out ship passive recipes** (cannot be crafted manually)

#### 🚚 Cargo Mover
Hauls specified items from source to destination station.

- **Multi-bot coordination** — item quantity locking allows 3-4 bots to work together
- **Persistent activity tracking** for interruption recovery
- **Battle encounter handling** with state preservation
- **Automatic cleanup and resumption** after crashes/restarts
- **Destination types:** faction storage, personal storage, or send_gift to a bot

#### 🧹 Cleanup
Consolidates scattered station storage to faction home base.

- **Storage hint detection** to discover which stations have stored items/credits
- **Remote station inspection** before traveling
- **Only visits stations** that have items/credits to collect
- **Efficient routing** to minimize travel time

---

### Combat Routines

#### 🎯 Hunter
Patrols systems hunting pirate NPCs for bounties and loot.

- **Combat stances:** Fire (default), Brace (shields critical), Flee (hull critical)
- **Pirate tier filtering** (small/medium/large/capitol/boss)
- **Auto-cloak support**
- **Ammo management** with automatic reload
- **Huntable system detection** (low security, frontier, lawless)
- **BFS-based** nearest huntable/safe system finding
- **Mission completion, loot selling, ship insurance**

#### ⚓ Fleet Hunter Commander
Leads a fleet of subordinate hunter bots in coordinated combat.

- **Decides patrol systems and POIs** for the fleet
- **Fleet commands:** MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
- **Fire modes:** Focus fire or spread fire
- **Faction chat broadcast** option for coordination
- **Post-patrol logistics** (dock, repair, resupply)

#### 🛡️ Fleet Hunter Subordinate
Follows commander's orders in fleet combat operations.

- **Receives and executes** fleet commands
- **Combat stance management** (fire/brace/flee)
- **Pirate tier filtering**

#### 🚁 Salvager
Travels POI to POI scavenging wrecks for valuable loot.

- **Full salvage mode** — complete wreck processing including modules
- **Towing support** — tow wrecks to salvage yard stations
- **Module looting** — recover ship modules from wrecks with condition tracking
- **Loot All functionality** — one-click clearing of entire wrecks
- **Scrap preference** for processing
- **Roaming mode** with configurable base systems and max jumps
- **Salvage yard station detection** (known stations per empire)
- **Mobile capital station tracking** (dynamic location)

#### 🛡️ Escort
Follows and protects a specified bot (typically a miner).

- **Tracks target's position** via faction chat, local signals, or file-based coordination
- **Multiple escorts** can follow one target
- **Engages threats automatically**
- **Combat stance management** (fire/brace/flee)
- **Pirate tier filtering**

---

### Coordination Routines

#### 🤖 AI
Uses an LLM to play SpaceMolt autonomously.

- **Works with Ollama** or any OpenAI-compatible endpoint
- **Uses game documentation**, current state, persistent memory (`data/ai_memory.json`)
- **Tools to query** local map/catalog data and execute game commands
- **Captain's log entries** for persistence
- **Configurable model, cycle interval, max tool calls per cycle**

#### 📊 Coordinator
Market analysis and craft order management.

- **Fetches global market data** from game API
- **Auto-adjusts** ore mining targets and craft limits based on market demand
- **Buy/sell order management** with budget limits
- **Faction storage budget management**
- **Recipe profit calculation**

#### 📡 Command Receiver
Keeps bot running and ready to receive manual commands from the "Command All" dashboard tab.

- **Minimal loop**, standing by for fleet-wide commands
- **Emergency override** capability

---

### Utility Routines

#### 🆘 Rescue / Fuel Rescue
Monitors fleet for stranded bots, delivers fuel cells or credits.

- **MAYDAY handling** — parses emergency distress messages, validates legitimacy
- **Pirate awareness** — BFS-based pirate stronghold proximity checks, MAYDAY lockouts near pirate bases
- **Pirate trap detection** — detects false flag operations using own bot names
- **Rescue cooperation** — multi-bot coordination via private messages (distance-based priority)
- **Rescue queue** — route-optimized batch rescues
- **Rescue BlackBook** — player reputation tracking (ghosts, successful rescues, billing)
- **Rescue billing system** — charges per jump and fuel delivered
- **Target verification** before rescue (checks if target still needs help)
- **Customs inspection awareness** during rescue operations
- **Consecutive failure tracking** — aborts after 3 failed attempts to prevent spam loops
- **Blacklist validation** — refuses rescues to unreachable systems

#### 🧭 Explorer
Systematically maps the galaxy by visiting every POI.

- **Three modes:** `explore`, `trade_update`, `deep_core_scan`
- **POI classification:** scenic (visit once), resource (re-scan periodically), station (refresh market/missions)
- **System survey** to reveal hidden POIs (wormholes, secret ore belts)
- **Wormhole detection** and registration in map store
- **Pirate avoidance** — BFS-based pirate stronghold proximity checks, temporary blacklisting, emergency flee
- **Focus area mode** (concentrate exploration on specific systems)
- **Quick vs. thorough survey** modes
- **Scavenge wrecks** option
- **Load fuel cells at home** for long-range exploration
- **Direct-to-unknown** and group-unknowns navigation options
- **Auto-accepts exploration missions**

#### 🏠 Return Home
Navigates bot back to configured home base.

- **Emergency trigger** from dashboard
- **Per-bot home system/station** configuration

---

## Web Dashboard Features

The dashboard is a **comprehensive single-page application** (~16,500 lines) with these tabs:

### Dashboard Tab
- **Bot table** with real-time status: name, ship, state, credits, fuel, hull/shield, cargo, location
- **Fleet stats bar:** total credits, fuel, cargo, faction funds
- **Grid view** and **compact mode** for different screen sizes
- **Search/filter** by routine, status, name
- **Bulk start/stop** for idle/running bots
- **Emergency Return Home** button (stops all bots, sends them home)

### Command All Tab
- **Fleet-wide command execution** to all running bots
- **Broadcast messages** to all bots simultaneously
- **Emergency overrides** and manual interventions

### Fleet Combat Tab
- **Real-time battle management** interface
- **Fleet coordination** for multi-bot combat operations
- **Target assignment** and fire mode controls

### Map Tab
- **Galaxy map visualization** built from explorer data
- **Filterable** by security level (high, medium, low, lawless, frontier)
- **Resource overlays** showing ore, gas, ice locations
- **Station markers** with market data
- **Pathfinding** display between systems

### Market Tab
- **Market data browser** across all stations
- **Price comparison** tools
- **Trade opportunity** identification

### Missions Tab
- **Browse available missions** per system
- **View/claim/complete** active missions per bot
- **Mission tracking** and progress monitoring

### Faction Tab
- **Full faction management** from the browser
- **Overview:** leader, members, treasury, allies/enemies/wars, deposit/withdraw credits
- **Members:** role management (recruit/member/officer/leader), kick, invite players, quick-invite bots
- **Storage:** view/deposit/withdraw faction items, missing lockbox detection
- **Facilities:** list faction facilities, toggle on/off, check upgrades, build new facilities
- **Diplomacy:** set ally/enemy, declare war, propose/accept peace
- **Intel:** query intel by system/player, view intel status, trade intel

### Shipyard Tab
- **Ship buying/selling** interface
- **Mod management** for ship customization
- **Recipe browser** for ship components

### Stats Tab
- **Daily statistics** per bot (30-day retention)
- **Faction activity logs** with filtering
- **Performance metrics** and trends

### Settings Tab
- **Per-routine configuration** for all 20 routines
- **Per-bot overrides** for individual customization
- **Settings saved** to `data/settings.json`

### Bot Profile Page
Click any bot name to access full manual control panel:

- **Navigation:** travel, jump, dock/undock
- **Actions:** mine, scan, refuel, repair
- **Market:** buy/sell with live market prices
- **Crafting:** craft with recipe browser
- **Storage:** deposit/withdraw station storage
- **Social:** send gifts/credits between bots
- **Wreck Salvage:** scanner with loot all/loot selected/loot modules
- **Custom Commands:** execute any game API call manually

---

## Advanced Multi-Bot Coordination

### Flock Mining
Multiple miner bots coordinate to mine together at the same location, enabling protection by combat escorts.

- **Leader-Follower Model:** One bot decides where to mine, others follow
- **File-Based Coord:** Shared JSON files in `data/flock_signals/` for communication
- **Multiple Groups:** Configure multiple flocks, each targeting different ores
- **Automatic Target Selection:** Leader chooses optimal mining location
- **Synchronized Navigation:** Followers wait for leader to jump first
- **Escort Integration:** Each flock member can have dedicated escorts
- **Stale State Detection:** 60-second timeout prevents following dead leaders

See [Flock Mining Guide](FLOCK_MINING_GUIDE.md) for detailed configuration.

### Bot-to-Bot Chat Channel
In-memory, client-side communication for fast coordination **without** API calls.

- **Zero API calls** — pure client-side messaging
- **4 channels:** `fleet`, `escort`, `coordination`, `general`
- **Directed or broadcast** messaging
- **Message history** (last 100 messages retained)
- **Metadata support** for structured data
- **Used by:** Escort, Fleet Hunter, Cargo Mover, Commander routines

See [Bot Chat Channel](BOT_CHAT_CHANNEL.md) for architecture details.

### Fleet Combat
Coordinated multi-bot combat with commander/subordinate hierarchy.

- **Fleet Commands:** MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
- **Fire Modes:** Focus fire (all target one) or spread fire (independent targets)
- **Fleet Communication Service** (`src/fleet_comm.js`) for command broadcasting
- **Optional Faction Broadcast** for wider coordination
- **Post-Patrol Logistics** (dock, repair, resupply automation)

### Trade Coordination
Prevents multiple bots from competing on the same trade routes.

- **Route Locking** via `data/tradeCoordination.json`
- **Trade Session Tracking** with persistent activity logs
- **Working Balance Management** (200k credits default)

### Cargo Mover Coordination
Allows 3-4 bots to work together on the same cargo haul.

- **Item Quantity Locking** prevents over-commitment
- **Persistent Activity Tracking** for crash recovery
- **Automatic Resumption** after interruptions

### Rescue Cooperation
Multi-bot rescue coordination with distance-based priority.

- **Claim System:** Bots claim rescues via private messages
- **Distance Optimization:** Closer bot takes priority
- **Claim Expiry:** 5-minute timeout prevents stale claims
- **Partner Bot Caching** for faster coordination

---

## AI Integration

### AI Routine (Autonomous Gameplay)
Bots can play the game autonomously using LLMs.

- **Model Support:** Ollama, LM Studio, Anthropic, OpenAI-compatible endpoints
- **Tool-Calling:** Game actions exposed as AI tools
- **Persistent Memory:** `data/ai_memory.json` for long-term learning
- **Captain's Log:** Periodic state summaries for context
- **TODO Tracking:** Goal-oriented behavior with task lists
- **Session Handoff:** Clean restarts with state preservation
- **Context Compaction:** Handles long-running sessions efficiently

### AI Chat Service
Global background service monitors chat and responds with personality.

- **Model Support:** Ollama, LM Studio, Anthropic, OpenAI-compatible endpoints
- **Per-Bot Personalities:** `data/personalities/{bot-name}.md`
- **Conversation History:** `data/ai_chat_memory.json` for context
- **Bot Locking:** Prevents multiple bots responding simultaneously
- **Map Summary Integration:** Galaxy context for responses
- **Channel Support:** Local, faction, system, and private chat
- **Mayday Coordination:** AI-powered emergency response
- **Customs Responses:** Personality-based customs interaction

---

## Combat System

### Battle Detection
- **Global WebSocket tracking** — real-time battle state (works during HTTP 524 timeouts)
- **Battle interrupt detection** for jump/travel commands
- **Participant parsing** for pirate identification

### Combat Stances
- **Fire:** 100% attack, 100% defense (default)
- **Brace:** 0% attack, 2x shield regeneration (shields critical)
- **Flee:** Automatic retreat to safe system (hull critical)

### Pirate Detection & Avoidance
- **Nearby entity scanning** identifies pirates
- **Battle participant analysis** detects pirate involvement
- **Pirate tier system:** small, medium, large, capitol, boss
- **Stronghold proximity checks** via BFS pathfinding
- **Temporary blacklisting** of pirate-adjacent systems
- **Emergency flee** with random safe route selection
- **Pirate trap detection** in rescue operations (false flag operations)

### Combat Features
- **Ammo management** with automatic reload
- **Auto-cloak** support
- **Mod management** (ensure combat mods fitted)
- **Ship insurance** auto-renewal on dock
- **Wreck looting** (cargo items + ship modules)
- **Wreck towing** to salvage yard stations
- **Wreck scavenging** during routine operations

---

## Rescue & Emergency Systems

### MAYDAY System
Parses emergency distress messages from chat.

- **Regex-based parsing** of MAYDAY messages
- **Legitimacy validation** (fuel below threshold, default 25%)
- **Queue management** with 5-minute expiry
- **Duplicate prevention**
- **Pirate base proximity lockouts**

### Rescue Queue
Route-optimized batch rescues.

- **Persistent queue** in `data/rescueQueue.json`
- **Attempt tracking** and failure handling
- **Route optimization** for efficiency

### Rescue BlackBook
Player reputation tracking.

- **Tracks:** rescue requests, ghost count, successful rescues, total credits billed
- **Manual override** support (always/never rescue)
- **Persistent** in `data/rescueBlackBook.json`

### Rescue Billing
Automated billing for rescue services. maybe someday this will be actually billable in game?

- **Cost per jump** and cost per fuel delivered
- **Invoice generation** for rescued players
- **BlackBook integration** for billing history

### Emergency Features
- **Emergency Return Home:** Stops all running bots and sends them home
- **Emergency Warp Stabilizer detection:** Auto-stops routine if stabilizer triggers
- **Mass disconnect handling:** Graceful shutdown + restart + session clearing when 5+ bots lose sessions
- **Emergency fuel recovery:** Sell cargo, scavenge wrecks for fuel cells, wait for rescue, or dock and wait for station restock
- **Death detection and recovery:** All routines handle death/respawn

---

## Faction Management

Complete in-game faction management from your browser:

### Overview
- **Leader, members, treasury tracking**
- **Allies/enemies/wars** status
- **Deposit/withdraw** faction credits

### Members
- **Role management** (recruit/member/officer/leader)
- **Kick members** from faction
- **Invite players** to faction
- **Quick-invite** your other bots with auto-accept

### Storage
- **View/deposit/withdraw** faction items
- **Missing lockbox detection** and build prompts
- **Faction facility** storage management

### Facilities
- **List faction facilities** at current station
- **Toggle on/off** facilities
- **Check upgrades** for facilities
- **Build new facilities** (lockbox, etc.)

### Diplomacy
- **Set ally/enemy** status with other factions
- **Declare war** on factions
- **Propose/accept** peace treaties

### Intel
- **Query intel** by system or player
- **View intel status** and history
- **Trade intel** with other factions

---

## Galaxy Map & Exploration

### Map Store
Auto-built galaxy map from explorer data.

- **System BFS pathfinding** for route calculation
- **Station finding** with hop counting
- **Market data recording** per station
- **Resource scan data** tracking
- **Ore depletion tracking** with timeout
- **Wormhole registration** and tracking
- **Mobile capital location** tracking
- **Seed from public API** (`/api/map`) for initial data
- **Persistent** in `data/map.json`

### Explorer Features
- **Systematic galaxy mapping** — visits every POI
- **Hidden POI discovery** via survey scanners
- **Wormhole detection** and registration
- **Pirate avoidance** with BFS proximity checks
- **Focus area mode** for concentrated exploration
- **Resource scanning** for ore/gas/ice locations
- **Security level filtering** (avoid dangerous systems)

---

## Security & Robustness

### Session Management
- **Session token persistence** and recovery
- **V1 and V2 dual sessions** for redundancy
- **Global serial queue** for session creation (prevents rate limit spam)
- **Exponential backoff** for reconnection
- **Full login fallback** after too many session recovery failures

### Error Handling
- **Response caching** with per-command TTL
- **Mutation-based cache invalidation**
- **HTTP 502/524 retry** with backoff (3 retries)
- **Action pending detection** and retry
- **Emergency Warp Stabilizer detection** (auto-stops routine)
- **120-second timeout** for jump/travel with position verification

### Mass Disconnect Detector
- **Monitors** for mass session invalidations across multiple bots
- **Triggers graceful shutdown** with restart when 5+ unique bots lose sessions within 5 seconds
- **Clears session files** on restart to avoid invalid session loops

### Customs Inspection
- **Confederacy Customs inspections** when entering empire systems
- **Proactive 2-second post-jump wait** for empire systems
- **Customs ship scanning** and detection
- **Statistics tracking** in `data/customsStops.json`
- **Empire system detection** (Voidborn, Nebula, Crimson, Solarian)
- **AI Chat coordination** for personality-based customs responses

### Other Robustness Features
- **Settings corruption recovery**
- **Queue cleanup** for stale entries
- **Player name store** — persistent discovery and deduplication
- **HTTP response caching** for external API calls
- **Debug logging** — per-bot logging to `data/debug.log`

---

## Adding Bots

From the dashboard:

1. **Register New** — enter a registration code from [spacemolt.com/dashboard](https://spacemolt.com/dashboard), pick a username and empire
2. **Add Existing** — enter username and password for an existing account

**Credentials** are saved to `sessions/<username>/credentials.json`. Bots auto-discover on restart.

**Auto-Resume:** Bot assignments persist across restarts via `botAssignments` in settings.

---

## Project Structure

```
spacemolt_botrunner/
├── src/
│   ├── botmanager.ts              # Entry point — discovers bots, starts web server, routes actions
│   ├── bot.ts                     # Bot class — login, exec, status caching, routine runner, battle state
│   ├── api.ts                     # SpaceMolt REST client (V1 + V2) with session management, caching
│   ├── session.ts                 # Credential persistence
│   ├── ui.ts                      # Log routing (bot → web server → browser)
│   ├── debug.ts                   # Debug logging to data/debug.log
│   ├── mapstore.ts                # Galaxy map persistence
│   ├── catalogstore.ts            # Game catalog cache (items, ships, recipes)
│   ├── aichat_service.ts          # Global AI chat service (~2000 lines)
│   ├── customs.ts                 # Confederacy Customs inspection service
│   ├── mayday.ts                  # MAYDAY emergency rescue parser
│   ├── rescueQueue.ts             # Rescue queue with route optimization
│   ├── rescueBlackBook.ts         # Rescue blacklist/reputation tracking
│   ├── manualrescue.ts            # Manual rescue request queue
│   ├── rescuecoordination.ts      # Multi-bot rescue coordination
│   ├── cooperation/
│   │   └── rescueCooperation.ts   # Inter-bot rescue cooperation
│   ├── fleet_comm.ts              # Fleet communication service
│   ├── bot_chat_channel.ts        # In-memory bot-to-bot chat
│   ├── playernames.ts             # Player name tracking
│   ├── playernamestore.ts         # Persistent player name store
│   ├── reconnectqueue.ts          # Session reconnection queue
│   ├── massdisconnect.ts          # Mass disconnect detector
│   ├── httpcache.ts               # HTTP response caching
│   ├── commander.ts               # CLI AI commander
│   ├── tools.ts                   # AI tool definitions
│   ├── loop.ts                    # AI agent loop with context compaction
│   ├── schema.ts                  # Game command schema for AI
│   ├── model.ts                   # LLM model resolution
│   ├── routines/
│   │   ├── common.ts              # Shared utilities (~3100 lines)
│   │   ├── miner.ts               # Mining routine (~4000 lines)
│   │   ├── explorer.ts            # Exploration routine (~2600 lines)
│   │   ├── crafter.ts             # Crafting routine (~1500 lines)
│   │   ├── trader.ts              # Trading routine (~2700 lines)
│   │   ├── hunter.ts              # Pirate hunting routine (~1800 lines)
│   │   ├── rescue.ts              # Fuel rescue routine (~5700 lines)
│   │   ├── salvager.ts            # Wreck scavenging routine (~870 lines)
│   │   ├── escort.ts              # Escort routine (~1200 lines)
│   │   ├── ai.ts                  # AI/LLM autonomous play (~920 lines)
│   │   ├── coordinator.ts         # Market analysis coordinator (~960 lines)
│   │   ├── cargo_mover.ts         # Cargo hauling routine (~1600 lines)
│   │   ├── return_home.ts         # Emergency return home (~250 lines)
│   │   ├── command_receiver.ts    # Remote command receiving
│   │   ├── cleanup.ts             # Storage cleanup routine (~710 lines)
│   │   ├── faction_trader.ts      # Faction trading routine
│   │   ├── trade_buyer.ts         # Trade buyer routine (~1200 lines)
│   │   ├── fleet_hunter_commander.ts  # Fleet combat commander (~1400 lines)
│   │   ├── fleet_hunter_subordinate.ts # Fleet combat wingman
│   │   ├── miner_radioactive.ts   # Radioactive mining support
│   │   ├── craft-goals.ts         # Crafting goal calculation
│   │   ├── minerActivity.ts       # Mining session tracking
│   │   ├── traderActivity.ts      # Trade session tracking
│   │   ├── rescueActivity.ts      # Rescue session tracking
│   │   ├── cargoMoverActivity.ts  # Cargo mover activity tracking
│   │   ├── cargoMoverCoordination.ts # Cargo multi-bot coordination
│   │   └── traderCoordination.ts  # Trade route locking
│   ├── web/
│   │   ├── server.ts              # Bun.serve HTTP + WebSocket server
│   │   ├── index.html             # Dashboard SPA (~16,500 lines)
│   │   └── index.css              # Stylesheet (~3500 lines)
│   └── types/
│       └── game.ts                # Comprehensive game type definitions (600+ lines)
│
├── data/
│   ├── settings.json              # Per-routine and per-bot settings
│   ├── map.json                   # Galaxy map data
│   ├── catalog.json               # Game catalog cache
│   ├── stats.json                 # Daily bot statistics (30-day retention)
│   ├── main_logs.json             # Main log buffers
│   ├── playerNames.json           # Discovered player/pirate/NPC names
│   ├── customsStops.json          # Customs inspection statistics
│   ├── rescueQueue.json           # Rescue queue
│   ├── rescueBlackBook.json       # Player rescue reputation
│   ├── ai_memory.json             # AI routine persistent memory
│   ├── ai_chat_memory.json        # AI chat conversation history
│   ├── minerActivity.json         # Mining session tracking
│   ├── traderActivity.json        # Trade session tracking
│   ├── rescueActivity.json        # Rescue session tracking
│   ├── tradeCoordination.json     # Trade route locking
│   ├── cargoMoverActivity.json    # Cargo movement tracking
│   ├── cargoMoverCoordination.json # Cargo multi-bot coordination
│   ├── craftingLoadouts.json      # Crafting loadout configurations
│   ├── personalities/             # AI chat personality definitions
│   ├── flock_signals/             # Flock mining coordination files
│   ├── escort_signals/            # Escort coordination files
│   └── logs/                      # Per-bot log files
│
└── sessions/
    └── <username>/
        ├── credentials.json       # Bot credentials
        └── session.json           # Session tokens
```

---

## Configuration

All settings are stored in `data/settings.json` and configurable via the web UI.

### Global Settings
- `general.port` — Web server port (default 3000)
- `general.homeSystem` — Default home system
- `system_blacklist` — Systems to avoid (pirate systems, etc.)
- `botAssignments` — Auto-resume mapping (bot → routine)

### Key Per-Routine Settings

#### Miner
- `miningType` (auto/ore/gas/ice/radioactive)
- `targetOre/targetGas/targetIce/targetRadioactive/targetDeepCore`
- `depositMode` (storage/faction/sell), `depositBot`
- `cargoThreshold`, `refuelThreshold`, `repairThreshold`
- `flockEnabled`, `flockName`, `flockRole`, `flockGroups`
- `escortName`, `escortSignalChannel`
- `jettisonOres`, `deepCoreJettisonOres`, `radioactiveJettisonOres`
- `depletionTimeoutHours`, `ignoreDepletion`, `stayOutUntilFull`

#### Crafter
- `craftLimits` (recipe → stock limit)
- `enabledCategories` (Refining, Components, Consumables, etc.)
- `categoryAssignments` (bot → categories)
- `botQuotaOverrides` (per-bot quota overrides)
- `goalProcessingMode` (batch/round-robin)
- `autoBuy` (enabled, maxPricePercentOverBase, maxCreditsPerCycle, excludeCategories)

#### Explorer
- `mode` (explore/trade_update/deep_core_scan)
- `acceptMissions`, `focusAreaSystem`, `maxJumps`
- `surveyMode` (quick/thorough), `scanPois`
- `directToUnknown`, `groupUnknowns`, `scavengeEnabled`, `loadFuelCellsAtHome`

#### Rescue
- `fuelThreshold`, `rescueFuelCells`, `rescueCredits`, `scanIntervalSec`
- `maydayMaxJumps`, `maydayFuelThreshold`
- `costPerJump`, `costPerFuel` (rescue billing)
- `cooperationEnabled`, `partnerBotName`, `cooperationMaxDelaySeconds`
- `maydayPirateProximityThreshold`, `maydayPirateLockoutMinutes`

#### Hunter
- `system`, `refuelThreshold`, `repairThreshold`, `fleeThreshold`
- `onlyNPCs`, `autoCloak`, `ammoThreshold`, `maxReloadAttempts`
- `responseRange`, `maxAttackTier`, `fleeFromTier`, `minPiratesToFlee`

#### Trader
- `homeSystem`, `refuelThreshold`, `repairThreshold`
- `maxFactionCreditsToUse`

#### Salvager
- `depositMode`, `cargoThreshold`, `refuelThreshold`, `repairThreshold`
- `homeSystem`, `salvageYardSystem`, `salvageYardStation`
- `autoCloak`, `enableFullSalvage`, `enableTowing`, `minTowValue`, `preferScrap`
- `maxRoamJumps`, `roamBaseSystems`, `depositAtSalvageYard`

#### Fleet Hunter
- `fleetId`, `patrolSystem`, `fireMode` (focus/spread), `fleetSize`
- `huntingEnabled`, `manualMode`, `enableFactionBroadcast`

#### Escort
- `minerName`, `refuelThreshold`, `repairThreshold`, `fleeThreshold`
- `maxAttackTier`, `fleeFromTier`, `minPiratesToFlee`, `autoCloak`
- `ammoThreshold`, `maxReloadAttempts`, `signalChannel`

#### AI
- `model`, `baseUrl`, `apiKey`, `cycleIntervalSec`
- `maxToolCallsPerCycle`, `captainsLogEveryN`

#### Cargo Mover
- `sourceStation`, `destinationStation`, `destinationStorageType`, `destinationBotName`
- `items` to move with quantity tracking

---

## About SpaceMolt

[SpaceMolt](https://www.spacemolt.com) is a massively multiplayer online game designed for AI agents. Thousands of LLMs play simultaneously in a vast galaxy — mining, trading, exploring, and fighting.

**Key Game Features:**
- Star systems with Points of Interest (POIs)
- Ship combat with multiple stances and targeting
- Resource extraction (ore, gas, ice, radioactive materials)
- Trading and market economy
- Crafting with recipe system
- Mission system
- Faction management
- Confederacy Customs inspections

---

## License

MIT

---

**Questions or need help?** see the SpaceMolt discord, and ask LT1428.

**Like this project?** Show some love — it's built with ❤️ and zero frameworks.

thanks to the original creator of this client: Humbrol2. you can see his other awesome clients at: https://github.com/humbrol2 and as well as Jimmcq's work as well: https://github.com/jimmcq
