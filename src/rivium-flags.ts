import { RiviumFlagsConfig, FeatureFlag, FlagEvalResult, FeatureFlagCallback } from './types';
import { md5 } from './md5';

const DEFAULT_BASE_URL = 'https://flags.rivium.co';
const CACHE_KEY = 'rivium_ff_cached_flags';
const USER_ID_KEY = 'rivium_ff_user_id';

let AsyncStorage: any;
let NetInfo: any;

try { AsyncStorage = require('@react-native-async-storage/async-storage').default; } catch {}
try { NetInfo = require('@react-native-community/netinfo').default; } catch {}

/**
 * RiviumFlags - Client-side Feature Flags SDK for React Native
 *
 * @example
 * ```typescript
 * const flags = new RiviumFlags({ apiKey: 'rv_live_xxx' });
 * await flags.init();
 * flags.setUserId('user-123');
 *
 * if (flags.isEnabled('dark-mode')) {
 *   // dark mode enabled
 * }
 * ```
 */
export class RiviumFlags {
  private static _instance: RiviumFlags | null = null;

  private config: RiviumFlagsConfig;
  private flags: FeatureFlag[] = [];
  private userId?: string;
  private userAttributes: Record<string, any> = {};
  private initialized = false;
  private isOnline = true;
  private callback?: FeatureFlagCallback;

  constructor(config: RiviumFlagsConfig) {
    if (!config.apiKey) throw new Error('apiKey is required');
    this.config = {
      ...config,
      baseUrl: config.baseUrl || DEFAULT_BASE_URL,
      enableOfflineCache: config.enableOfflineCache ?? true,
    };
  }

  static get instance(): RiviumFlags {
    if (!RiviumFlags._instance) throw new Error('RiviumFlags not initialized. Call init() first.');
    return RiviumFlags._instance;
  }

