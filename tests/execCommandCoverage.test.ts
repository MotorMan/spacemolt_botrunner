import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_TOOL_MAP } from '../src/commandBridge.ts';

/**
 * Offline static-coverage test (no live server, no `Bot` import).
 *
 * `bot.ts` `libExec` / `commandBridge.ts` `libExecute` route a legacy command
 * through `COMMAND_TOOL_MAP`; any command NOT in that map silently defaults to
 * the `spacemolt` tool, which would misroute the call server-side. With ~900
 * `bot.exec` call sites across the routines, a single typo or missing entry is a
 * silent runtime bug that cannot be caught without a live server. This test
 * walks `src`, extracts every literal `bot.exec("command")` / `exec('command')`
 * string, and asserts each is a known map key. Run with `bun test`.
 *
 * Dynamic commands (variables / template literals) are intentionally skipped —
 * they must be reviewed by hand.
 */

const SRC = join(import.meta.dir, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'tests') continue;
      out.push(...walk(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Literal string commands passed to any `.exec(` call.
const CMD_RE = /\.exec\(\s*(['"])([a-zA-Z0-9_]+)\1/g;

// Commands that are intentionally NOT in COMMAND_TOOL_MAP because they are
// resolved by a special-case branch before the map lookup (get_notifications is
// a no-op in libExec/libExecute), or are doc-comment / JSON-schema placeholders
// rather than real call sites (the literal "command" token).
const SKIP = new Set(['get_notifications', 'command']);

const files = walk(SRC);
const used = new Map<string, Set<string>>();
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  let m: RegExpExecArray | null;
  CMD_RE.lastIndex = 0;
  while ((m = CMD_RE.exec(text)) !== null) {
    const cmd = m[2];
    if (SKIP.has(cmd)) continue;
    if (!used.has(cmd)) used.set(cmd, new Set());
    used.get(cmd)!.add(f);
  }
}

describe('every literal bot.exec command is covered by COMMAND_TOOL_MAP', () => {
  const commands = [...used.keys()].sort();
  it(`found ${commands.length} distinct literal commands across ${files.length} source files`, () => {
    assert.ok(commands.length > 0);
  });

  for (const cmd of commands) {
    it(`"${cmd}" is mapped (used in ${used.get(cmd)!.size} file(s))`, () => {
      assert.ok(
        COMMAND_TOOL_MAP[cmd],
        `command "${cmd}" is missing from COMMAND_TOOL_MAP — libExec would silently default it to the spacemolt tool and misroute the call`,
      );
    });
  }
});
