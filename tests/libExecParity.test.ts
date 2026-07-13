import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Account } from '@spacemolt/lib';
import { libExecute, buildLibDispatch } from '../src/commandBridge.ts';

/**
 * Offline dispatch-contract test (no live server, no `Bot` import).
 *
 * `bot.ts` `libExec` and `commandBridge.ts` `libExecute` share ONE pure
 * translation function, `buildLibDispatch`. `libExecute` must therefore call
 * `account.send` with exactly `buildLibDispatch`'s `{tool, action, body}` for
 * every legacy command — otherwise the runtime path (`bot.exec`) and the
 * CLI/drone path would silently diverge. `Account.send` is mocked so no
 * network is required. Run with `bun test tests/libExecParity.test.ts`.
 */

interface SendCall {
  tool: string;
  action: string;
  payload?: Record<string, unknown>;
}

function makeSend() {
  const calls: SendCall[] = [];
  const send = async (tool: string, action: string, payload?: Record<string, unknown>) => {
    calls.push({ tool, action, payload });
    return { delta: { details: { ok: true } } };
  };
  return { send: send as Account['send'], calls };
}

const CASES: Array<[string, Record<string, unknown> | undefined]> = [
  ['find_route', { target_system: 'sol', target_poi: 'p' }],
  ['find_route', { target: 'sol' }],
  ['jump', { target_system: 'sol' }],
  ['jump', { target_poi: 'sol_poi' }],
  ['travel', { target_poi: 'sol_poi' }],
  ['set_home_base', { base_id: 'base_1' }],
  ['prepay_tax', { amount: 5 }],
  ['faction_prepay_tax', { amount: 5 }],
  ['send_gift', { credits: 10, recipient: 'bob' }],
  ['faction_deposit_credits', { amount: 5 }],
  ['faction_deposit_items', { item_id: 'ore', quantity: 2 }],
  ['view_faction_storage', {}],
  ['storage', { action: 'view', target: 'x' }],
  ['battle', { action: 'stance', stance: 'flee' }],
  ['battle', { action: 'engage' }],
  ['facility', { action: 'faction_list' }],
  ['chat', { content: 'hi', channel: 'system' }],
  ['get_status', { foo: 1 }],
  ['catalog', {}],
];

describe('libExecute dispatches exactly as buildLibDispatch (shared by bot.exec)', () => {
  let send: Account['send'];
  let calls: SendCall[];
  let account: Account;

  beforeEach(() => {
    const made = makeSend();
    send = made.send;
    calls = made.calls;
    account = { send } as unknown as Account;
  });

  for (const [command, payload] of CASES) {
    it(`dispatches ${command} via the shared translation`, async () => {
      await libExecute(account, command, payload);
      const expected = buildLibDispatch(command, payload);
      assert.equal(calls.length, 1, `expected exactly one send for ${command}`);
      assert.deepEqual(
        calls[0],
        { tool: expected.tool, action: expected.action, payload: expected.body },
        `dispatch mismatch for ${command}`,
      );
    });
  }
});
