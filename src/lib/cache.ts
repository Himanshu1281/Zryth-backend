/**
 * Tiny in-process TTL cache (per backend instance). Used to avoid a Supabase round trip
 * on every request for things that change rarely (token → user, user → org).
 * Bounded so a flood of distinct keys can't exhaust memory.
 */
export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number, private max = 10_000) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.exp) {
      this.map.delete(key);
      return undefined;
    }
    return hit.v;
  }

  set(key: string, v: V, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, { v, exp: Date.now() + ttlMs });
  }

  delete(key: string) {
    this.map.delete(key);
  }
}
