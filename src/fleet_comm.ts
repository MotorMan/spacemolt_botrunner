/**
 * Fleet Communication Service
 * 
 * Provides local (non-game-server) communication between fleet commander
 * and subordinate bots. Uses in-memory event emitter pattern.
 * 
 * Benefits:
 * - No faction chat spam visible to humans
 * - Instant communication (no chat delay)
 * - Private - other players/AI bots can't see commands
 * - Can be toggled on/off via UI
 */

type FleetCommandType = 
  | "MOVE"
  | "ATTACK" 
  | "FLEE"
  | "REGROUP"
  | "HOLD"
  | "PATROL"
  | "STATUS_UPDATE"
  | "HUNTING_ENABLED"
  | "HUNTING_DISABLED"
  | "MANUAL_MODE_ENTERED"
  | "AUTO_MODE_ENTERED";

export interface FleetCommand {
  type: FleetCommandType;
  fleetId: string;
  params?: string;
  timestamp: number;
  commanderBot?: string;
}

interface FleetState {
  huntingEnabled: boolean;
  manualMode: boolean;
  commanderBot: string | null;
  subordinateBots: Set<string>;
  currentTarget: { id: string; name: string } | null;
  patrolSystem: string | null;
  lastCommandTime: number;
}

type CommandListener = (command: FleetCommand) => void | Promise<void>;

class FleetCommService {
  private commandListeners: Map<string, CommandListener[]> = new Map();
  private fleetStates: Map<string, FleetState> = new Map();

  /**
   * Subscribe a bot to receive fleet commands for a specific fleet
   */
  subscribe(fleetId: string, botName: string, listener: CommandListener): void {
    const key = `${fleetId}:${botName}`;
    if (!this.commandListeners.has(key)) {
      this.commandListeners.set(key, []);
    }
    this.commandListeners.get(key)!.push(listener);
    
    // Initialize fleet state if needed
    if (!this.fleetStates.has(fleetId)) {
      this.fleetStates.set(fleetId, {
        huntingEnabled: true,
        manualMode: false,
        commanderBot: null,
        subordinateBots: new Set(),
        currentTarget: null,
        patrolSystem: null,
        lastCommandTime: 0,
      });
    }
    
    const state = this.fleetStates.get(fleetId)!;
    if (state.subordinateBots.has(botName)) {
      state.subordinateBots.add(botName);
    }
  }

  /**
   * Unsubscribe a bot from fleet commands
   */
  unsubscribe(fleetId: string, botName: string, listener?: CommandListener): void {
    const key = `${fleetId}:${botName}`;
    const listeners = this.commandListeners.get(key);
    if (!listeners) return;

    if (listener) {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    } else {
      this.commandListeners.delete(key);
    }

    // Remove from fleet state
    const state = [...this.fleetStates.values()].find(s => 
      s.subordinateBots.has(botName)
    );
    if (state) {
      state.subordinateBots.delete(botName);
    }
  }

  /**
   * Broadcast a command from commander to all subordinates in a fleet
   */
  async broadcast(fleetId: string, command: FleetCommandType, params?: string, commanderBot?: string): Promise<void> {
    const state = this.fleetStates.get(fleetId);
    if (!state) {
      console.log(`Fleet ${fleetId} not initialized`);
      return;
    }

    // Check if hunting is enabled
    if (!state.huntingEnabled && !["STATUS_UPDATE"].includes(command)) {
      console.log(`Fleet ${fleetId} hunting is disabled - command ${command} ignored`);
      return;
    }

    const fleetCommand: FleetCommand = {
      type: command,
      fleetId,
      params,
      timestamp: Date.now(),
      commanderBot,
    };

    state.lastCommandTime = Date.now();

    // Update fleet state based on command
    this.updateFleetState(state, fleetCommand);

    // Send to all subordinate bots
    const promises: Promise<void>[] = [];
    for (const subBot of state.subordinateBots) {
      const key = `${fleetId}:${subBot}`;
      const listeners = this.commandListeners.get(key);
      if (listeners) {
        for (const listener of listeners) {
          promises.push(Promise.resolve(listener(fleetCommand)));
        }
      }
    }

    await Promise.all(promises);
  }

