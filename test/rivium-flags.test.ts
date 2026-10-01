import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RiviumFlags, SDK_VERSION } from '../src/rivium-flags';
import { MemoryFlagsStorage, generateUuidV4, isUuidV4 } from '../src/storage';
import type { RiviumFlagsConfig } from '../src/types';

const KEY = 'rv_test_key';

// Silence the SDK's error logs during tests.
console.warn = () => {};

type Handler = (body: any, headers: Record<string, string>) => Response | Promise<Response>;

class FakeServer {
  requests: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  constructor(public handler: Handler) {}
  fetch = (async (url: any, init: any) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const body = JSON.parse(init.body);
    this.requests.push({ url: String(url), method: init.method, headers, body });
    return this.handler(body, headers);
  }) as unknown as typeof fetch;
}

function ok(flags: Record<string, unknown>, etag = '"e2-abc"', environment: string | null = null): Response {
  return new Response(JSON.stringify({ environment, evaluatedAt: '2026-10-01T12:00:00.000Z', flags }), {
    status: 200,
    headers: { etag, 'content-type': 'application/json' },
  });
}

function flag(key: string, valueType: string, value: unknown, extra: Record<string, unknown> = {}) {
  return { key, valueType, enabled: true, value, variant: null, reason: 'ON', version: 1, ...extra };
}

async function make(server: FakeServer, config: Partial<RiviumFlagsConfig> = {}, storage = new MemoryFlagsStorage()) {
  const c = new RiviumFlags({ apiKey: KEY, storage, fetch: server.fetch, observeAppState: false, ...config });
  await c.init();
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const vectors = JSON.parse(readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'sdk-test-vectors.json'), 'utf8'));

describe('contract test vectors (client side: request, parsing, getters)', () => {
  let total = 0;
  for (const suite of vectors.suites) {
    const defs: Record<string, any> = Object.fromEntries(suite.flags.map((f: any) => [f.key, f]));
    for (const c of suite.cases) {
      total++;
      test(`${suite.name}: ${c.name}`, async () => {
        const def = defs[c.flagKey];
        const valueType = def?.valueType ?? 'boolean';
        const exp = c.expected;
        const server = new FakeServer(() =>
          ok(def ? { [c.flagKey]: { key: c.flagKey, valueType, ...exp, version: def.version } } : {}),
        );
        const attrs = c.context.attributes ?? {};
        const client = await make(server, {
          environment: 'production',
          flagKeys: [c.flagKey],
          userId: c.context.userId,
          attributes: attrs,
        });

        // Request shape.
        assert.equal(server.requests.length, 1);
        const req = server.requests[0];
        assert.equal(req.method, 'POST');
        assert.equal(req.url, 'https://flags.rivium.co/public/v2/evaluate');
        assert.equal(req.headers['x-api-key'], KEY);
        assert.equal(req.headers['x-rivium-sdk'], `react-native/${SDK_VERSION}`);
        assert.equal(req.headers['x-server-secret'], undefined);
        assert.equal(req.body.environment, 'production');
        assert.deepEqual(req.body.flagKeys, [c.flagKey]);
        // An empty userId is "signed out": omitted (the server requires 1–256 chars).
        if (typeof c.context.userId === 'string' && c.context.userId.length > 0) {
          assert.equal(req.body.context.userId, c.context.userId);
        } else {
          assert.equal('userId' in req.body.context, false);
        }
        assert.ok(isUuidV4(req.body.context.anonymousId));
        assert.deepEqual(req.body.context.attributes, attrs);

        // Parsing + getters.
        const d = client.getDetail(c.flagKey, '__default__');
        if (!def) {
          assert.deepEqual([d.reason, d.value, d.enabled], ['FLAG_NOT_FOUND', '__default__', false]);
        } else {
          assert.equal(d.enabled, exp.enabled);
          assert.deepEqual(d.value, exp.value);
          assert.equal(d.variant, exp.variant);
          assert.equal(d.reason, exp.reason);
          assert.equal(client.isEnabled(c.flagKey, !exp.enabled), exp.enabled);
          switch (valueType) {
            case 'boolean': {
              assert.equal(client.getBoolean(c.flagKey, !exp.value), exp.value);
              const m = client.getStringDetail(c.flagKey, 'dflt');
              assert.deepEqual([m.value, m.reason], ['dflt', 'TYPE_MISMATCH']);
              break;
            }
            case 'string': {
              assert.equal(client.getString(c.flagKey, '__x__'), exp.value);
              const m = client.getBooleanDetail(c.flagKey, true);
              assert.deepEqual([m.value, m.reason], [true, 'TYPE_MISMATCH']);
              break;
            }
            case 'number': {
              assert.equal(client.getNumber(c.flagKey, -12345), exp.value);
              assert.equal(client.getJsonDetail(c.flagKey, null).reason, 'TYPE_MISMATCH');
              break;
            }
            case 'json': {
              assert.deepEqual(client.getJson(c.flagKey, '__x__'), exp.value);
              const m = client.getNumberDetail(c.flagKey, 7);
              assert.deepEqual([m.value, m.reason], [7, 'TYPE_MISMATCH']);
              break;
            }
          }
        }
        client.close();
      });
    }
  }
  test('vector count', () => assert.equal(total, 171));
});

