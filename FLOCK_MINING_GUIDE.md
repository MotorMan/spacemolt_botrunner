# Flock Mining Guide

## Overview

Flock mining allows multiple miner bots to coordinate and mine together at the same location. This enables them to be protected by combat escorts while mining. The system supports multiple flocks, each targeting different ores simultaneously.

## How It Works

- **Leader-Follower Model**: One bot acts as the leader and decides where to mine. Other bots (followers) read the leader's decisions and follow.
- **File-Based Coordination**: Flock members communicate via shared JSON files in `data/flock_signals/` directory.
- **Multiple Groups**: You can configure multiple flocks, each mining different resources at different locations.
- **Manual Grouping**: Currently, flock membership and roles are manually configured per bot.

## Configuration

### Settings Structure

Add these settings to your `settings.json`:

#### Global Miner Settings (applies to all miners by default)

```json
{
  "miner": {
    "flockEnabled": true,
    "flockName": "iron_flock",
    "flockRole": "leader",
    "flockGroups": [
      {
        "name": "iron_flock",
        "targetOre": "iron_ore",
        "targetGas": "",
        "targetIce": "",
        "miningType": "ore",
        "rallySystem": "Alpha-7",
        "maxMembers": 5
      }
    ]
  }
}
```

#### Per-Bot Overrides (for individual bots)

```json
{
  "miner_bot_1": {
    "homeSystem": "Alpha-7",
    "flockEnabled": true,
    "flockName": "iron_flock",
    "flockRole": "leader"
  },
  "miner_bot_2": {
    "homeSystem": "Alpha-7",
    "flockEnabled": true,
    "flockName": "iron_flock",
    "flockRole": "follower"
  },
  "miner_bot_3": {
    "homeSystem": "Beta-3",
    "flockEnabled": true,
    "flockName": "copper_flock",
    "flockRole": "leader"
  }
}
```

### Configuration Fields

#### Flock Settings

- `flockEnabled` (boolean): Enable/disable flock mining for this bot
- `flockName` (string): Name of the flock this bot belongs to
- `flockRole` (string): Either `"leader"` or `"follower"`
  - **Leader**: Decides where to mine and announces it to followers
  - **Follower**: Reads leader's decisions and follows

#### Flock Group Configuration

- `name` (string): Unique identifier for this flock group
- `targetOre` (string): Target ore to mine (e.g., "iron_ore", "copper_ore")
- `targetGas` (string): Target gas to harvest (e.g., "hydrogen_gas")
- `targetIce` (string): Target ice to harvest (e.g., "water_ice")
- `miningType` (string): Mining type - `"auto"`, `"ore"`, `"gas"`, or `"ice"`
- `rallySystem` (string, optional): System where flock members should gather before mining
- `maxMembers` (number, optional): Maximum number of bots in this flock

## Example: Two Flocks Mining Different Ores

### Scenario
- Flock 1: 3 bots mining iron ore in system "Alpha-7"
- Flock 2: 2 bots mining copper ore in system "Beta-3"
- Each flock has 1 leader and 2 followers (or 1 follower for Flock 2)

### Settings

```json
{
  "miner": {
    "flockEnabled": true,
    "cargoThreshold": 80,
    "refuelThreshold": 50,
    "flockGroups": [
      {
        "name": "iron_flock",
        "targetOre": "iron_ore",
        "miningType": "ore",
        "rallySystem": "Alpha-7",
        "maxMembers": 3
      },
      {
        "name": "copper_flock",
        "targetOre": "copper_ore",
        "miningType": "ore",
        "rallySystem": "Beta-3",
        "maxMembers": 2
      }
    ]
  },
  "iron_miner_1": {
    "homeSystem": "Alpha-7",
    "flockEnabled": true,
    "flockName": "iron_flock",
    "flockRole": "leader"
  },
  "iron_miner_2": {
    "homeSystem": "Alpha-7",
    "flockEnabled": true,
    "flockName": "iron_flock",
    "flockRole": "follower"
  },
  "iron_miner_3": {
    "homeSystem": "Alpha-7",
    "flockEnabled": true,
    "flockName": "iron_flock",
    "flockRole": "follower"
  },
  "copper_miner_1": {
    "homeSystem": "Beta-3",
    "flockEnabled": true,
    "flockName": "copper_flock",
    "flockRole": "leader"
  },
  "copper_miner_2": {
    "homeSystem": "Beta-3",
    "flockEnabled": true,
    "flockName": "copper_flock",
    "flockRole": "follower"
  }
}
```

