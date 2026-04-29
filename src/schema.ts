import { log, logError } from "./ui.js";
import { cachedFetch } from "./httpcache.js";

export interface GameCommandInfo {
  name: string;
  description: string;
  isMutation: boolean;
}

/**
 * Fetch the OpenAPI spec from the gameserver and extract command names
 * and short descriptions. Returns a compact summary instead of full
 * tool schemas to save tokens.
 */
export async function fetchGameCommands(baseUrl: string): Promise<GameCommandInfo[]> {
  // baseUrl is like https://game.spacemolt.com/api/v2
  // OpenAPI spec is at https://game.spacemolt.com/api/v2/openapi.json
  const specUrl = baseUrl + "/openapi.json";

  let spec: any;
  try {
    spec = await cachedFetch(specUrl, 60 * 60_000); // 1hr fallback TTL
  } catch (err) {
    logError(`Failed to fetch OpenAPI spec from ${specUrl}: ${err instanceof Error ? err.message : err}`);
    log("system", "Falling back to empty command list — agent can use get_commands at runtime");
    return [];
  }

  const paths: Record<string, any> = spec.paths ?? {};
  const commands: GameCommandInfo[] = [];

  for (const [path, methods] of Object.entries(paths)) {
    const op = methods?.post;
    if (!op) continue;

    const name: string = op.operationId;
    if (!name) continue;

    // Skip /session — handled internally by api.ts
    if (name === "createSession" || path === "/session") continue;

    const isMutation = !!op["x-is-mutation"];
    const description = op.summary || name;

    commands.push({ name, description, isMutation });
  }

  log("system", `Loaded ${commands.length} game commands from OpenAPI spec`);
  return commands;
}

/**
 * Format commands as a compact pipe-separated list for the system prompt.
 * Queries and mutations are separated for clarity.
 */
export function formatCommandList(commands: GameCommandInfo[]): string {
  const queries = commands.filter(c => !c.isMutation).map(c => c.name);
  const mutations = commands.filter(c => c.isMutation).map(c => c.name);

  const lines: string[] = [];
  if (queries.length > 0) {
    lines.push(`Query commands (free, no tick cost): ${queries.join("|")}`);
  }
  if (mutations.length > 0) {
    lines.push(`Action commands (costs 1 tick): ${mutations.join("|")}`);
  }
  return lines.join("\n");
}
