<p align="center">
  <a href="https://rivium.co">
    <img src="https://rivium.co/logo.png" alt="Rivium" width="120" />
  </a>
</p>

<h3 align="center">Rivium Flags React Native SDK</h3>

<p align="center">
  Feature flags for React Native. Flags are evaluated on the Rivium server; the app keeps only the results.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rivium/flags-react-native"><img src="https://img.shields.io/npm/v/@rivium/flags-react-native.svg" alt="npm" /></a>
  <img src="https://img.shields.io/badge/React_Native-0.70+-61DAFB?logo=react&logoColor=black" alt="React Native 0.70+" />
  <img src="https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5+" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" />
</p>

---

## Installation

```bash
npm install @rivium/flags-react-native @react-native-async-storage/async-storage
cd ios && pod install
```

`@react-native-async-storage/async-storage` (peer dependency) stores the anonymous id and the last results. Without
it the SDK still works but keeps them in memory only (a warning is logged). `@react-native-community/netinfo` is no
longer needed.

## Quick start

```tsx
import { RiviumFlagsProvider, useRiviumFlags, useStringFlag } from '@rivium/flags-react-native';

export default function App() {
  return (
    <RiviumFlagsProvider config={{ apiKey: 'rv_live_xxx', environment: 'production' }}>
      <Checkout />
    </RiviumFlagsProvider>
  );
}

function Checkout() {
  const { isEnabled, getNumber, isReady } = useRiviumFlags(); // re-renders when results change
  const theme = useStringFlag('theme', 'light');

  return isEnabled('new-checkout') ? <NewCheckout theme={theme} max={getNumber('max-items', 10)} /> : <OldCheckout />;
}
```

Without React:

```ts
import { RiviumFlags } from '@rivium/flags-react-native';

const flags = new RiviumFlags({ apiKey: 'rv_live_xxx', environment: 'production' });
await flags.init(); // cached results right away; waits up to 5 s for the network

flags.isEnabled('new-checkout');
flags.getBoolean('dark-mode', false);
flags.getString('theme', 'light');
flags.getNumber('max-items', 10);
flags.getJson('home-layout', { columns: 2 });
```

Getters are synchronous and never throw: when a flag is unknown, results are not ready yet, or the type does not
match, they return the default you passed.

## Identify users

```ts
// After sign-in (debounced 250 ms; results of the previous user are dropped):
await flags.identify('user-123', { plan: 'pro', country: 'AM', beta: true });

await flags.setAttributes({ plan: 'business' }); // replaces all attributes
await flags.setUserId(null);                     // signed out

// Sign-out: clears user id, attributes and cached results; keeps the anonymous id.
await flags.reset();
```

Every install gets a random anonymous id (UUID v4, AsyncStorage key `rivium_flags_anonymous_id`). It is sent with
every request, so percentage rollouts work for signed-out users too. It survives `reset()`; `resetAnonymousId()`
replaces it. Attributes are strings, numbers, booleans, null, or arrays of those (no nested objects, at most 100).

## Reasons and details

```ts
const d = flags.getStringDetail('theme', 'light'); // { value, enabled, variant, reason, version }
```

| Reason | Meaning |
|---|---|
| `ON` / `VARIANT` | flag on (no variants / a variant was served) |
| `DISABLED`, `NOT_TARGETED`, `OUTSIDE_ROLLOUT`, `PREREQUISITE_FAILED`, `NO_BUCKETING_ID`, `ERROR` | flag off for this user; the flag's off value is served |
| `FLAG_NOT_FOUND` | no such flag; your default is returned |
| `NOT_READY` | no cached or fetched results yet; your default is returned |
| `TYPE_MISMATCH` | e.g. `getString` on a boolean flag; your default is returned |

`isEnabled(key)` is `true` only for `ON` and `VARIANT`. `getDetail(key, default)` returns the stored value without a
type check; `getAll()` returns every result.

Hooks: `useRiviumFlags()`, `useFlagEnabled(key, default)`, `useBooleanFlag`, `useStringFlag`, `useNumberFlag`,
`useJsonFlag`, `useFlagDetail`. `RiviumFlagsProvider` takes `config` (it creates, initialises and closes the client)
or a `client` you created yourself.

## Updates

```ts
const unsubscribe = flags.subscribe(() => console.log('new results'));
flags.onError((e) => console.log(e.statusCode, e.code, e.message));
await flags.refresh(); // fetch now
```

Results are fetched on `init()`, on `identify` / `setUserId` / `setAttributes`, when the app returns to the
foreground and the last fetch is older than 15 minutes, and on `refresh()`. Optional polling while in the foreground:
`refreshIntervalSeconds: 300` (default 0 = off, minimum 60). **Each fetch is a billed evaluation request**, which is
why polling is off by default.

Offline or on errors the last good results keep being served. 429 and 5xx are retried with back-off
(`Retry-After`, then ×2 up to 5 minutes). 401 / 403 / 404 (bad key, Flags not enabled, unknown environment) stop
automatic fetches until `refresh()` or the next start. `close()` stops everything.

## Client vs server SDKs

This is a **client** SDK: it uses the public key and calls `POST /public/v2/evaluate`; targeting rules never reach the
device. Never put the server secret (`rv_srv_…`) in an app — the constructor refuses it. For local evaluation on a
backend, use the Node.js or Next.js server SDK.

## Migrating from 0.1.x

0.2.0 is a new API (the 0.1.x route no longer serves client keys):

| 0.1.x | 0.2.0 |
|---|---|
| `getValue('k', x)` | `getBoolean` / `getString` / `getNumber` / `getJson('k', x)` |
| `evaluate('k')` | `getDetail('k', default)` (adds `reason`, `version`) |
| `setUserId(id)` + `setUserAttributes(map)` (merged) | `identify(id, attributes)`, `setUserId`, `setAttributes` (replaces) |
| `getAll()` (flag configs with rules) | `getAll()` (results only) |
| `init(callback)` | `init()`, plus `subscribe()` / `onError()` |
| `enableOfflineCache`, `dispose()` | always cached; `close()` |
| `@react-native-community/netinfo` peer | not needed |

Users are bucketed by a new hash in 0.2.0, so percentage rollouts reshuffle once.

## Testing

Pass `storage: new MemoryFlagsStorage()`, your own `fetch` and `observeAppState: false` in the config.

## Documentation

- [Rivium docs](https://rivium.co/docs)
- [Rivium Console](https://console.rivium.co)

## License

MIT License — see [LICENSE](LICENSE) for details.
