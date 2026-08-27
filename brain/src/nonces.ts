// Антиреплей вхідного /run. Ядро споживає nonce у RunRegistry DO (ADR-037);
// мозок - один процес на VPS, тож досить памʼяті процесу: ключ `run:nonce`,
// TTL 2×TTL підпису (як keepMs роутера ядра). Рестарт процесу вікно обнуляє -
// повтор і тоді вимагає ВАЛІДНОГО підпису в межах 10 хв, тобто компрометації
// ключа, проти якої nonce і так не захист.

export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  /** true = вперше (спожито), false = повтор у вікні TTL. */
  consume(runId: string, nonce: string, nowMs: number): boolean {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) this.seen.delete(key);
    }
    const key = `${runId}:${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, nowMs + this.ttlMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
