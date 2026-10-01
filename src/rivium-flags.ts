import type {
  Attributes,
  FlagDetail,
  FlagReason,
  FlagResult,
  FlagsStorage,
  RiviumFlagsConfig,
  RiviumFlagsError,
  ValueType,
} from './types';
import { STORAGE_KEYS, defaultStorage, generateUuidV4 } from './storage';

export const SDK_VERSION = '0.2.0';
const DEFAULT_BASE_URL = 'https://flags.rivium.co';
const DEBOUNCE_MS = 250;
const FOREGROUND_STALE_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_S = 300;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Rivium Flags client for React Native.
 *
 * Flags are evaluated on the Rivium server (`POST /public/v2/evaluate`); the app only stores the results,
 * so no targeting rules ever reach the device. Getters are synchronous.
 *
 * ```ts
 * const flags = new RiviumFlags({ apiKey: 'rv_live_xxx', environment: 'production' });
 * await flags.init();
 * await flags.identify('user-123', { plan: 'pro' });
 * if (flags.isEnabled('new-checkout')) { … }
 * const theme = flags.getString('theme', 'light');
 * ```
 */
export class RiviumFlags {
  private static _instance: RiviumFlags | null = null;

  /** The client last initialised with `init()`. */
  static get instance(): RiviumFlags {
    if (!RiviumFlags._instance) throw new Error('Rivium Flags: call init() first');
    return RiviumFlags._instance;
  }

  readonly config: Readonly<RiviumFlagsConfig>;
  private readonly storage: FlagsStorage;
  private readonly fetchImpl: typeof fetch;

  private _anonymousId = '';
  private _userId: string | null;
  private _attributes: Attributes;

  private flags: Record<string, FlagResult> | null = null;
  private etag: string | null = null;
  private cachedRequestKey: string | null = null;
  private environment: string | null = null;
  private lastSuccessAt: number | null = null;
  private _version = 0;
  private _lastError: RiviumFlagsError | null = null;
  private lastLoggedStatus: number | null = null;

  private changeListeners = new Set<() => void>();
  private errorListeners = new Set<(e: RiviumFlagsError) => void>();
  private readyResolve!: () => void;
  private readonly readyPromise: Promise<void>;
  private readyResolved = false;

  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private inFlightKey: string | null = null;
  private inFlightGen = -1;
  private abort: AbortController | null = null;
  private requestTimers = new Set<Timer>();
  private debounceTimer: Timer | null = null;
  private debounceWaiters: Array<() => void> = [];
  private retryTimer: Timer | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private failureCount = 0;
  private blockedUntil: number | null = null;
  private _lastRetryDelayMs: number | null = null;
  private halted = false;
  private rejectedBody: string | null = null;
  private foreground = true;
  private appStateSub: { remove(): void } | null = null;
  private started = false;
  private closed = false;

  constructor(config: RiviumFlagsConfig) {
    if (!config?.apiKey) throw new Error('Rivium Flags: apiKey is required');
    if (config.apiKey.startsWith('rv_srv_')) {
      throw new Error('Rivium Flags: that is a server secret. Apps use the public key (rv_live_… / rv_test_…).');
    }
    this.config = { ...config };
    this.storage = config.storage ?? defaultStorage((m) => this.log(m, true));
    const f = config.fetch ?? (globalThis as any).fetch;
    this.fetchImpl = f ? f.bind(globalThis) : (undefined as any);
    this._userId = nonEmpty(config.userId);
    this._attributes = { ...(config.attributes ?? {}) };
    this.readyPromise = new Promise((resolve) => (this.readyResolve = resolve));
  }

  /**
   * Loads the anonymous id and cached results, then waits up to `initTimeoutMs` (5 s) for the first network
   * answer. Sets `RiviumFlags.instance`.
   */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    RiviumFlags._instance = this;

    let anon: string | null = null;
    try {
      anon = await this.storage.getItem(STORAGE_KEYS.anonymousId);
    } catch {}
    if (!anon) {
      anon = generateUuidV4();
      try {
        await this.storage.setItem(STORAGE_KEYS.anonymousId, anon);
      } catch {}
    }
    this._anonymousId = anon;

    for (const k of STORAGE_KEYS.legacy) {
      try {
        await this.storage.removeItem(k);
      } catch {}
    }

