import type { Routine, RoutineContext } from "../bot.js";

/**
 * Command Receiver routine — waits for commands from the Command All tab.
 * 
 * This routine does nothing but keep the bot running and ready to receive
 * manual commands from the fleet-wide Command All interface.
 * 
 * Flow:
 * 1. Log that the bot is ready to receive commands
 * 2. Wait in a loop, checking for incoming commands
 * 3. Commands are executed via the normal command execution system
 */
export const commandReceiverRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  ctx.log("system", "Command Receiver ready — waiting for fleet commands...");
  ctx.log("info", "This bot will only respond to commands from the Command All tab");

  // Main loop — just wait for commands
  while (true) {
    yield "wait_idle";
    
    // Wait 5 seconds before checking again
    yield "sleep";
    
    // Periodic status log
    ctx.log("info", "Standing by for commands...");
  }
};
