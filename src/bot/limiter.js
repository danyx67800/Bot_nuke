/**
 * Finestra scorrevole con capacità N in M millisecondi, per singola chiave.
 * Serve a non sbattere contro i limiti di Discord (2 rinomine / 10 minuti per
 * canale, 2 riordini / 10 minuti per server, ~5 messaggi / 5 secondi per canale).
 */
export class SlidingWindow {
  constructor(capacity, windowMs) {
    this.capacity = Math.max(1, capacity);
    this.windowMs = Math.max(1, windowMs);
    this.hits = new Map();
    this.blocks = new Map();
  }

  #prune(key, now) {
    const list = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  #blockedUntil(key, now) {
    const until = this.blocks.get(key) ?? 0;
    if (until <= now) {
      this.blocks.delete(key);
      return 0;
    }
    return until;
  }

  remaining(key, now = Date.now()) {
    if (this.#blockedUntil(key, now) > now) return 0;
    return Math.max(0, this.capacity - this.#prune(key, now).length);
  }

  /** Timestamp (ms) da cui l'azione torna disponibile. */
  nextAt(key, now = Date.now()) {
    const blocked = this.#blockedUntil(key, now);
    const list = this.#prune(key, now);
    if (list.length < this.capacity) return Math.max(now, blocked);
    const oldest = list[list.length - this.capacity];
    return Math.max(blocked, oldest + this.windowMs);
  }

  take(key, now = Date.now()) {
    if (this.nextAt(key, now) > now) return false;
    const list = this.#prune(key, now);
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  block(key, untilMs) {
    this.blocks.set(key, Math.max(Number(untilMs) || 0, this.blocks.get(key) ?? 0));
  }

  clear() {
    this.hits.clear();
    this.blocks.clear();
  }
}
