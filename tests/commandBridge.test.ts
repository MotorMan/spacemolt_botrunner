import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Account } from '@spacemolt/lib';
import { libExecute, type ApiResponse } from '../src/commandBridge.ts';

/**
 * Offline validation of the command-bridge dispatch contract.
 *
 * Uses Node's built-in test runner (no vitest / no network) so it works even
 * on the UNC share where vite's resolver breaks. `Account.send` is mocked so
 * NO live server is required. These tests lock in the exact `tool`/`action`/
 * `params` that `libExecute` produces for the tricky legacy commands (the
 * param renames the old `api.ts` did silently), so a future refactor of the
 * dispatch mapping cannot silently change behavior. `libExecute` is kept
 * byte-for-byte consistent with `bot.ts` `libExec` (the path used by every
 * `bot.exec` call site).
 */

interface SendCall {
  tool: string;
  action: string;
  payload?: Record<string, unknown>;
}

function makeSend(impl?: (tool: string, action: string, payload?: Record<string, unknown>) => unknown) {
  const calls: SendCall[] = [];
  const send = async (tool: string, action: string, payload?: Record<string, unknown>) => {
    calls.push({ tool, action, payload });
    return impl ? impl(tool, action, payload) : { delta: { details: { ok: true } } };
  };
  return { send: send as Account['send'], calls };
}

async function dispatch(
  account: Account,
  calls: SendCall[],
  command: string,
  payload?: Record<string, unknown>,
): Promise<ApiResponse> {
  const before = calls.length;
  const res = await libExecute(account, command, payload);
  assert.equal(calls.length, before + 1);
  return res;
}

describe('libExecute transport no-ops', () => {
  it('auth commands are no-ops and never call send', async () => {
    const { send, calls } = makeSend();
    const account = { send } as unknown as Account;
    const res = await libExecute(account, 'login', { username: 'x', password: 'y' });
    assert.equal(calls.length, 0);
    assert.deepEqual(res.result, { ok: true });
    assert.equal(res.error, undefined);
  });

  it('get_notifications is a no-op and never calls send', async () => {
    const { send, calls } = makeSend();
    const account = { send } as unknown as Account;
    const res = await libExecute(account, 'get_notifications', {});
    assert.equal(calls.length, 0);
    assert.deepEqual(res.result, { notifications: [] });
  });
});

