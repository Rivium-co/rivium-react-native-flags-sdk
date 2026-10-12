import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RiviumFlags } from '../src/rivium-flags';
import { MemoryFlagsStorage } from '../src/storage';
import type { RiviumFlagsConfig } from '../src/types';

const KEY = 'rv_test_key';

console.warn = () => {};

/** Counts evaluate requests. With `gated` every request waits for `release(i)`. */
class Server {
  bodies: any[] = [];
  gates: Array<() => void> = [];
  gated = false;
  failWith: number | null = null;

  get count() {
    return this.bodies.length;
  }

  context(i: number) {
    return this.bodies[i].context;
  }

  release(i: number) {
    this.gates[i]();
  }

  fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    this.bodies.push(body);
    if (this.gated) await new Promise<void>((r) => this.gates.push(r));
    if (this.failWith !== null) return new Response('{}', { status: this.failWith });
    const value = `for-${body.context.userId}`;
    return new Response(
      JSON.stringify({
        environment: null,
        evaluatedAt: '2026-10-01T12:00:00.000Z',
        flags: { a: { key: 'a', valueType: 'string', enabled: true, value, variant: null, reason: 'ON', version: 1 } },
      }),
      { status: 200, headers: { etag: `"e-${value}"`, 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

function create(server: Server, config: Partial<RiviumFlagsConfig> = {}) {
  return new RiviumFlags({
    apiKey: KEY,
    storage: new MemoryFlagsStorage(),
    fetch: server.fetch,
    observeAppState: false,
    ...config,
  });
}

async function make(server: Server, config: Partial<RiviumFlagsConfig> = {}) {
  const c = create(server, config);
  await c.init();
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(400);

function within<T>(p: Promise<T>, ms = 2000): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error('did not complete')), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

describe('unchanged context sends no request', () => {
  test('identify with the same user and attributes: one request in total', async () => {
    const server = new Server();
    const c = await make(server);
    await c.identify('u1', { plan: 'pro' });
    assert.equal(server.count, 2); // start + the new user

    let changes = 0;
    c.subscribe(() => changes++);
    const version = c.version;
    for (let i = 0; i < 5; i++) await c.identify('u1', { plan: 'pro' });
    await c.identify('u1'); // attributes kept
    await c.setUserId('u1');
    await c.setAttributes({ plan: 'pro' });
    await settle();

    assert.equal(server.count, 2);
    assert.equal(changes, 0);
    assert.equal(c.version, version);
    assert.equal(c.getString('a', ''), 'for-u1'); // callers still read current values
    assert.equal(c.userId, 'u1');
    c.close();
  });

  test('the same context as the one given in the config sends nothing', async () => {
    const server = new Server();
    const c = await make(server, { userId: 'u1', attributes: { plan: 'pro' } });
    await c.identify('u1', { plan: 'pro' });
    await settle();
    assert.equal(server.count, 1);
    c.close();
  });

  test('null and an empty user id are both "signed out"', async () => {
    const server = new Server();
    const c = await make(server);
    await c.identify(null);
    await c.setUserId('');
    await c.identify('', {});
    await settle();
    assert.equal(server.count, 1);
    c.close();
  });

  test('a changed user id sends a new request', async () => {
    const server = new Server();
    const c = await make(server);
    await c.identify('u1');
    await c.identify('u1');
    await c.identify('u2');
    assert.equal(server.count, 3);
    assert.equal(server.context(2).userId, 'u2');
    assert.equal(c.getString('a', ''), 'for-u2');
    c.close();
  });

  test('attributes: same content in another key order or as a new object is unchanged', async () => {
    const server = new Server();
    const c = await make(server);
    await c.setAttributes({ plan: 'pro', age: 31, tags: ['a', 'b'], beta: null });
    assert.equal(server.count, 2);

    await c.setAttributes({ beta: null, tags: ['a', 'b'], age: 31, plan: 'pro' });
    await c.identify(null, { age: 31, beta: null, plan: 'pro', tags: [...['a', 'b']] });
    // An undefined value is not sent, so it is the same as leaving the key out.
    await c.setAttributes({ plan: 'pro', age: 31, tags: ['a', 'b'], beta: null, extra: undefined } as any);
    await settle();
    assert.equal(server.count, 2);
    c.close();
  });

  test('attributes: a real difference sends a new request', async () => {
    const server = new Server();
    const c = await make(server);
    await c.setAttributes({ plan: 'pro', tags: ['a', 'b'], beta: null });
    assert.equal(server.count, 2);

    await c.setAttributes({ plan: 'pro', tags: ['b', 'a'], beta: null }); // order inside an array matters
    assert.equal(server.count, 3);

    await c.setAttributes({ plan: 'pro', tags: ['b', 'a'] }); // null is not the same as absent
    assert.equal(server.count, 4);

    await c.setAttributes({ plan: 'business', tags: ['b', 'a'] });
    assert.equal(server.count, 5);

    await c.setAttributes({});
    assert.equal(server.count, 6);
    await c.setAttributes({});
    await settle();
    assert.equal(server.count, 6);
    c.close();
  });

  test('a nested value changed in place is noticed', async () => {
    const server = new Server();
    const c = await make(server);
    const tags = ['a'];
    const attributes = { tags };
    await c.setAttributes(attributes);
    assert.equal(server.count, 2);
    tags.push('b');
    await c.setAttributes(attributes);
    assert.equal(server.count, 3);
    assert.deepEqual(server.context(2).attributes, { tags: ['a', 'b'] });
    c.close();
  });

  test('the same user after reset() sends a request', async () => {
    const server = new Server();
    const c = await make(server);
    await c.identify('u1', { plan: 'pro' });
    assert.equal(server.count, 2);
    await c.reset();
    assert.equal(server.count, 3);
    assert.equal('userId' in server.context(2), false);
    await c.identify('u1', { plan: 'pro' });
    assert.equal(server.count, 4);
    assert.equal(server.context(3).userId, 'u1');
    assert.equal(c.getString('a', ''), 'for-u1');
    c.close();
  });

  test('refresh() always sends a request', async () => {
    const server = new Server();
    const c = await make(server);
    await c.identify('u1');
    await c.identify('u1');
    assert.equal(server.count, 2);
    await c.refresh();
    await c.refresh();
    assert.equal(server.count, 4);
    c.close();
  });

  test('resume and polling are not affected', async () => {
    const server = new Server();
    const c = await make(server);
    await c.identify(null);
    c.onBackground();
    c.onForeground(); // fresh results: nothing to fetch
    await settle();
    assert.equal(server.count, 1);
    c.close();
  });
});

describe('unchanged context while a request is pending', () => {
  test('before the first answer: joins the request in flight', async () => {
    const server = new Server();
    server.gated = true;
    const c = await make(server, { userId: 'u1', initTimeoutMs: 0 });
    assert.equal(server.count, 1);
    assert.equal(c.isReady, false);

    let done = 0;
    const calls = [
      c.identify('u1').then(() => done++),
      c.setUserId('u1').then(() => done++),
      c.identify('u1', {}).then(() => done++),
    ];
    await settle();
    assert.equal(server.count, 1);
    assert.equal(done, 0); // still waiting for the one request

    server.release(0);
    await within(Promise.all(calls));
    assert.equal(done, 3);
    assert.equal(server.count, 1);
    assert.equal(c.getString('a', ''), 'for-u1');
    c.close();
  });

  test('while the request of a changed context is in flight: joins it', async () => {
    const server = new Server();
    const c = await make(server);
    server.gated = true;
    const first = c.identify('u1', { plan: 'pro' });
    await settle(); // debounce passed, request 2 is in flight
    assert.equal(server.count, 2);

    let joined = false;
    const again = c.identify('u1', { plan: 'pro' }).then(() => (joined = true));
    await settle();
    assert.equal(server.count, 2);
    assert.equal(joined, false);

    server.release(0);
    await within(Promise.all([first, again]));
    assert.equal(server.count, 2);
    assert.equal(c.getString('a', ''), 'for-u1');
    c.close();
  });

  test('inside the debounce window: one request, every call completes', async () => {
    const server = new Server();
    const c = await make(server);
    await within(
      Promise.all([
        c.identify('u1', { plan: 'pro' }),
        c.identify('u1', { plan: 'pro' }),
        c.setUserId('u1'),
        c.setAttributes({ plan: 'pro' }),
      ]),
    );
    assert.equal(server.count, 2);
    assert.equal(c.getString('a', ''), 'for-u1');
    c.close();
  });

  test('changed and changed back before the request: nothing is sent', async () => {
    const server = new Server();
    const c = await make(server);
    await c.setAttributes({ plan: 'pro' });
    assert.equal(server.count, 2);
    await within(Promise.all([c.setAttributes({ plan: 'business' }), c.setAttributes({ plan: 'pro' })]));
    await settle();
    assert.equal(server.count, 2);
    c.close();
  });
});

describe('identify around init()', () => {
  test('identify before init(): init sends the one request', async () => {
    const server = new Server();
    const c = create(server);
    const identified = c.identify('u1', { plan: 'pro' });
    await c.init();
    await within(identified);
    await settle();
    assert.equal(server.count, 1);
    assert.equal(server.context(0).userId, 'u1');
    assert.equal(c.getString('a', ''), 'for-u1');
    c.close();
  });

  test('identify right after init() without awaiting it: one request', async () => {
    const server = new Server();
    const c = create(server);
    const started = c.init();
    const identified = c.identify('u1', { plan: 'pro' });
    await within(Promise.all([started, identified]));
    await settle();
    assert.equal(server.count, 1);
    assert.equal(server.context(0).userId, 'u1');
    c.close();
  });

  test('init() called twice sends one request', async () => {
    const server = new Server();
    const c = create(server);
    await Promise.all([c.init(), c.init()]);
    await c.init();
    assert.equal(server.count, 1);
    c.close();
  });
});

describe('unchanged context without results', () => {
  test('after a failed request the call still tries again', async () => {
    const server = new Server();
    server.failWith = 503;
    const c = await make(server);
    assert.equal(server.count, 1);
    assert.equal(c.isReady, false);
    server.failWith = null;
    await c.identify(null);
    assert.equal(server.count, 2);
    assert.equal(c.isReady, true);
    c.close();
  });
});