  /**
   * Send a command to a specific bot
   */
  async sendToBot(fleetId: string, botName: string, command: FleetCommandType, params?: string): Promise<void> {
    const key = `${fleetId}:${botName}`;
    const listeners = this.commandListeners.get(key);
    if (!listeners || listeners.length === 0) {
      console.log(`No listeners for ${key}`);
      return;
    }

    const state = this.fleetStates.get(fleetId);
    const fleetCommand: FleetCommand = {
      type: command,
      fleetId,
      params,
      timestamp: Date.now(),
    };

    if (state) {
      state.lastCommandTime = Date.now();
      this.updateFleetState(state, fleetCommand);
    }

    for (const listener of listeners) {
      await Promise.resolve(listener(fleetCommand));
    }
  }

  /**
   * Set a bot as the commander for a fleet
   */
  setCommander(fleetId: string, botName: string): void {
    const state = this.fleetStates.get(fleetId);
    if (!state) {
      this.fleetStates.set(fleetId, {
        huntingEnabled: true,
        manualMode: false,
        commanderBot: botName,
        subordinateBots: new Set(),
        currentTarget: null,
        patrolSystem: null,
        lastCommandTime: 0,
      });
    } else {
      state.commanderBot = botName;
    }
  }

  /**
   * Add a subordinate to a fleet
   */
  addSubordinate(fleetId: string, botName: string): void {
    const state = this.fleetStates.get(fleetId);
    if (state) {
      state.subordinateBots.add(botName);
    }
  }

  /**
   * Get fleet state
   */
  getFleetState(fleetId: string): FleetState | null {
    return this.fleetStates.get(fleetId) || null;
  }

  /**
   * Enable/disable hunting for a fleet
   */
  setHuntingEnabled(fleetId: string, enabled: boolean): void {
    const state = this.fleetStates.get(fleetId);
    if (state) {
      state.huntingEnabled = enabled;
      console.log(`Fleet ${fleetId} hunting ${enabled ? "enabled" : "disabled"}`);
    }
  }

  /**
   * Set manual/auto mode for a fleet
   */
  setManualMode(fleetId: string, manual: boolean): void {
    const state = this.fleetStates.get(fleetId);
    if (state) {
      state.manualMode = manual;
      console.log(`Fleet ${fleetId} ${manual ? "entered manual mode" : "entered auto mode"}`);
    }
  }

  /**
   * Get all fleet states (for UI)
   */
  getAllFleetStates(): Map<string, FleetState> {
    return new Map(this.fleetStates);
  }

  private updateFleetState(state: FleetState, command: FleetCommand): void {
    switch (command.type) {
      case "ATTACK":
        if (command.params) {
          const [id, name] = command.params.split(":");
          state.currentTarget = { id, name: name || id };
        }
        break;
      case "MOVE":
      case "REGROUP":
        if (command.params) {
          const [systemId] = command.params.split("/");
          state.patrolSystem = systemId;
        }
        break;
      case "HUNTING_ENABLED":
        state.huntingEnabled = true;
        break;
      case "HUNTING_DISABLED":
        state.huntingEnabled = false;
        break;
      case "MANUAL_MODE_ENTERED":
        state.manualMode = true;
        break;
      case "AUTO_MODE_ENTERED":
        state.manualMode = false;
        break;
    }
  }
}

// Singleton instance
export const fleetCommService = new FleetCommService();

/**
 * Helper to parse command params
 */
export function parseMoveParams(params: string): { systemId: string; poiId?: string } | null {
  if (!params) return null;
  const parts = params.split("/");
  return {
    systemId: parts[0],
    poiId: parts[1] || undefined,
  };
}

export function parseAttackTarget(params: string): { id: string; name: string } | null {
  if (!params) return null;
  const parts = params.split(":");
  return {
    id: parts[0],
    name: parts[1] || parts[0],
  };
}