## How Flock Mining Works

### Leader Behavior

1. **Target Selection**: Leader determines the best mining location based on:
   - Flock group configuration (`targetOre`, `targetGas`, `targetIce`)
   - Resource availability in the map
   - Distance and jump costs
   - Station availability for refueling/repairs

2. **Announcement**: Leader writes flock state to `data/flock_signals/<flockName>.json`:
   ```json
   {
     "leader": "iron_miner_1",
     "targetSystemId": "Alpha-7",
     "targetPoiId": "asteroid_belt_1",
     "targetPoiName": "Asteroid Belt Alpha",
     "targetResourceId": "iron_ore",
     "miningType": "ore",
     "phase": "traveling",
     "members": ["iron_miner_1", "iron_miner_2", "iron_miner_3"],
     "lastUpdate": 1234567890,
     "rallySystem": "Alpha-7"
   }
   ```

3. **Navigation**: Leader jumps to target system and travels to mining POI

4. **Mining**: Leader mines until cargo is full or resource is depleted

5. **Return**: Leader returns to station to deposit cargo, then starts new cycle

### Follower Behavior

1. **Wait for Leader**: If no flock state exists, follower waits for leader to announce target

2. **Read State**: Follower reads flock state from shared file

3. **Registration**: Follower adds itself to the flock members list

4. **Follow**: Follower navigates to the same system and POI as the leader

5. **Synchronization**: Follower waits ~5 seconds after leader jumps (to let leader arrive first)

6. **Mining**: Follower mines at the same location as the leader

7. **Return**: Follower returns to station when cargo is full

## Escort Integration

Flock mining works with the existing escort system. Configure escorts for each miner:

```json
{
  "iron_miner_1": {
    "flockEnabled": true,
    "flockName": "iron_flock",
    "flockRole": "leader",
    "escortName": "combat_escort_1",
    "escortSignalChannel": "faction"
  }
}
```

All flock members can have their own escorts, or multiple flocks can share escorts.

## Coordination Files

Flock state is stored in: `data/flock_signals/<flockName>.json`

- Files are automatically created/updated by flock leaders
- Followers read these files to know where to go
- State becomes stale after 60 seconds (prevents following dead leaders)

## Future Enhancements (Not Yet Implemented)

- **Automatic Grouping**: Detect available miners and divide them equally into flocks
- **Dynamic Leader Election**: Automatically elect new leader if current leader goes offline
- **Load Balancing**: Automatically balance flock sizes based on resource availability
- **Flock Chat**: Use in-game faction chat for coordination instead of files
- **Formation Mining**: Coordinate mining positions within the POI to avoid interference

## Troubleshooting

### Follower Not Moving
- Check if flock state file exists: `data/flock_signals/<flockName>.json`
- Verify leader is running and has `flockRole: "leader"`
- Check that `flockName` matches exactly between leader and follower

### Leader Not Announcing Target
- Ensure leader has proper mining equipment detected
- Check that target resource exists in the map
- Verify `flockEnabled: true` and `flockRole: "leader"`

### Multiple Flocks Interfering
- Each flock should have a unique `flockName`
- Verify flock groups are properly separated in `flockGroups` array
- Check that each flock has its own leader

## Logs to Watch

When flock mining is working correctly, you should see logs like:

```
[flock] Flock mode: LEADER of "iron_flock"
[flock] Leader target: iron_ore (ore)
[flock] Announced target to flock: Asteroid Belt Alpha @ Alpha-7
[flock] Flock phase updated: traveling
[flock] Waiting 5s for leader to jump first...
[flock] Using flock target: iron_ore (ore)
[flock] Flock phase updated: mining
[flock] Signaling flock: miner docking...
```
