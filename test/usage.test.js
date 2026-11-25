import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { parseBalances, readDeepSeek } from '../balance.js';
import { claudePromptState, parseClaudeWeekly, parseCodexWeekly, readClaude, readCodex } from '../cli-usage.js';
import { apply, createUsageReader } from '../index.js';

const weekly = usedPercent => ({ usedPercent, windowDurationMins: 10080, resetsAt: 1795633200 });
const client = { version: '0.2.2-rc.5', locale: 'zh', timezoneOffsetSeconds: 28800 };
const alive = () => new AbortController().signal;

function promiseGate() {
  return Promise.withResolvers();
}

test('Codex uses the main Codex bucket and either exact weekly window', () => {
  const short = { usedPercent: 95, windowDurationMins: 300 };
  const expected = { status: 'ready', remainingPercent: 72, resetsAt: 1795633200000 };
  assert.deepEqual(parseCodexWeekly({
    rateLimitsByLimitId: { codex: { primary: short, secondary: weekly(28) }, codex_other: { primary: weekly(99) } },
  }), expected);
  assert.deepEqual(parseCodexWeekly({ rateLimits: { limitId: 'codex', primary: weekly(28) } }), expected);
});

test('Codex never substitutes a short window or a different bucket', () => {
  const other = { limitId: 'codex_other', primary: weekly(40) };
  assert.deepEqual(parseCodexWeekly({ rateLimitsByLimitId: { codex_other: other }, rateLimits: other }), { status: 'no-data' });
  assert.deepEqual(parseCodexWeekly({ rateLimits: other }), { status: 'no-data' });
  assert.deepEqual(parseCodexWeekly({ rateLimits: { limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 300 } } }), { status: 'no-data' });
  assert.equal(parseCodexWeekly({ rateLimits: { limitId: 'codex', primary: weekly(100) } }).remainingPercent, 0);
  assert.equal(parseCodexWeekly({ rateLimits: { limitId: 'codex', primary: weekly(null) } }).status, 'error');
});

test('Codex sends only initialize, initialized, and account rate-limit read and reaps the process', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const calls = [];
  let cleanup = 0;
  const subprocess = {
    async resolveExecutable(command) { return command; },
    spawn() {
      stdin.on('data', chunk => {
        const message = JSON.parse(chunk.toString());
        calls.push(message.method);
        if (message.id === 1) queueMicrotask(() => stdout.write('{"id":1,"result":{}}\n'));
        if (message.id === 2) queueMicrotask(() => {
          const line = JSON.stringify({ id: 2, result: { rateLimitsByLimitId: { codex: { primary: weekly(38) } } } });
          stdout.write(line.slice(0, 20));
          stdout.write(line.slice(20) + '\n');
        });
      });
      return {
        stdin, stdout, done: Promise.resolve(),
        terminate() { cleanup++; stdout.end(); },
        async waitForExit() { assert.equal(cleanup, 1); return true; },
      };
    },
  };
  assert.equal((await readCodex(subprocess, alive())).remainingPercent, 62);
  assert.deepEqual(calls, ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(cleanup, 1);
});

test('Claude uses only the all-model weekly block, allowing terminal spacing differences', () => {
  const all = 'Current session\n██ 93% used\nCurrent week (all models)\n██ 37%used\nResets Sun\nCurrent week (Sonnet)\n█ 61% used';
  assert.deepEqual(parseClaudeWeekly(all), { status: 'ready', remainingPercent: 63 });
  assert.equal(parseClaudeWeekly('Currentweek(allmodels) █ 100%used')?.remainingPercent, 0);
  assert.equal(parseClaudeWeekly('Current week (all models)\nLoading\nCurrent week (Sonnet)\n61% used'), null);
  assert.equal(parseClaudeWeekly('Current session\n 3% used\nCurrent week (Opus)\n 2% used'), null);
  assert.equal(parseClaudeWeekly('Current week (all models) N/A\nExtra usage 77% used'), null);
});

const prompt = `${'─'.repeat(42)}\n❯\x1b[2C\n${'─'.repeat(42)}`;

test('Claude will not send a key on a trust or setup prompt', async () => {
  const output = new PassThrough();
  let cleanup = 0;
  const subprocess = {
    async resolveExecutable(command) { return command; },
    async spawnTerminal() {
      queueMicrotask(() => output.write('Quick safety check\n❯ No, exit\nYes, I trust this folder'));
      return {
        output, done: Promise.resolve(),
        async write() { assert.fail('must not send input'); },
        async terminate() { cleanup++; output.end(); },
      };
    },
  };
  assert.equal(claudePromptState('❯'), 'waiting');
  assert.equal(claudePromptState('ANSI colors only\n❯'), 'setup');
  assert.deepEqual(await readClaude(subprocess, {}, alive()), { status: 'setup' });
  assert.equal(cleanup, 1);
});

