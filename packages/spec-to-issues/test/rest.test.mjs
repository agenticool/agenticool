import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubError } from '@agenticool/github';
import { CREATE_GAP, restClient, RETRIES, WRITE_GAP } from '../src/index.mjs';

/**
 * A clock and a `gh` that answers each call with the next queued response.
 * @param {string[]} answers
 */
function fake(answers) {
  const clock = { time: 0, sleeps: /** @type {number[]} */ ([]) };
  /** @type {{ at: number, args: string[] }[]} */
  const calls = [];
  const client = restClient({
    run: (_command, args) => {
      calls.push({ at: clock.time, args });
      const answer = answers.shift() ?? 'HTTP/2.0 200 OK\r\n\r\n{"ok":true}';
      if (answer.startsWith('HTTP/2.0 2')) return answer;
      throw Object.assign(new Error('gh'), { status: 1, stdout: answer });
    },
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.time += ms;
    },
    now: () => clock.time,
  });
  return { clock, calls, client };
}

/**
 * @param {number} status
 * @param {string} message
 * @param {string} [headers]
 */
const failed = (status, message, headers = '') =>
  `HTTP/2.0 ${status} Error\r\n${headers}\r\n${JSON.stringify({ message })}`;
const SECONDARY = 'You have exceeded a secondary rate limit.';

test('creates are 3 seconds apart and other writes 1 second apart; reads wait for nothing', async () => {
  const { clock, calls, client } = fake([]);
  await client.write(['-X', 'POST', 'a'], { create: true });
  await client.write(['-X', 'POST', 'b'], { create: true });
  await client.write(['-X', 'POST', 'c']);
  await client.write(['-X', 'POST', 'd']);
  await client.write(['-X', 'POST', 'e'], { create: true });
  assert.deepEqual(client.read('f'), { ok: true });
  assert.deepEqual(client.pages('g'), [{ ok: true }]);
  assert.deepEqual(
    calls.map((call) => call.at),
    [
      0,
      CREATE_GAP,
      CREATE_GAP + WRITE_GAP,
      CREATE_GAP + 2 * WRITE_GAP,
      2 * CREATE_GAP,
      2 * CREATE_GAP,
      2 * CREATE_GAP,
    ],
  );
  assert.deepEqual(calls[0].args, ['api', '--include', '-X', 'POST', 'a']);
  assert.equal(clock.time, 2 * CREATE_GAP);
});

test('a secondary rate limit waits retry-after, or 60 seconds, doubling each time', async () => {
  const { clock, client } = fake([
    failed(403, SECONDARY, 'retry-after: 7\r\n'),
    failed(429, SECONDARY),
    failed(403, 'abuse detection mechanism'),
  ]);
  assert.deepEqual(await client.write(['-X', 'POST', 'a']), { ok: true });
  assert.deepEqual(clock.sleeps, [7000, 120_000, 240_000]);
});

test('a write fails after five secondary-limit retries or on any other error', async () => {
  const limited = fake(
    Array.from({ length: RETRIES + 1 }, () => failed(403, SECONDARY)),
  );
  await assert.rejects(limited.client.write(['-X', 'POST', 'a']), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.kind, 'rate-limit');
    return true;
  });
  assert.equal(limited.calls.length, RETRIES + 1);
  const other = fake([failed(403, 'Resource not accessible')]);
  await assert.rejects(other.client.write(['-X', 'POST', 'a']), /HTTP 403/);
  assert.equal(other.calls.length, 1);
  assert.throws(
    () => fake([failed(404, 'Not Found')]).client.read('x'),
    /HTTP 404/,
  );
});
