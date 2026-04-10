# Bot-to-Bot Chat Channel

## Overview
In-memory, client-side only communication channel for bots to coordinate **without** using the game API. This provides fast, reliable messaging for:
- Escort coordination
- Fleet combat management
- Multi-bot orchestration
- Quick status updates

## Architecture
```
┌─────────┐     send()      ┌──────────────────┐     handlers     ┌─────────┐
│ Bot A   │ ──────────────> │ BotChatChannel   │ ──────────────> │ Bot B   │
└─────────┘                 │ (in-memory)      │                  └─────────┘
                            │                  │ ──────────────> │ Bot C   │
                            └──────────────────┘                  └─────────┘
```

**Key Features:**
- ✅ **Zero API calls** - Pure client-side messaging
- ✅ **Instant delivery** - No network latency
- ✅ **Channel-based filtering** - Organize by purpose
- ✅ **Directed or broadcast** - Target specific bots or all
- ✅ **Message history** - Last 100 messages retained
- ✅ **Metadata support** - Attach structured data

## Channels

Four predefined channels for different coordination needs:

| Channel | Purpose |
|---------|---------|
| `fleet` | Fleet combat management, target coordination |
| `escort` | Escort positioning, protection status |
| `coordination` | Multi-bot orchestration, task assignment |
| `general` | General status, casual updates |

## Usage in Routines

### Basic Send

```typescript
// In your routine
export async function* myRoutine(ctx: RoutineContext) {
  // Send a broadcast message to all bots
  ctx.sendBotChat?.("Starting mining operation", "general");
  
  // Send to specific bots
  ctx.sendBotChat?.("Need backup at sector 7", "fleet", ["bot1", "bot2"]);
  
  // Send with metadata for structured data
  ctx.sendBotChat?.("Enemy spotted", "fleet", ["wing_alpha"], {
    enemyLocation: "asteroid_field",
    threatLevel: "high",
    coordinates: { x: 100, y: 200 }
  });
}
```

### Receiving Messages

Register a handler when your routine starts:

```typescript
import { getBotChatChannel } from "./botmanager.js";

export async function* escortRoutine(ctx: RoutineContext) {
  const botName = ctx.bot.username;
  
  // Register message handler
  const handler = (msg) => {
    if (msg.sender === botName) return; // Ignore own messages
    
    switch (msg.channel) {
      case "escort":
        handleEscortCommand(msg);
        break;
      case "fleet":
        handleFleetCommand(msg);
        break;
    }
  };
  
  getBotChatChannel().onMessage(botName, handler);
  
  try {
    // Your routine logic here
    for await (const state of someGenerator()) {
      // Send status updates
      ctx.sendBotChat?.("Position updated: orbiting target", "escort");
      yield state;
    }
  } finally {
    // Clean up handler
    getBotChatChannel().offMessage(botName, handler);
  }
}
```

### Getting All Bot Names

```typescript
const allBots = ctx.getAllBotNames?.() || [];
const activeEscorts = allBots.filter(name => name.includes("escort"));
ctx.sendBotChat?.("Form up!", "escort", activeEscorts);
```

### Message History

```typescript
import { getBotChatChannel } from "./botmanager.js";

// Get last 20 messages from fleet channel
const recentFleetMessages = getBotChatChannel().getHistory("fleet", 20);

// Analyze recent combat reports
const combatReports = recentFleetMessages.filter(m => 
  m.metadata?.threatLevel === "high"
);
```

## Message Format

```typescript
interface BotChatMessage {
  sender: string;              // Bot username
  recipients: string[];        // Empty = broadcast
  channel: BotChatChannel;     // "fleet" | "escort" | "coordination" | "general"
  content: string;             // Human-readable message
  timestamp: number;           // Unix timestamp (ms)
  metadata?: Record<string, unknown>; // Optional structured data
}
```

## Examples

### Escort Coordination

```typescript
// Escort bot
ctx.sendBotChat?.("Arrived at rally point", "escort", [vipName]);
ctx.sendBotChat?.("Threat detected, moving to intercept", "escort", [vipName], {
  threatBearing: 270,
  distance: 5000
});

// VIP bot receives and can respond
```

### Fleet Combat

```typescript
// Commander bot
ctx.sendBotChat?.("Attack pattern alpha", "fleet", wingMembers, {
  targetId: "enemy_ship_123",
  attackTime: Date.now() + 30000 // Coordinated attack in 30s
});

// Wingman bots acknowledge
ctx.sendBotChat?.("Wing 2 ready, locked on target", "fleet", [commanderName]);
```

### Task Distribution

```typescript
// Coordinator bot
const miningTargets = ["asteroid_1", "asteroid_2", "asteroid_3"];
miners.forEach((miner, i) => {
  ctx.sendBotChat?.(
    `Assigned to ${miningTargets[i]}`, 
    "coordination", 
    [miner]
  );
});
```

## Logging

All bot chat messages are automatically logged to the system panel in the web UI:
```
[BOT_CHAT] [fleet] Commander -> bot1, bot2: Attack pattern alpha
[BOT_CHAT] [escort] Escort1 -> [broadcast]: Position secured
```

## Next Steps

When you're ready to integrate individual routines:
1. Add `sendBotChat` calls at key decision points
2. Register message handlers to receive commands
3. Use metadata for structured data (coordinates, targets, etc.)
4. Choose appropriate channels for message organization

The channel is ready to use now - just start calling `ctx.sendBotChat()` in your routines!
