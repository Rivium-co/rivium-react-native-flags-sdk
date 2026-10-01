/** Attribute values: string, number, boolean, null, or an array of those (no nested objects). */
export type AttributeValue = string | number | boolean | null | Array<string | number | boolean | null>;
export type Attributes = Record<string, AttributeValue>;

export type ValueType = 'boolean' | 'string' | 'number' | 'json';

/** Why a flag has the value it has. */
export type FlagReason =
  | 'ON'
  | 'VARIANT'
  | 'DISABLED'
  | 'PREREQUISITE_FAILED'
  | 'NOT_TARGETED'
  | 'OUTSIDE_ROLLOUT'
  | 'NO_BUCKETING_ID'
  | 'ERROR'
  | 'FLAG_NOT_FOUND'
  | 'NOT_READY'
  | 'TYPE_MISMATCH';

/** One flag result as returned by `POST /public/v2/evaluate`. */
export interface FlagResult {
  key: string;
  valueType: ValueType;
  enabled: boolean;
  value: unknown;
  variant: string | null;
  reason: FlagReason;
  version?: number;
}

/** What a getter returned and why. */
export interface FlagDetail<T = unknown> {
  value: T;
  enabled: boolean;
  variant: string | null;
  reason: FlagReason;
  version?: number;
}

/** A request failure. Never contains the API key. */
export interface RiviumFlagsError {
  /** HTTP status, or null for a network error. */
  statusCode: number | null;
  /** Server error code (e.g. `environment_not_found`) when present. */
  code: string | null;
  message: string;
}

/** Async key-value store for the anonymous id and the results cache. */
export interface FlagsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface RiviumFlagsConfig {
  /** Public project key (`rv_live_…` / `rv_test_…`). Never the server secret. */
  apiKey: string;
  /** Environment key; omitted = the Default layer. */
  environment?: string;
  /** Only evaluate these flags; omitted = every flag of the project. */
  flagKeys?: string[];
  /** Initial signed-in user id. */
  userId?: string | null;
  /** Initial targeting attributes. */
  attributes?: Attributes;
  /** Foreground polling in seconds. 0 (default) = off, otherwise at least 60. Each fetch is billed. */
  refreshIntervalSeconds?: number;
  /** How long `init()` waits for the first network answer (ms, default 5000). */
  initTimeoutMs?: number;
  /** Verbose logs. Errors are always logged. */
  debug?: boolean;
  /** API base URL (default https://flags.rivium.co). */
  baseUrl?: string;
  /** Storage; default AsyncStorage, in-memory if it is not installed. */
  storage?: FlagsStorage;
  /** fetch implementation (default global fetch). */
  fetch?: typeof fetch;
  /** Refresh on app resume via React Native AppState (default true). */
  observeAppState?: boolean;
}
