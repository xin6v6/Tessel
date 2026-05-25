/**
 * Simple in-memory key-value store for agent memory.
 * Replace with a persistent backend (SQLite, Redis, etc.) as needed.
 */
export class MemoryStore {
  private store: Map<string, unknown> = new Map();

  set<T>(key: string, value: T): void {
    this.store.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  all(): Record<string, unknown> {
    return Object.fromEntries(this.store);
  }

  clear(): void {
    this.store.clear();
  }
}
