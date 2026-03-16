import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { RiviumFlags } from './rivium-flags';
import { RiviumFlagsConfig, FeatureFlag, FlagEvalResult } from './types';

interface RiviumFlagsContextValue {
  isEnabled: (flagKey: string, defaultValue?: boolean) => boolean;
  getValue: (flagKey: string, defaultValue?: any) => any;
  evaluate: (flagKey: string) => FlagEvalResult;
  getAll: () => FeatureFlag[];
  setUserId: (userId: string) => Promise<void>;
  getUserId: () => string | undefined;
  setUserAttributes: (attributes: Record<string, any>) => void;
  refresh: () => Promise<void>;
  isLoading: boolean;
  isReady: boolean;
}

const RiviumFlagsContext = createContext<RiviumFlagsContextValue | null>(null);

interface RiviumFlagsProviderProps {
  config: RiviumFlagsConfig;
  children: React.ReactNode;
}

/**
 * RiviumFlagsProvider - Wraps your React Native app with feature flag context
 *
 * @example
 * ```tsx
 * import { RiviumFlagsProvider } from '@rivium/flags-react-native';
 *
 * export default function App() {
 *   return (
 *     <RiviumFlagsProvider config={{ apiKey: 'rv_live_xxx' }}>
 *       <MainApp />
 *     </RiviumFlagsProvider>
 *   );
 * }
 * ```
 */
export function RiviumFlagsProvider({ config, children }: RiviumFlagsProviderProps) {
  const [client] = useState(() => new RiviumFlags(config));
  const [isLoading, setIsLoading] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [, setVersion] = useState(0);

  useEffect(() => {
    client.init().then(() => {
      setIsLoading(false);
      setIsReady(true);
    });
  }, [client]);

  const isEnabled = useCallback(
    (flagKey: string, defaultValue = false) => client.isEnabled(flagKey, defaultValue),
    [client, isReady],
  );

  const getValue = useCallback(
    (flagKey: string, defaultValue?: any) => client.getValue(flagKey, defaultValue),
    [client, isReady],
  );

  const evaluate = useCallback(
    (flagKey: string) => client.evaluate(flagKey),
    [client, isReady],
  );

  const getAll = useCallback(() => client.getAll(), [client, isReady]);

  const setUserId = useCallback(
    (userId: string) => client.setUserId(userId),
    [client],
  );

  const getUserId = useCallback(() => client.getUserId(), [client]);

  const setUserAttributes = useCallback(
    (attributes: Record<string, any>) => client.setUserAttributes(attributes),
    [client],
  );

  const refresh = useCallback(async () => {
    await client.refresh();
    setVersion((v) => v + 1);
  }, [client]);

  return (
    <RiviumFlagsContext.Provider
      value={{ isEnabled, getValue, evaluate, getAll, setUserId, getUserId, setUserAttributes, refresh, isLoading, isReady }}
    >
      {children}
    </RiviumFlagsContext.Provider>
  );
}

/**
 * useRiviumFlags - React Native hook for feature flags
 *
 * @example
 * ```tsx
 * import { useRiviumFlags } from '@rivium/flags-react-native';
 *
 * export function MyComponent() {
 *   const { isEnabled, isLoading } = useRiviumFlags();
 *
 *   if (isLoading) return <ActivityIndicator />;
 *
 *   return (
 *     <View>{isEnabled('new-feature') ? <NewFeature /> : <OldFeature />}</View>
 *   );
 * }
 * ```
 */
export function useRiviumFlags(): RiviumFlagsContextValue {
  const context = useContext(RiviumFlagsContext);
  if (!context) {
    throw new Error('useRiviumFlags must be used within a RiviumFlagsProvider');
  }
  return context;
}
