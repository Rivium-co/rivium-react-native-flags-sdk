<p align="center">
  <a href="https://rivium.co">
    <img src="https://rivium.co/logo.png" alt="Rivium" width="120" />
  </a>
</p>

<h3 align="center">Rivium Flags React Native SDK</h3>

<p align="center">
  Feature flag management for React Native with offline caching, targeting rules, and rollout control.
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
npm install @rivium/flags-react-native
```

### Peer Dependencies

```bash
npm install @react-native-async-storage/async-storage @react-native-community/netinfo
```

For iOS, install pods:

```bash
cd ios && pod install
```

## Quick Start

### With React Hook (Recommended)

```tsx
import { RiviumFlagsProvider, useRiviumFlags } from '@rivium/flags-react-native';

// Wrap your app
export default function App() {
  return (
    <RiviumFlagsProvider config={{ apiKey: 'YOUR_API_KEY', environment: 'production' }}>
      <MyScreen />
    </RiviumFlagsProvider>
  );
}

// Use in any component
function MyScreen() {
  const { isEnabled, getValue, isReady } = useRiviumFlags();

  if (!isReady) return <ActivityIndicator />;

  return (
    <View>
      {isEnabled('dark_mode') && <DarkModeToggle />}
      <Text>Checkout: {getValue('checkout_flow')}</Text>
    </View>
  );
}
```

### Standalone Client

```typescript
import { RiviumFlags } from '@rivium/flags-react-native';

const flags = new RiviumFlags({
  apiKey: 'YOUR_API_KEY',
  environment: 'production',
  enableOfflineCache: true,
});

await flags.init();
await flags.setUserId('user-123');
flags.setUserAttributes({ plan: 'pro', country: 'US' });

const darkMode = flags.isEnabled('dark_mode');
const result = flags.evaluate('checkout_flow');
console.log(result.enabled, result.value, result.variant);
```

## Features

- **React Hook & Provider** — `useRiviumFlags()` hook with `RiviumFlagsProvider` context
- **Boolean & Multivariate Flags** — Simple on/off toggles or multi-variant flags with weighted distribution
- **Targeting Rules** — Target users by attributes (equals, contains, regex, in, greater_than, and more)
- **Rollout Percentages** — Gradual rollouts with deterministic MD5-based bucketing
- **Offline Caching** — Flags cached with AsyncStorage for offline access
- **Environment Overrides** — Separate flag values per environment (development, staging, production)
- **Connectivity Aware** — Automatic online/offline detection with NetInfo
- **TypeScript** — Full type safety with exported types and declarations

## Documentation

For full documentation, visit [rivium.co/docs](https://rivium.co/docs).

## License

MIT License — see [LICENSE](LICENSE) for details.
