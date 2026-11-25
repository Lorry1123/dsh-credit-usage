import { readDeepSeek } from './balance.js';
import { readClaude, readCodex } from './cli-usage.js';

export const inject = ['connection'];
const ROUTE = '/api/dsh-credit-usage';
const CACHE_MS = 4 * 60_000;
const RETRY_MS = 60_000;

export function createUsageReader(providers, signal, now = Date.now) {
  const cache = new Map();
  const pending = new Set();
  function read(provider, client) {
    const readProvider = Object.hasOwn(providers, provider) ? providers[provider] : undefined;
    if (!readProvider || signal.aborted) return null;
    const previous = cache.get(provider);
    if (previous?.inFlight) return previous.inFlight;
    if (previous?.expiresAt > now()) return Promise.resolve(previous.result);
    const entry = {};
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(provider === 'deepseek' ? 32_000 : 23_000)]);
    const inFlight = Promise.resolve().then(() => readProvider(client, deadline)).catch(() => ({ status: 'error' }))
      .then(result => {
        const checkedAt = now();
        const current = cache.get(provider) === entry;
        entry.result = { ...(deadline.aborted || !current ? { status: 'error' } : result), checkedAt };
        entry.inFlight = undefined;
        entry.expiresAt = checkedAt + (entry.result.status === 'ready' ? CACHE_MS : RETRY_MS);
        return entry.result;
      }).finally(() => pending.delete(inFlight));
    entry.inFlight = inFlight;
    pending.add(inFlight);
    cache.set(provider, entry);
    return inFlight;
  }
  return { read, invalidate: provider => cache.delete(provider), settle: () => Promise.allSettled(pending) };
}

export function apply(ctx, config = {}) {
  ctx.effect(() => {
    const lifetime = new AbortController();
    const usage = createUsageReader({
      codex: (_, signal) => readCodex(ctx.get('subprocess'), signal),
      claude: (_, signal) => readClaude(ctx.get('subprocess'), config, signal),
      deepseek: (client, signal) => readDeepSeek(ctx.get('deepseekAccount'), ctx.get('credentials'), client, signal),
    }, lifetime.signal);
    const headers = { 'Cache-Control': 'private, no-store' };
    const unregister = ctx.connection.fetch.register({
      path: ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const query = new URL(request.url).searchParams;
        const provider = query.get('provider');
        const offset = Number(query.get('tz'));
        const client = {
          version: '0.2.2-rc.5',
          locale: query.get('locale') === 'zh' ? 'zh' : 'en',
          timezoneOffsetSeconds: Number.isInteger(offset) && offset >= -43_200 && offset <= 50_400 ? offset : 0,
        };
        const result = usage.read(provider, client);
        if (!result) return Response.json({ status: 'no-data' }, { status: 400, headers });
        return Response.json(await result, { headers });
      },
    });
    const invalidateRef = ctx.on('credentials/reference-updated', ref => {
      if (ref === 'DEEPSEEK_API_KEY') usage.invalidate('deepseek');
    });
    const invalidateAccount = ctx.on('credentials/record-updated', key => {
      if (key === 'deepseek-account-platform/default') usage.invalidate('deepseek');
    });
    return async () => {
      lifetime.abort();
      invalidateRef();
      invalidateAccount();
      await unregister();
      await usage.settle();
    };
  }, 'Credit usage: authenticated balance route');
}