describe('libExecute param translations', () => {
  let send: Account['send'];
  let calls: SendCall[];
  let account: Account;

  beforeEach(() => {
    const made = makeSend();
    send = made.send;
    calls = made.calls;
    account = { send } as unknown as Account;
  });

  it('find_route keeps target_system and drops target_poi', async () => {
    await dispatch(account, calls, 'find_route', { target_system: 'sol', target_poi: 'p' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'find_route', payload: { target_system: 'sol' } });
  });

  it('find_route maps target -> target_system', async () => {
    await dispatch(account, calls, 'find_route', { target: 'sol' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'find_route', payload: { target_system: 'sol' } });
  });

  it('jump rewrites target_system -> id', async () => {
    await dispatch(account, calls, 'jump', { target_system: 'sol' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'jump', payload: { id: 'sol' } });
  });

  it('jump rewrites target_poi -> id', async () => {
    await dispatch(account, calls, 'jump', { target_poi: 'sol_poi' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'jump', payload: { id: 'sol_poi' } });
  });

  it('travel rewrites target_poi -> id', async () => {
    await dispatch(account, calls, 'travel', { target_poi: 'sol_poi' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'travel', payload: { id: 'sol_poi' } });
  });

  it('set_home_base rewrites base_id -> id and uses salvage/set_home', async () => {
    await dispatch(account, calls, 'set_home_base', { base_id: 'base_1' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_salvage', action: 'set_home', payload: { id: 'base_1' } });
  });

  it('prepay_tax rewrites amount -> quantity', async () => {
    await dispatch(account, calls, 'prepay_tax', { amount: 5 });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'prepay_tax', payload: { quantity: 5 } });
  });

  it('faction_prepay_tax rewrites amount -> quantity and routes to faction tool / prepay_tax action', async () => {
    await dispatch(account, calls, 'faction_prepay_tax', { amount: 5 });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_faction', action: 'prepay_tax', payload: { quantity: 5 } });
  });

  it('send_gift maps to storage/withdraw with credits item_id, quantity, target', async () => {
    await dispatch(account, calls, 'send_gift', { credits: 10, recipient: 'bob' });
    assert.deepEqual(calls.at(-1), {
      tool: 'spacemolt_storage',
      action: 'withdraw',
      payload: { item_id: 'credits', quantity: 10, target: 'bob' },
    });
  });

  it('faction_deposit_credits maps to storage/deposit with credits + faction target', async () => {
    await dispatch(account, calls, 'faction_deposit_credits', { amount: 5 });
    assert.deepEqual(calls.at(-1), {
      tool: 'spacemolt_storage',
      action: 'deposit',
      payload: { item_id: 'credits', quantity: 5, target: 'faction' },
    });
  });

  it('faction_deposit_items adds faction target', async () => {
    await dispatch(account, calls, 'faction_deposit_items', { item_id: 'ore', quantity: 2 });
    assert.deepEqual(calls.at(-1), {
      tool: 'spacemolt_storage',
      action: 'deposit',
      payload: { item_id: 'ore', quantity: 2, target: 'faction' },
    });
  });

  it('view_faction_storage adds faction target', async () => {
    await dispatch(account, calls, 'view_faction_storage', {});
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_storage', action: 'view', payload: { target: 'faction' } });
  });

  it('faction_set_ally routes to spacemolt_faction/propose_ally (no set_ally action)', async () => {
    await dispatch(account, calls, 'faction_set_ally', { target: 'red' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_faction', action: 'propose_ally', payload: { target: 'red' } });
  });

  it('faction_delete_role routes to spacemolt_faction/delete_role (not admin)', async () => {
    await dispatch(account, calls, 'faction_delete_role', { role: 'officer' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_faction', action: 'delete_role', payload: { role: 'officer' } });
  });

  it('faction_cancel_mission routes to spacemolt_faction/cancel_mission (not admin)', async () => {
    await dispatch(account, calls, 'faction_cancel_mission', { mission_id: 'm1' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_faction', action: 'cancel_mission', payload: { mission_id: 'm1' } });
  });

  it('faction_delete_room routes to spacemolt_faction/delete_room (not admin)', async () => {
    await dispatch(account, calls, 'faction_delete_room', { room: 'r1' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_faction', action: 'delete_room', payload: { room: 'r1' } });
  });

  it('claim_insurance routes to spacemolt_salvage/policies', async () => {
    await dispatch(account, calls, 'claim_insurance', {});
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_salvage', action: 'policies', payload: {} });
  });

  it('storage extracts payload.action and removes it from params', async () => {
    await dispatch(account, calls, 'storage', { action: 'view', target: 'x' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_storage', action: 'view', payload: { target: 'x' } });
  });

  it('battle extracts payload.action and keeps remaining params', async () => {
    await dispatch(account, calls, 'battle', { action: 'stance', stance: 'flee' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_battle', action: 'stance', payload: { stance: 'flee' } });
  });

  it('battle engage has no extra params', async () => {
    await dispatch(account, calls, 'battle', { action: 'engage' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_battle', action: 'engage', payload: {} });
  });

  it('facility extracts payload.action', async () => {
    await dispatch(account, calls, 'facility', { action: 'faction_list' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_facility', action: 'faction_list', payload: {} });
  });

  it('chat passes channel through unchanged', async () => {
    await dispatch(account, calls, 'chat', { content: 'hi', channel: 'system' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_social', action: 'chat', payload: { content: 'hi', channel: 'system' } });
  });

  it('withdraw_credits maps to storage/withdraw with credits item_id + quantity (self)', async () => {
    await dispatch(account, calls, 'withdraw_credits', { amount: 12 });
    assert.deepEqual(calls.at(-1), {
      tool: 'spacemolt_storage',
      action: 'withdraw',
      payload: { item_id: 'credits', quantity: 12 },
    });
  });

  it('get_faction_tax_estimate routes to spacemolt_faction/tax_estimate', async () => {
    await dispatch(account, calls, 'get_faction_tax_estimate', { faction_id: 'f1' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_faction', action: 'tax_estimate', payload: { faction_id: 'f1' } });
  });

  it('get_tax_estimate routes to spacemolt/get_tax_estimate', async () => {
    await dispatch(account, calls, 'get_tax_estimate', {});
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'get_tax_estimate', payload: {} });
  });

  it('load_passenger/unload_passenger/list_passengers route to spacemolt tool', async () => {
    await dispatch(account, calls, 'list_passengers', {});
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'list_passengers', payload: {} });
    await dispatch(account, calls, 'load_passenger', { id: 'p1' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'load_passenger', payload: { id: 'p1' } });
    await dispatch(account, calls, 'unload_passenger', { id: 'p1', target: 'lounge' });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'unload_passenger', payload: { id: 'p1', target: 'lounge' } });
  });

  it('simple query command maps name -> spacemolt tool with no rewrites', async () => {
    await dispatch(account, calls, 'get_status', { foo: 1 });
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt', action: 'get_status', payload: { foo: 1 } });
  });

  it('catalog routes to spacemolt_catalog/catalog', async () => {
    await dispatch(account, calls, 'catalog', {});
    assert.deepEqual(calls.at(-1), { tool: 'spacemolt_catalog', action: 'catalog', payload: {} });
  });
});

describe('libExecute result normalization', () => {
  it('maps MutationResult delta.details -> result', async () => {
    const { send } = makeSend(() => ({ delta: { details: { foo: 1 } } }));
    const account = { send } as unknown as Account;
    const res = await libExecute(account, 'mine', {});
    assert.equal(res.error, undefined);
    assert.deepEqual(res.result, { foo: 1 });
  });

  it('maps QueryResult structuredContent -> result', async () => {
    const { send } = makeSend(() => ({ structuredContent: { bar: 2 } }));
    const account = { send } as unknown as Account;
    const res = await libExecute(account, 'get_status', {});
    assert.equal(res.error, undefined);
    assert.deepEqual(res.result, { bar: 2 });
  });

  it('maps a thrown error to result:undefined + error.code lib_error', async () => {
    const { send } = makeSend(() => { throw new Error('boom'); });
    const account = { send } as unknown as Account;
    const res = await libExecute(account, 'jump', { target_system: 'sol' });
    assert.equal(res.result, undefined);
    assert.deepEqual(res.error, { code: 'lib_error', message: 'boom' });
  });
});
