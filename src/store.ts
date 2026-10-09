import type { Store } from "./types.js";

/** Storage in memory. It forgets everything when the process stops. */
export function memoryStore(): Store {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => structuredClone(data.get(key)),
    set: async (key, value) => void data.set(key, structuredClone(value)),
  };
}