describe('anonymous id', () => {
  test('generated once as UUID v4 under its fixed key', async () => {
    const storage = new MemoryFlagsStorage();
    const server = new FakeServer(() => ok({}));
    const a = await make(server, {}, storage);
    assert.ok(isUuidV4(a.anonymousId));
    assert.equal(storage.values.get('rivium_flags_anonymous_id'), a.anonymousId);
    a.close();
    const b = await make(server, {}, storage);
    assert.equal(b.anonymousId, a.anonymousId);
    b.close();
  });

  test('sent with a userId too; reset() keeps it; resetAnonymousId() replaces it', async () => {
    const server = new FakeServer(() => ok({}));
    const c = await make(server);
    const first = c.anonymousId;
    await c.identify('u1');
    assert.equal(server.requests[1].body.context.anonymousId, first);
    assert.equal(server.requests[1].body.context.userId, 'u1');
    await c.reset();
    assert.equal(c.anonymousId, first);
    assert.equal(c.userId, null);
    await c.resetAnonymousId();
    assert.notEqual(c.anonymousId, first);
    assert.ok(isUuidV4(c.anonymousId));
    c.close();
  });

  test('UUID generator', () => {
    const ids = new Set(Array.from({ length: 200 }, generateUuidV4));
    assert.equal(ids.size, 200);
    assert.ok([...ids].every(isUuidV4));
  });

  test('0.1.x storage keys are removed', async () => {
    const storage = new MemoryFlagsStorage();
    storage.values.set('rivium_ff_cached_flags', '[]');
    storage.values.set('rivium_ff_user_id', 'x');
    const c = await make(new FakeServer(() => ok({})), {}, storage);
    assert.equal(storage.values.has('rivium_ff_cached_flags'), false);
    assert.equal(storage.values.has('rivium_ff_user_id'), false);
    c.close();
  });
});

describe('readiness and reasons', () => {
  test('NOT_READY before any result, FLAG_NOT_FOUND after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = new FakeServer(async () => {
      await gate;
      return ok({ a: flag('a', 'boolean', true) });
    });
    const c = await make(server, { initTimeoutMs: 10 });
    assert.equal(c.isReady, false);
    assert.equal(c.getBooleanDetail('a', false).reason, 'NOT_READY');
    assert.equal(c.isEnabled('a', true), true);
    release();
    await c.whenReady();
    assert.equal(c.getBoolean('a', false), true);
    assert.deepEqual([c.getDetail('zzz', 1).reason, c.getDetail('zzz', 1).value], ['FLAG_NOT_FOUND', 1]);
    c.close();
  });

  test('rejects a server secret', () => {
    assert.throws(() => new RiviumFlags({ apiKey: 'rv_srv_x', storage: new MemoryFlagsStorage() }));
  });
});

