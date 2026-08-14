import { log, logError } from "./ui.js";
import { fetchOpenApiV2Spec, saveOpenApiV2Spec } from "./openapi.js";

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
  // baseUrl is the gameserver origin, e.g. https://game.spacemolt.com
  // OpenAPI spec is at https://game.spacemolt.com/api/v2/openapi.json
  const specUrl = baseUrl.replace(/\/+$/, "") + "/api/v2/openapi.json";

  let spec: any;
  try {
    const result = await fetchOpenApiV2Spec();
    spec = result.spec;
    const { meta, path, saved } = saveOpenApiV2Spec(spec);
    const changeNote = result.changed ? "changed" : result.throttled ? "throttled — reused cached" : "unchanged (304)";
    log("system", `OpenAPI V2 spec ${meta.gameServerVersion} ${changeNote} ${saved ? "saved" : "already present"} -> ${path}`);
  } catch (err) {
    logError(`Failed to save OpenAPI spec: ${err instanceof Error ? err.message : err}`);
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
