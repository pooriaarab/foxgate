import type { Store } from "./types.js";

/** Storage in memory. It forgets everything when the process stops. */
export function memoryStore(): Store {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => structuredClone(data.get(key)),
    set: async (key, value) => void data.set(key, structuredClone(value)),
  };
}

/** The part of a WebExtension storage area that foxgate uses. */
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Storage in a WebExtension area, for example browser.storage.local. */
export function storageAreaStore(area: StorageAreaLike): Store {
  return {
    get: async (key) => (await area.get(key))[key],
    set: (key, value) => area.set({ [key]: value }),
  };
}
