import type { FlagsStorage } from './types';

/** Storage keys. */
export const STORAGE_KEYS = {
  anonymousId: 'rivium_flags_anonymous_id',
  cache: 'rivium_flags_cache_v2',
  /** 0.1.x keys, removed on first start of 0.2.0. */
  legacy: ['rivium_ff_cached_flags', 'rivium_ff_user_id'],
} as const;

/** In-memory storage: nothing survives a restart. */
export class MemoryFlagsStorage implements FlagsStorage {
  readonly values = new Map<string, string>();
  async getItem(key: string) {
    return this.values.has(key) ? (this.values.get(key) as string) : null;
  }
  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  async removeItem(key: string) {
    this.values.delete(key);
  }
}

/** AsyncStorage when installed, otherwise in-memory. */
export function defaultStorage(warn: (m: string) => void): FlagsStorage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-async-storage/async-storage');
    const s = mod?.default ?? mod;
    if (s && typeof s.getItem === 'function') return s as FlagsStorage;
  } catch {
    // not installed
  }
  warn('@react-native-async-storage/async-storage is not installed; the anonymous id and results are kept in memory only');
  return new MemoryFlagsStorage();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a lowercase, hyphenated UUID v4. */
export function isUuidV4(s: string): boolean {
  return UUID_RE.test(s);
}

/** A random UUID v4 (crypto.getRandomValues when available, else Math.random). */
export function generateUuidV4(): string {
  const b = new Uint8Array(16);
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
