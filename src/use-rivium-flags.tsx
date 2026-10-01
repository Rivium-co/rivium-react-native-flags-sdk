import React, { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { RiviumFlags } from './rivium-flags';
import type { FlagDetail, RiviumFlagsConfig } from './types';

const RiviumFlagsContext = createContext<RiviumFlags | null>(null);

export interface RiviumFlagsProviderProps {
  /** Creates and initialises a client for you… */
  config?: RiviumFlagsConfig;
  /** …or pass one you created (and called `init()` on) yourself. */
  client?: RiviumFlags;
  children: React.ReactNode;
}

/**
 * Provides a Rivium Flags client to the tree. Components using the hooks re-render when results change.
 *
 * ```tsx
 * <RiviumFlagsProvider config={{ apiKey: 'rv_live_xxx', environment: 'production' }}>
 *   <App />
 * </RiviumFlagsProvider>
 * ```
 */
export function RiviumFlagsProvider({ config, client, children }: RiviumFlagsProviderProps) {
  const [instance] = useState(() => {
    if (client) return client;
    if (!config) throw new Error('RiviumFlagsProvider needs `config` or `client`');
    return new RiviumFlags(config);
  });

  useEffect(() => {
    if (client) return;
    void instance.init();
    return () => instance.close();
  }, [instance, client]);

  return <RiviumFlagsContext.Provider value={instance}>{children}</RiviumFlagsContext.Provider>;
}

/** What `useRiviumFlags()` returns. Functions are bound, so destructuring is safe. */
export interface RiviumFlagsHook {
  client: RiviumFlags;
  isReady: boolean;
  anonymousId: string;
  userId: string | null;
  isEnabled: RiviumFlags['isEnabled'];
  getBoolean: RiviumFlags['getBoolean'];
  getString: RiviumFlags['getString'];
  getNumber: RiviumFlags['getNumber'];
  getJson: RiviumFlags['getJson'];
  getDetail: RiviumFlags['getDetail'];
  getAll: RiviumFlags['getAll'];
  identify: RiviumFlags['identify'];
  setUserId: RiviumFlags['setUserId'];
  setAttributes: RiviumFlags['setAttributes'];
  reset: RiviumFlags['reset'];
  resetAnonymousId: RiviumFlags['resetAnonymousId'];
  refresh: RiviumFlags['refresh'];
}

/** The client from the nearest provider; re-renders the component when results change. */
export function useRiviumFlags(): RiviumFlagsHook {
  const client = useContext(RiviumFlagsContext);
  if (!client) throw new Error('useRiviumFlags must be used within a RiviumFlagsProvider');
  const version = useSyncExternalStore(
    (cb) => client.subscribe(cb),
    () => client.version,
    () => client.version,
  );
  return useMemo(
    () => ({
      client,
      isReady: client.isReady,
      anonymousId: client.anonymousId,
      userId: client.userId,
      isEnabled: client.isEnabled.bind(client),
      getBoolean: client.getBoolean.bind(client),
      getString: client.getString.bind(client),
      getNumber: client.getNumber.bind(client),
      getJson: client.getJson.bind(client),
      getDetail: client.getDetail.bind(client),
      getAll: client.getAll.bind(client),
      identify: client.identify.bind(client),
      setUserId: client.setUserId.bind(client),
      setAttributes: client.setAttributes.bind(client),
      reset: client.reset.bind(client),
      resetAnonymousId: client.resetAnonymousId.bind(client),
      refresh: client.refresh.bind(client),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, version, client.userId, client.anonymousId],
  );
}

/** `isEnabled(key, defaultValue)`, re-rendering on change. */
export function useFlagEnabled(key: string, defaultValue = false): boolean {
  return useRiviumFlags().isEnabled(key, defaultValue);
}

export function useBooleanFlag(key: string, defaultValue: boolean): boolean {
  return useRiviumFlags().getBoolean(key, defaultValue);
}

export function useStringFlag(key: string, defaultValue: string): string {
  return useRiviumFlags().getString(key, defaultValue);
}

export function useNumberFlag(key: string, defaultValue: number): number {
  return useRiviumFlags().getNumber(key, defaultValue);
}

export function useJsonFlag<T = unknown>(key: string, defaultValue: T): T {
  return useRiviumFlags().getJson(key, defaultValue);
}

/** Value, enabled, variant, reason and version of one flag. */
export function useFlagDetail<T = unknown>(key: string, defaultValue?: T): FlagDetail<T | unknown> {
  return useRiviumFlags().getDetail(key, defaultValue);
}