describe('cache and ETag', () => {
  test('cache served at start; If-None-Match only for the same request; 304 keeps results', async () => {
    const storage = new MemoryFlagsStorage();
    let answer304 = false;
    const server = new FakeServer(() =>
      answer304
        ? new Response(null, { status: 304, headers: { etag: '"e2-abc"' } })
        : ok({ theme: flag('theme', 'string', 'dark', { variant: 'dark', reason: 'VARIANT' }) }),
    );
    const a = await make(server, {}, storage);
    assert.equal(server.requests[0].headers['if-none-match'], undefined);
    a.close();

    answer304 = true;
    const b = await make(server, {}, storage);
    assert.equal(server.requests[1].headers['if-none-match'], '"e2-abc"');
    assert.equal(b.getString('theme', 'light'), 'dark');

    answer304 = false;
    await b.setAttributes({ plan: 'pro' });
    assert.equal(server.requests[2].headers['if-none-match'], undefined);
    b.close();
  });

  test('offline: keeps serving the cache, never clears it', async () => {
    const storage = new MemoryFlagsStorage();
    let offline = false;
    const server = new FakeServer(() => {
      if (offline) throw new TypeError('Network request failed');
      return ok({ a: flag('a', 'boolean', true) });
    });
    const a = await make(server, {}, storage);
    a.close();
    offline = true;
    const b = await make(server, {}, storage);
    assert.equal(b.getBoolean('a', false), true);
    assert.equal(b.lastError?.statusCode, null);
    assert.ok(b.lastRetryDelayMs !== null);
    assert.ok(storage.values.has('rivium_flags_cache_v2'));
    b.close();
  });

  test('a changed userId drops the previous user results', async () => {
    const storage = new MemoryFlagsStorage();
    const server = new FakeServer((body) => ok({ a: flag('a', 'string', `for-${body.context.userId}`) }));
    const c = await make(server, { userId: 'u1' }, storage);
    assert.equal(c.getString('a', ''), 'for-u1');
    const p = c.identify('u2');
    assert.equal(c.isReady, false);
    await p;
    assert.equal(c.getString('a', ''), 'for-u2');
    c.close();

    const never = new FakeServer(() => new Promise<Response>(() => {}));
    const d = await make(never, { userId: 'u3', initTimeoutMs: 0 }, storage);
    assert.equal(d.isReady, false);
    d.close();
  });

  test('identify / setUserId / setAttributes are debounced into one request', async () => {
    const server = new FakeServer(() => ok({}));
    const c = await make(server);
    await Promise.all([
      c.setUserId('u1'),
      c.setAttributes({ plan: 'pro' }),
      c.identify('u1', { plan: 'business', age: 31 }),
    ]);
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests[1].body.context, {
      userId: 'u1',
      anonymousId: c.anonymousId,
      attributes: { plan: 'business', age: 31 },
    });
    c.close();
  });

  test('a newer context supersedes an older in-flight request', async () => {
    const releases: Array<() => void> = [];
    const server = new FakeServer(async (body, _h) => {
      await new Promise<void>((r) => releases.push(r));
      return ok({ a: flag('a', 'string', `for-${body.context.userId}`) });
    });
    const c = await make(server, { userId: 'old', initTimeoutMs: 0 });
    const p = c.identify('new');
    await sleep(300);
    assert.equal(releases.length, 2);
    releases[1]();
    await p;
    releases[0]();
    await sleep(20);
    assert.equal(c.getString('a', ''), 'for-new');
    c.close();
  });

  test('subscribe() fires on new results', async () => {
    const server = new FakeServer(() => ok({ a: flag('a', 'boolean', true) }));
    const c = new RiviumFlags({ apiKey: KEY, storage: new MemoryFlagsStorage(), fetch: server.fetch, observeAppState: false });
    let calls = 0;
    c.subscribe(() => calls++);
    await c.init();
    assert.ok(calls >= 1);
    assert.ok(c.version >= 1);
    c.close();
  });
});

describe('errors', () => {
  const withStatus = (status: number, body = '{}', headers: Record<string, string> = {}) =>
    make(new FakeServer(() => new Response(body, { status, headers })));

  test('401 halts automatic fetches until refresh()', async () => {
    const c = await withStatus(401, '{"statusCode":401,"error":"Unauthorized","message":"Invalid API key"}');
    assert.equal(c.isHalted, true);
    assert.equal(c.lastError?.statusCode, 401);
    assert.ok(!JSON.stringify(c.lastError).includes(KEY));
    assert.equal(c.lastRetryDelayMs, null);
    c.close();
  });

  test('403 and 404 are not retried automatically', async () => {
    for (const s of [403, 404]) {
      const c = await withStatus(s, `{"statusCode":${s},"code":"environment_not_found","message":"x"}`);
      assert.equal(c.isHalted, true);
      assert.equal(c.lastError?.code, 'environment_not_found');
      assert.equal(c.lastRetryDelayMs, null);
      c.close();
    }
  });

  test('429 waits Retry-After, then backs off (±20 %)', async () => {
    const c = await withStatus(429, '{}', { 'retry-after': '7' });
    assert.ok(c.lastRetryDelayMs! >= 7000 && c.lastRetryDelayMs! <= 8400, String(c.lastRetryDelayMs));
    c.close();
    const d = await withStatus(429);
    assert.ok(d.lastRetryDelayMs! >= 5000 && d.lastRetryDelayMs! <= 6000, String(d.lastRetryDelayMs));
    d.close();
  });

  test('5xx retries with back-off', async () => {
    const c = await withStatus(503);
    assert.ok(c.lastRetryDelayMs! >= 4000 && c.lastRetryDelayMs! <= 6000);
    c.close();
  });

  test('400 is not re-sent with the same body (refresh() clears the guard)', async () => {
    const server = new FakeServer(
      () => new Response('{"statusCode":400,"code":"invalid_request","message":"bad"}', { status: 400 }),
    );
    const c = await make(server);
    await c.refresh();
    assert.equal(server.requests.length, 2);
    c.close();
  });
});

describe('polling and foreground', () => {
  test('polling is off by default; resume fetches only when stale', async () => {
    const server = new FakeServer(() => ok({}));
    const c = await make(server);
    assert.equal(c.config.refreshIntervalSeconds ?? 0, 0);
    c.onBackground();
    c.onForeground();
    await sleep(10);
    assert.equal(server.requests.length, 1);
    c.close();
  });
});