    await this.loadCache();
    if (this.config.observeAppState !== false) this.observeAppState();
    this.startPolling();

    const first = this.fetchNow();
    const timeout = this.config.initTimeoutMs ?? 5000;
    let t: Timer | undefined;
    await Promise.race([first, new Promise<void>((r) => (t = setTimeout(r, timeout)))]);
    if (t) clearTimeout(t);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** The install's anonymous id (UUID v4). Survives `reset()`. */
  get anonymousId(): string {
    return this._anonymousId;
  }

  get userId(): string | null {
    return this._userId;
  }

  get attributes(): Attributes {
    return { ...this._attributes };
  }

  /** True once results are available (cache or network). */
  get isReady(): boolean {
    return this.flags !== null;
  }

  /** Resolves the first time results are available. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  /** Increments whenever the stored results change (for `useSyncExternalStore`). */
  get version(): number {
    return this._version;
  }

  get lastError(): RiviumFlagsError | null {
    return this._lastError;
  }

  get lastFetchedAt(): Date | null {
    return this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt);
  }

  /** Called whenever results change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Called on every request failure. Returns an unsubscribe function. */
  onError(listener: (e: RiviumFlagsError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  /** The flag's `enabled` (true only for `ON` / `VARIANT`), or `defaultValue` when unknown / not ready. */
  isEnabled(key: string, defaultValue = false): boolean {
    const r = this.flags?.[key];
    return r ? r.enabled : defaultValue;
  }

  getBoolean(key: string, defaultValue: boolean): boolean {
    return this.getBooleanDetail(key, defaultValue).value;
  }
  getString(key: string, defaultValue: string): string {
    return this.getStringDetail(key, defaultValue).value;
  }
  getNumber(key: string, defaultValue: number): number {
    return this.getNumberDetail(key, defaultValue).value;
  }
  getJson<T = unknown>(key: string, defaultValue: T): T {
    return this.getJsonDetail(key, defaultValue).value;
  }

  getBooleanDetail(key: string, defaultValue: boolean): FlagDetail<boolean> {
    return this.typed(key, defaultValue, 'boolean', (v) => typeof v === 'boolean');
  }
  getStringDetail(key: string, defaultValue: string): FlagDetail<string> {
    return this.typed(key, defaultValue, 'string', (v) => typeof v === 'string');
  }
  getNumberDetail(key: string, defaultValue: number): FlagDetail<number> {
    return this.typed(key, defaultValue, 'number', (v) => typeof v === 'number' && Number.isFinite(v));
  }
  getJsonDetail<T = unknown>(key: string, defaultValue: T): FlagDetail<T> {
    return this.typed(key, defaultValue, 'json', () => true);
  }

  /** The stored result without a type check; `defaultValue` with FLAG_NOT_FOUND / NOT_READY otherwise. */
  getDetail<T = unknown>(key: string, defaultValue?: T): FlagDetail<T | unknown> {
    if (!this.flags) return fallback(defaultValue, 'NOT_READY');
    const r = this.flags[key];
    if (!r) return fallback(defaultValue, 'FLAG_NOT_FOUND');
    return { value: r.value, enabled: r.enabled, variant: r.variant, reason: r.reason, version: r.version };
  }

  /** Every stored result by flag key (empty when not ready). */
  getAll(): Record<string, FlagResult> {
    return { ...(this.flags ?? {}) };
  }

  private typed<T>(key: string, defaultValue: T, type: ValueType, ok: (v: unknown) => boolean): FlagDetail<T> {
    if (!this.flags) return fallback(defaultValue, 'NOT_READY');
    const r = this.flags[key];
    if (!r) return fallback(defaultValue, 'FLAG_NOT_FOUND');
    if (r.valueType !== type || !ok(r.value)) {
      return { value: defaultValue, enabled: false, variant: null, reason: 'TYPE_MISMATCH', version: r.version };
    }
    return { value: r.value as T, enabled: r.enabled, variant: r.variant, reason: r.reason, version: r.version };
  }

  // ---------------------------------------------------------------------------
  // Context
  // ---------------------------------------------------------------------------

  /** Sets the user and (when given) replaces the attributes, then fetches (debounced 250 ms). */
  identify(userId: string | null, attributes?: Attributes): Promise<void> {
    this.setUser(userId);
    if (attributes) this._attributes = { ...attributes };
    return this.contextChanged();
  }

  /** Sets or clears the user id, then fetches (debounced). The previous user's results are dropped. */
  setUserId(userId: string | null): Promise<void> {
    this.setUser(userId);
    return this.contextChanged();
  }

  /** Replaces the targeting attributes, then fetches (debounced). */
  setAttributes(attributes: Attributes): Promise<void> {
    this.ensureOpen();
    this._attributes = { ...attributes };
    return this.contextChanged();
  }

  /** Sign-out: clears user id, attributes and results; keeps the anonymous id; fetches. */
  async reset(): Promise<void> {
    this.ensureOpen();
    this._userId = null;
    this._attributes = {};
    await this.dropResults();
    this.cancelDebounce();
    return this.fetchNow();
  }

  /** Replaces the anonymous id (explicit; `reset()` keeps it) and fetches. */
  async resetAnonymousId(): Promise<void> {
    this.ensureOpen();
    this._anonymousId = generateUuidV4();
    try {
      await this.storage.setItem(STORAGE_KEYS.anonymousId, this._anonymousId);
    } catch {}
    if (this._userId === null) await this.dropResults();
    this.cancelDebounce();
    return this.fetchNow();
  }

  /** Fetches now; resumes after 401 / 403 / 404. During a 429 back-off it waits for Retry-After. */
  refresh(): Promise<void> {
    this.ensureOpen();
    this.halted = false;
    this.rejectedBody = null;
    this.cancelDebounce();
    return this.fetchNow();
  }

  /** Stops timers and listeners. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.abort?.abort();
    this.requestTimers.forEach((t) => clearTimeout(t));
    this.requestTimers.clear();
    this.cancelDebounce();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.appStateSub?.remove();
    this.changeListeners.clear();
    this.errorListeners.clear();
    if (RiviumFlags._instance === this) RiviumFlags._instance = null;
  }

  // ---------------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------------

  /** App resumed: fetch if the last success is older than 15 min; resume polling. */
  onForeground(): void {
    if (this.closed) return;
    this.foreground = true;
    this.startPolling();
    if (!this.halted && (this.lastSuccessAt === null || Date.now() - this.lastSuccessAt > FOREGROUND_STALE_MS)) {
      void this.fetchNow();
    }
  }

  /** App went to the background: polling pauses. */
  onBackground(): void {
    this.foreground = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private observeAppState() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AppState } = require('react-native');
      if (!AppState?.addEventListener) return;
      this.appStateSub = AppState.addEventListener('change', (s: string) => {
        if (s === 'active') this.onForeground();
        else if (s === 'background') this.onBackground();
      });
    } catch {
      // not running in React Native (tests, web without AppState)
    }
  }

  // ---------------------------------------------------------------------------
  // Internals (some exposed for tests)
  // ---------------------------------------------------------------------------

  /** @internal Delay of the last scheduled automatic retry. */
  get lastRetryDelayMs(): number | null {
    return this._lastRetryDelayMs;
  }

  /** @internal True after 401 / 403 / 404 until `refresh()`. */
  get isHalted(): boolean {
    return this.halted;
  }

  /** The JSON body of the next evaluate request. */
  buildRequestBody(): Record<string, unknown> {
    const context: Record<string, unknown> = {};
    if (this._userId !== null) context.userId = this._userId;
    context.anonymousId = this._anonymousId;
    context.attributes = this._attributes;
    const body: Record<string, unknown> = {};
    if (this.config.environment != null) body.environment = this.config.environment;
    body.context = context;
    if (this.config.flagKeys) body.flagKeys = this.config.flagKeys;
    return body;
  }

  private async loadCache() {
    try {
      const raw = await this.storage.getItem(STORAGE_KEYS.cache);
      if (!raw) return;
      const data = JSON.parse(raw);
      if ((data.userId ?? null) !== this._userId) {
        await this.storage.removeItem(STORAGE_KEYS.cache);
        return;
      }
      this.flags = parseFlags(data.flags);
      this.etag = data.etag ?? null;
      this.cachedRequestKey = data.requestKey ?? null;
      this.environment = data.environment ?? null;
      this.lastSuccessAt = typeof data.fetchedAt === 'number' ? data.fetchedAt : null;
      this.markReady();
      this.emitChange();
      this.log(`serving ${Object.keys(this.flags).length} cached results`);
    } catch {
      // a broken cache is ignored
    }
  }

  private async saveCache() {
    if (!this.flags) return;
    try {
      await this.storage.setItem(
        STORAGE_KEYS.cache,
        JSON.stringify({
          flags: this.flags,
          etag: this.etag,
          requestKey: this.cachedRequestKey,
          environment: this.environment,
          userId: this._userId,
          fetchedAt: this.lastSuccessAt,
        }),
      );
    } catch {}
  }

  private async dropResults() {
    this.generation++; // an answer for the old context must not land
    this.abort?.abort();
    const had = this.flags !== null;
    this.flags = null;
    this.etag = null;
    this.cachedRequestKey = null;
    try {
      await this.storage.removeItem(STORAGE_KEYS.cache);
    } catch {}
    if (had) this.emitChange();
  }

  private setUser(userId: string | null | undefined) {
    this.ensureOpen();
    const next = nonEmpty(userId);
    if (next !== this._userId) {
      this._userId = next;
      void this.dropResults();
    }
  }

  private contextChanged(): Promise<void> {
    this.ensureOpen();
    this.generation++;
    return new Promise<void>((resolve) => {
      this.debounceWaiters.push(resolve);
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        const waiters = this.debounceWaiters;
        this.debounceWaiters = [];
        this.debounceTimer = null;
        this.fetchNow().finally(() => waiters.forEach((w) => w()));
      }, DEBOUNCE_MS);
    });
  }

  private cancelDebounce() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    const waiters = this.debounceWaiters;
    this.debounceWaiters = [];
    waiters.forEach((w) => w());
  }

  private startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const s = this.config.refreshIntervalSeconds ?? 0;
    if (s <= 0 || !this.foreground || this.closed) return;
    this.pollTimer = setInterval(() => {
      if (this.foreground && !this.halted) void this.fetchNow();
    }, Math.max(60, s) * 1000);
  }

  private fetchNow(): Promise<void> {
    if (this.closed || !this.started) return Promise.resolve();
    const body = this.buildRequestBody();
    const key = canonicalJson(body);
    if (this.inFlight && this.inFlightKey === key && this.inFlightGen === this.generation) return this.inFlight;

    if (this.blockedUntil !== null && Date.now() < this.blockedUntil) {
      this.scheduleRetry(this.blockedUntil - Date.now());
      return Promise.resolve();
    }
    if (this.rejectedBody === key) return Promise.resolve();

    const gen = ++this.generation;
    this.abort?.abort(); // a newer request supersedes the older one
    const p = this.send(body, key, gen).finally(() => {
      if (this.inFlight === p) {
        this.inFlight = null;
        this.inFlightKey = null;
      }
    });
    this.inFlight = p;
    this.inFlightKey = key;
    this.inFlightGen = gen;
    return p;
  }

  private async send(body: Record<string, unknown>, key: string, gen: number): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'x-rivium-sdk': `react-native/${SDK_VERSION}`,
    };
    if (this.etag && this.flags && this.cachedRequestKey === key) headers['if-none-match'] = this.etag;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.abort = controller;
    const timer = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
    this.requestTimers.add(timer);
    const done = () => {
      clearTimeout(timer);
      this.requestTimers.delete(timer);
    };
    let res: Response;
    try {
      const url = `${(this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')}/public/v2/evaluate`;
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller?.signal as any,
      });
    } catch (e) {
      done();
      if (gen !== this.generation || this.closed) return;
      this.fail(null, null, `network error: ${(e as Error)?.message ?? e}`, true);
      return;
    }
    done();
    if (gen !== this.generation || this.closed) return; // superseded

    const status = res.status;
    if (status === 200) {
      let flags: Record<string, FlagResult>;
      let environment: string | null;
      try {
        const data = await res.json();
        flags = parseFlags(data?.flags);
        environment = data?.environment ?? null;
      } catch (e) {
        this.fail(status, null, `unreadable response: ${(e as Error)?.message ?? e}`, true);
        return;
      }
      if (gen !== this.generation || this.closed) return;
      this.flags = flags;
      this.etag = res.headers.get('etag');
      this.cachedRequestKey = key;
      this.environment = environment;
      this.succeeded();
      this.emitChange();
      await this.saveCache();
      this.log(`fetched ${Object.keys(flags).length} flags`);
      return;
    }
    if (status === 304) {
      this.succeeded();
      await this.saveCache();
      this.log('results unchanged (304)');
      return;
    }

    let code: string | null = null;
    let message = `HTTP ${status}`;
    try {
      const err = await res.json();
      if (err && typeof err === 'object') {
        if (typeof err.code === 'string') code = err.code;
        if (typeof err.message === 'string') message = err.message;
        else if (Array.isArray(err.message)) message = err.message.join('; ');
      }
    } catch {}

    if (status === 429) {
      const ra = parseInt(res.headers.get('retry-after') ?? '', 10);
      this.fail(status, code, message, true, Number.isFinite(ra) ? ra : 5);
    } else if (status >= 500) {
      this.fail(status, code, message, true);
    } else if (status === 401 || status === 403 || status === 404) {
      this.halted = true;
      this.fail(status, code, message, false);
    } else {
      this.rejectedBody = key; // 400 / 413 / other 4xx: do not resend the same body
      this.fail(status, code, message, false);
    }
  }

  private succeeded() {
    this.lastSuccessAt = Date.now();
    this.failureCount = 0;
    this.blockedUntil = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this._lastError = null;
    this.lastLoggedStatus = null;
    this.markReady();
  }

  private fail(status: number | null, code: string | null, message: string, retry: boolean, retryAfterS?: number) {
    const error: RiviumFlagsError = { statusCode: status, code, message };
    this._lastError = error;
    this.errorListeners.forEach((l) => {
      try {
        l(error);
      } catch {}
    });
    const logKey = status ?? -1;
    if (this.lastLoggedStatus !== logKey) {
      this.lastLoggedStatus = logKey;
      this.log(
        `request failed (${status ?? 'network'}${code ? ` ${code}` : ''}): ${message}${this.flags ? ' (serving cached results)' : ''}`,
        true,
      );
    }
    if (!retry) return;
    this.failureCount++;
    const base = retryAfterS ?? 5;
    const exp = Math.min(MAX_BACKOFF_S, base * 2 ** (this.failureCount - 1));
    let seconds = exp * (0.8 + Math.random() * 0.4);
    if (retryAfterS !== undefined) {
      seconds = Math.max(seconds, retryAfterS); // never earlier than Retry-After
      this.blockedUntil = Date.now() + Math.round(seconds * 1000);
    }
    this.scheduleRetry(Math.round(seconds * 1000));
  }

  private scheduleRetry(ms: number) {
    if (this.closed) return;
    this._lastRetryDelayMs = ms;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.halted) void this.fetchNow();
    }, ms);
  }

  private markReady() {
    if (!this.readyResolved) {
      this.readyResolved = true;
      this.readyResolve();
    }
  }

  private emitChange() {
    this._version++;
    this.changeListeners.forEach((l) => {
      try {
        l();
      } catch {}
    });
  }

  private ensureOpen() {
    if (this.closed) throw new Error('Rivium Flags: this client is closed');
  }

  private log(message: string, error = false) {
    if (error) console.warn(`[Rivium Flags] ${message}`);
    else if (this.config.debug) console.log(`[Rivium Flags] ${message}`);
  }
}

function fallback<T>(value: T, reason: FlagReason): FlagDetail<T> {
  return { value, enabled: false, variant: null, reason };
}

function nonEmpty(s: string | null | undefined): string | null {
  return typeof s === 'string' && s.length > 0 ? s : null;
}

function parseFlags(raw: unknown): Record<string, FlagResult> {
  const out: Record<string, FlagResult> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
      if (!v || typeof v !== 'object') continue;
      out[k] = {
        key: typeof v.key === 'string' ? v.key : k,
        valueType: (v.valueType ?? 'json') as ValueType,
        enabled: v.enabled === true,
        value: v.value,
        variant: typeof v.variant === 'string' ? v.variant : null,
        reason: (v.reason ?? 'ERROR') as FlagReason,
        version: typeof v.version === 'number' ? v.version : undefined,
      };
    }
  }
  return out;
}

/** JSON with sorted object keys, so equal contexts give equal strings. */
function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as any)[k]);
    return out;
  }
  return v;
}