  async init(callback?: FeatureFlagCallback): Promise<void> {
    this.callback = callback;

    // Load cached flags
    if (this.config.enableOfflineCache && AsyncStorage) {
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) this.flags = JSON.parse(cached);
        const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
        if (savedUserId) this.userId = savedUserId;
      } catch {}
    }

    // Check connectivity
    if (NetInfo) {
      try {
        const state = await NetInfo.fetch();
        this.isOnline = state.isConnected ?? true;
      } catch {
        this.isOnline = true;
      }
    }

    this.initialized = true;
    RiviumFlags._instance = this;

    if (this.isOnline) {
      await this.fetchFlags();
    }

    this.callback?.('initialized', { offline: !this.isOnline, count: this.flags.length });
  }

  async setUserId(userId: string): Promise<void> {
    this.userId = userId;
    if (this.config.enableOfflineCache && AsyncStorage) {
      try { await AsyncStorage.setItem(USER_ID_KEY, userId); } catch {}
    }
  }

  getUserId(): string | undefined {
    return this.userId;
  }

  setUserAttributes(attributes: Record<string, any>): void {
    this.userAttributes = { ...this.userAttributes, ...attributes };
  }

  isEnabled(flagKey: string, defaultValue = false): boolean {
    const flag = this.flags.find((f) => f.key === flagKey);
    if (!flag) return defaultValue;
    return this.evaluateFlag(flag).enabled;
  }

  getValue(flagKey: string, defaultValue?: any): any {
    const flag = this.flags.find((f) => f.key === flagKey);
    if (!flag) return defaultValue;
    const result = this.evaluateFlag(flag);
    return result.value ?? defaultValue;
  }

  evaluate(flagKey: string): FlagEvalResult {
    const flag = this.flags.find((f) => f.key === flagKey);
    if (!flag) return { enabled: false, value: false };
    return this.evaluateFlag(flag);
  }

  getAll(): FeatureFlag[] {
    return [...this.flags];
  }

  async refresh(): Promise<void> {
    await this.fetchFlags();
    this.callback?.('featureFlagsRefreshed', { count: this.flags.length });
  }

  async reset(): Promise<void> {
    this.flags = [];
    this.userId = undefined;
    this.userAttributes = {};
    this.initialized = false;
    RiviumFlags._instance = null;
    if (AsyncStorage) {
      try {
        await AsyncStorage.multiRemove([CACHE_KEY, USER_ID_KEY]);
      } catch {}
    }
  }

  dispose(): void {
    this.flags = [];
    this.userId = undefined;
    this.userAttributes = {};
    this.initialized = false;
    RiviumFlags._instance = null;
  }

  // ============================================
  // PRIVATE METHODS
  // ============================================

  private get flagsUrl(): string {
    const base = `${this.config.baseUrl}/public/flags`;
    if (this.config.environment) {
      return `${base}?environment=${encodeURIComponent(this.config.environment)}`;
    }
    return base;
  }

  private async fetchFlags(): Promise<void> {
    try {
      const response = await fetch(this.flagsUrl, {
        headers: { 'x-api-key': this.config.apiKey },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      this.flags = (data.flags || []) as FeatureFlag[];

      if (this.config.enableOfflineCache && AsyncStorage) {
        try { await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(this.flags)); } catch {}
      }

      if (this.config.debug) {
        console.log(`[RiviumFlags] Fetched ${this.flags.length} flags`);
      }
    } catch (error) {
      if (this.config.debug) {
        console.error('[RiviumFlags] Failed to fetch flags:', error);
      }
      this.callback?.('error', { message: `Failed to fetch flags: ${error}` });
    }
  }

  private evaluateFlag(flag: FeatureFlag): FlagEvalResult {
    if (!flag.enabled) {
      return { enabled: false, value: flag.defaultValue ?? false };
    }

    if (flag.targetingRules && Object.keys(flag.targetingRules).length > 0) {
      if (!this.evaluateTargetingRules(flag.targetingRules, this.userAttributes)) {
        return { enabled: false, value: flag.defaultValue ?? false };
      }
    }

    if (this.userId) {
      const bucket = this.getBucket(this.userId, flag.key);
      if (bucket >= flag.rolloutPercentage) {
        return { enabled: false, value: flag.defaultValue ?? false };
      }
    }

    if (flag.variants && flag.variants.length > 0) {
      const variantBucket = this.getVariantBucket(this.userId || '', flag.key);
      let cumulative = 0;
      for (const variant of flag.variants) {
        cumulative += variant.weight;
        if (variantBucket < cumulative) {
          return { enabled: true, value: variant.value, variant: variant.key };
        }
      }
      return { enabled: true, value: flag.variants[0].value, variant: flag.variants[0].key };
    }

    return { enabled: true, value: true };
  }

  private evaluateTargetingRules(rules: Record<string, any>, userContext: Record<string, any>): boolean {
    // Handle nested { operator, rules } format from dashboard
    if (rules.rules && Array.isArray(rules.rules)) {
      const op = (rules.operator || 'AND').toUpperCase();
      if (op === 'OR') return rules.rules.some((r: any) => this.evaluateNestedRule(r, userContext));
      return rules.rules.every((r: any) => this.evaluateNestedRule(r, userContext));
    }
    // Legacy flat format
    for (const [key, rule] of Object.entries(rules)) {
      if (!this.evaluateRule(key, rule, userContext)) return false;
    }
    return true;
  }

  private evaluateNestedRule(rule: { attribute: string; operator: string; value: any }, context: Record<string, any>): boolean {
    const userValue = context[rule.attribute];
    switch (rule.operator) {
      case 'equals': return userValue === rule.value;
      case 'not_equals': case 'notEquals': return userValue !== rule.value;
      case 'in': {
        const list = typeof rule.value === 'string' ? rule.value.split(',').map((s: string) => s.trim()) : rule.value;
        return Array.isArray(list) && list.includes(userValue);
      }
      case 'not_in': case 'notIn': {
        const list = typeof rule.value === 'string' ? rule.value.split(',').map((s: string) => s.trim()) : rule.value;
        return !Array.isArray(list) || !list.includes(userValue);
      }
      case 'greater_than': case 'greaterThan': return typeof userValue === 'number' && userValue > Number(rule.value);
      case 'less_than': case 'lessThan': return typeof userValue === 'number' && userValue < Number(rule.value);
      case 'contains': return typeof userValue === 'string' && userValue.includes(String(rule.value));
      case 'regex': return typeof userValue === 'string' && new RegExp(String(rule.value)).test(userValue);
      case 'exists': return rule.value ? userValue != null : userValue == null;
      default: return userValue === rule.value;
    }
  }

  private evaluateRule(key: string, rule: any, context: Record<string, any>): boolean {
    const value = context[key];
    if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
      if ('equals' in rule) return value === rule.equals;
      if ('notEquals' in rule) return value !== rule.notEquals;
      if ('in' in rule && Array.isArray(rule.in)) return rule.in.includes(value);
      if ('notIn' in rule && Array.isArray(rule.notIn)) return !rule.notIn.includes(value);
      if ('greaterThan' in rule) return typeof value === 'number' && value > rule.greaterThan;
      if ('lessThan' in rule) return typeof value === 'number' && value < rule.lessThan;
      if ('greaterThanOrEqual' in rule) return typeof value === 'number' && value >= rule.greaterThanOrEqual;
      if ('lessThanOrEqual' in rule) return typeof value === 'number' && value <= rule.lessThanOrEqual;
      if ('contains' in rule) return typeof value === 'string' && value.includes(rule.contains);
      if ('regex' in rule) return typeof value === 'string' && new RegExp(rule.regex).test(value);
      if ('exists' in rule) return rule.exists ? value != null : value == null;
      if ('and' in rule && Array.isArray(rule.and)) return rule.and.every((r: any) => this.evaluateRule(key, r, context));
      if ('or' in rule && Array.isArray(rule.or)) return rule.or.some((r: any) => this.evaluateRule(key, r, context));
    }
    return value === rule;
  }

  private getBucket(userId: string, salt: string): number {
    const hash = md5(`${userId}:${salt}`);
    return parseInt(hash.substring(0, 8), 16) % 100;
  }

  private getVariantBucket(userId: string, flagKey: string): number {
    const hash = md5(`${userId}:${flagKey}:variant`);
    return parseInt(hash.substring(0, 8), 16) % 100;
  }
}
