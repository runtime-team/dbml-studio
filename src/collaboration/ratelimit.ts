/** Cubeta de fichas por clave: `capacity` ráfaga máxima y `refillPerSecond` fichas recuperadas por segundo. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSecond: number, private now: () => number = Date.now, private maxKeys = 10_000) {}

  /** Consume fichas; devuelve `false` (sin consumir) si no hay suficientes. */
  take(key: string, cost = 1): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.evict(now);
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSecond);
    bucket.at = now;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /** Segundos hasta disponer de `cost` fichas. */
  retryAfter(key: string, cost = 1): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    return Math.max(1, Math.ceil((cost - bucket.tokens) / this.refillPerSecond));
  }

  /** Elimina cubetas ya recargadas; si siguen llenas de claves activas, descarta las más antiguas. */
  private evict(now: number) {
    for (const [key, bucket] of this.buckets) if (bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSecond >= this.capacity) this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) for (const key of [...this.buckets.keys()].slice(0, Math.ceil(this.maxKeys / 10))) this.buckets.delete(key);
  }
}