test('Claude sends only /usage after detecting a real prompt; reports upstream failure', async () => {
  for (const [outputText, expected] of [
    ['Current week (all models)\n ■■ 46% used\n', { status: 'ready', remainingPercent: 54 }],
    ["✘Couldn't load usage data", { status: 'error' }],
  ]) {
    const output = new PassThrough();
    const sent = [];
    let cleanup = 0;
    const subprocess = {
      async resolveExecutable(command) { return command; },
      async spawnTerminal() {
        queueMicrotask(() => output.write(prompt));
        return {
          output, done: Promise.resolve(),
          async write(text) { sent.push(text); output.write(outputText); },
          async terminate() { cleanup++; output.end(); },
        };
      },
    };
    assert.deepEqual(await readClaude(subprocess, {}, alive()), expected);
    assert.deepEqual(sent, ['/usage\r']);
    assert.equal(cleanup, 1);
  }
});

test('DeepSeek adds same-currency bonus balances exactly without merging currencies', async () => {
  const account = {
    async getState() { return { status: 'credential-stored' }; },
    async getBalance(actual) {
      assert.equal(actual, client);
      return { status: 'ready', value: [{ currency: 'CNY', balance: '0.01' }, { currency: 'USD', balance: '0E-16' }],
        bonusWallets: [{ currency: 'CNY', balance: '2e-3' }] };
    },
  };
  const credentials = { async resolve() { assert.fail('must prefer the DSH account'); } };
  const response = await readDeepSeek(account, credentials, client, alive());
  assert.deepEqual(response, { status: 'ready', source: 'account', amounts: [
    { currency: 'CNY', amount: '0.012' }, { currency: 'USD', amount: '0.0000000000000000' },
  ] });
  assert.equal(parseBalances([{ currency: 'CNY', balance: 'NaN' }], 'balance'), null);
});

test('DeepSeek API-key fallback stays on the official Host origin and returns only amounts', async () => {
  const fixtureKey = 'test-only-credential';
  const response = await readDeepSeek(undefined, { resolve: async () => ({ value: fixtureKey }) }, client, alive(), async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${fixtureKey}`);
    return Response.json({ is_available: false, balance_infos: [
      { currency: 'USD', total_balance: '0.00', topped_up_balance: '0.00', ignored: fixtureKey },
    ] });
  });
  assert.deepEqual(response, { status: 'ready', source: 'api', amounts: [{ currency: 'USD', amount: '0.00' }] });
});

test('DeepSeek does not show zero or another account when DSH balance fetch fails', async () => {
  const account = { getState: async () => ({ status: 'credential-stored' }), getBalance: async () => ({ status: 'failed' }) };
  const credentials = { async resolve() { assert.fail('must not silently switch accounts'); } };
  assert.deepEqual(await readDeepSeek(account, credentials, client, alive()), { status: 'error' });
  account.getBalance = async () => ({ status: 'ready', value: [], bonusWallets: [] });
  assert.deepEqual(await readDeepSeek(account, credentials, client, alive()), { status: 'no-data' });
});

test('concurrent tabs share provider reads; one failing provider does not block another', async () => {
  const claude = promiseGate();
  let codexReads = 0;
  let now = 5_000;
  const usage = createUsageReader({
    claude: () => claude.promise,
    codex: () => ({ status: 'ready', remainingPercent: ++codexReads }),
  }, alive(), () => now);
  const pending = usage.read('claude', client);
  assert.equal(usage.read('claude', client), pending);
  assert.equal((await usage.read('codex', client)).remainingPercent, 1);
  claude.reject(new Error('sensitive upstream details'));
  assert.deepEqual(await pending, { status: 'error', checkedAt: 5_000 });
  assert.equal((await usage.read('codex', client)).remainingPercent, 1);
  now += 300_000;
  assert.equal((await usage.read('codex', client)).remainingPercent, 2);
  assert.equal(usage.read('__proto__', client), null);
});

test('invalidating credentials cannot publish a late response from the previous account', async () => {
  const previous = promiseGate();
  let reads = 0;
  const usage = createUsageReader({ deepseek: () => ++reads === 1 ? previous.promise : { status: 'sign-in' } }, alive());
  const old = usage.read('deepseek', client);
  usage.invalidate('deepseek');
  assert.equal((await usage.read('deepseek', client)).status, 'sign-in');
  previous.resolve({ status: 'ready', amounts: [{ currency: 'USD', amount: '100.00' }] });
  assert.equal((await old).status, 'error');
});

test('Host uses a fixed authenticated Connection route and releases its registrations', async () => {
  const registered = new Map();
  const listeners = new Map();
  let unmount;
  const balance = { getState: async () => ({ status: 'credential-stored' }),
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '3.25' }], bonusWallets: [] }) };
  apply({
    effect(load) { unmount = load(); },
    connection: { fetch: { register(route) { registered.set(route.path, route); return () => registered.delete(route.path); } } },
    get(name) { return name === 'deepseekAccount' ? balance : undefined; },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
  });
  const route = registered.get('/api/dsh-credit-usage');
  const query = new Request('http://localhost/api/dsh-credit-usage?provider=deepseek&locale=zh&tz=28800');
  const response = await route.fetch(query);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual((await response.json()).amounts, [{ currency: 'CNY', amount: '3.25' }]);
  assert.equal((await route.fetch(new Request('http://localhost/api/dsh-credit-usage?provider= arbitrary'))).status, 400);
  await unmount();
  assert.equal(registered.size, 0);
  assert.equal(listeners.size, 0);
});
