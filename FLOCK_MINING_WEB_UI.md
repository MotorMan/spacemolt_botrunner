# Flock Mining Web UI Guide

## Accessing Flock Mining Settings

1. Open the SpaceMolt Commander dashboard
2. Click on the **Settings** tab
3. In the left sidebar, click on **Miner**
4. Scroll down to the **🐦 Flock Mining** section

## Configuration Steps

### Step 1: Enable Flock Mining

- Check the **Enable Flock Mining** checkbox
- This activates flock coordination for all miners using this configuration

### Step 2: Set Flock Name

- Enter a unique name for your flock group (e.g., `iron_flock`, `copper_flock`)
- **Important**: All bots in the same flock must use the exact same name
- Different flocks should have different names

### Step 3: Assign Roles

For each bot, choose a role:
- **Leader**: This bot will decide where to mine and announce the target to followers
- **Follower**: This bot will automatically follow the leader's decisions

**Recommended Setup:**
- 1 Leader per flock
- 1 or more Followers per flock

### Step 4: Configure Flock Groups

The **Flock Groups Configuration** table allows you to define multiple mining operations:

1. **Flock Name**: Enter the name of the flock group (must match the name in Step 2)
2. **Target Ore**: Select the ore this flock should mine (e.g., iron_ore, copper_ore)
3. **Target Gas**: Select gas resource (if gas harvesting)
4. **Target Ice**: Select ice resource (if ice mining)
5. **Mining Type**: Choose Auto, Ore, Gas, or Ice
6. **Rally System** (optional): System where flock members should gather
7. **Max Members** (optional): Maximum number of bots in this flock

Click **Add Group** to add the flock group to the table.

### Step 5: Save Settings

Click the **Save Settings** button at the bottom of the page.

## Example: Setting Up Two Flocks

### Iron Mining Flock

**Global Miner Settings:**
```
✓ Enable Flock Mining: checked
Flock Name: iron_flock
Flock Role: Leader (for iron_miner_1) or Follower (for iron_miner_2, iron_miner_3)
```

**Flock Group:**
```
Flock Name: iron_flock
Target Ore: iron_ore
Target Gas: (leave empty)
Target Ice: (leave empty)
Mining Type: ore
Rally System: Alpha-7
Max Members: 3
```

### Copper Mining Flock

**Global Miner Settings:**
```
✓ Enable Flock Mining: checked
Flock Name: copper_flock
Flock Role: Leader (for copper_miner_1) or Follower (for copper_miner_2)
```

**Flock Group:**
```
Flock Name: copper_flock
Target Ore: copper_ore
Target Gas: (leave empty)
Target Ice: (leave empty)
Mining Type: ore
Rally System: Beta-3
Max Members: 2
```

## Per-Bot Configuration

After configuring the global miner settings, you can set per-bot overrides:

1. Go to the **Dashboard** tab
2. Click on a specific bot's name to open its profile
3. Scroll to the miner settings section
4. Set the bot's specific `flockRole` (leader or follower)

## Monitoring Flock Mining

When flock mining is active, you'll see logs like:

```
[flock] Flock mode: LEADER of "iron_flock"
[flock] Leader target: iron_ore (ore)
[flock] Announced target to flock: Asteroid Belt Alpha @ Alpha-7
[flock] Flock phase updated: traveling
[flock] Waiting 5s for leader to jump first...
[flock] Using flock target: iron_ore (ore)
[flock] Flock phase updated: mining
```

## Troubleshooting

### Flock Not Working
1. Verify all flock members have the same `flockName`
2. Ensure one bot is set as `leader` and others as `follower`
3. Check that flock groups are properly configured in the settings
4. Make sure you clicked **Save Settings** after making changes

### Followers Not Moving
1. Check that the leader is running and has selected a target
2. Verify the flock group exists in the Flock Groups Configuration table
3. Look for errors in the activity log

### Multiple Flocks Interfering
1. Each flock must have a unique `flockName`
2. Each flock should have its own entry in the Flock Groups table
3. Each flock needs its own leader

## Tips

- **Start Simple**: Begin with one flock and 2-3 bots before scaling up
- **Use Rally Systems**: Set a rally system to have all flock members gather before mining
- **Set Max Members**: Prevent too many bots from joining a single flock
- **Monitor Logs**: Watch the activity log to verify flock coordination is working
- **Test First**: Test with one follower before adding multiple bots
