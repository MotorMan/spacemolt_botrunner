import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from '@spacemolt/lib';
import {
  COMMAND_TOOL_MAP,
  COMMAND_ACTION_MAP,
  COMMANDS_WITH_PAYLOAD_ACTION,
} from '../src/commandBridge.ts';

/**
 * Offline map-validation test (no live server, no `Bot` import).
 *
 * `COMMAND_TOOL_MAP` / `COMMAND_ACTION_MAP` are the single source of truth that
 * routes every legacy `bot.exec("cmd")` through the library. A wrong tool sends
 * the call to the wrong service; a wrong action is rejected by the server. The
 * library exports `ACTIONS` — the authoritative runtime catalog of every real
 * `"tool/action"` pair (generated from the live server spec). This test asserts
 * every map entry resolves to a real `ACTIONS` key, so a typo or stale mapping
 * is caught without a live client. `ACTIONS` is pure metadata, so importing it
 * performs no connection. Run with `bun test`.
 */

const known = new Set<string>(Object.keys(ACTIONS));

function toolExists(tool: string): boolean {
  for (const k of known) if (k.startsWith(tool + '/')) return true;
  return false;
}

/**
 * Commands that intentionally do NOT route through `account.send(tool, action)`.
 * `catalog` is a bulk endpoint served by `SpacemoltClient.catalog()` (and
 * buffered into `catalogStore`), not a per-account command — so it has no
 * `(tool/action)` entry in the library `ACTIONS` catalog by design.
 */
const KNOWN_SPECIAL = new Set(['catalog']);

describe('COMMAND_TOOL_MAP/COMMAND_ACTION_MAP resolve to real library (tool, action) pairs', () => {
  it(`library ACTIONS catalog exposes ${known.size} real (tool/action) pairs`, () => {
    assert.ok(known.size > 0);
  });

  // Auth commands are handled by a no-op branch in libExec/libExecute; their
  // actions live under spacemolt_auth and match the command name.
  const AUTH_TOOL = 'spacemolt_auth';

  for (const [command, tool] of Object.entries(COMMAND_TOOL_MAP)) {
    if (KNOWN_SPECIAL.has(command)) {
      it(`"${command}" is a known special endpoint (not a library action) — skipped`, () => {
        assert.ok(true);
      });
      continue;
    }

    // Wrapper commands carry the real action in payload.action (battle/storage/facility/fleet).
    if (COMMANDS_WITH_PAYLOAD_ACTION.has(command)) {
      it(`"${command}" -> ${tool} is a real tool (action is payload-driven)`, () => {
        assert.ok(toolExists(tool), `tool "${tool}" for command "${command}" is not a real library tool`);
      });
      continue;
    }

    const action = COMMAND_ACTION_MAP[command] || command;
    const key = `${tool}/${action}`;

    if (tool === AUTH_TOOL) {
      it(`"${command}" -> ${key} is a real action`, () => {
        assert.ok(known.has(key), `(${key}) for "${command}" is not in the library ACTIONS catalog`);
      });
      continue;
    }

    it(`"${command}" -> ${key} is a real library action`, () => {
      assert.ok(known.has(key), `(${key}) for command "${command}" is not a real library (tool/action) pair`);
    });
  }
});
