import { EventEmitter } from 'node:events';

const MAX_ENTRIES = 500;

/**
 * Log tenuto in memoria (niente file: il container Umbrel non deve riempire il disco)
 * e trasmesso alla dashboard via SSE.
 */
export class Logger extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.seq = 0;
  }

  push(level, message, meta = null) {
    const entry = {
      id: ++this.seq,
      at: new Date().toISOString(),
      level,
      message: String(message ?? ''),
      meta: meta ?? undefined,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    const line = `[${entry.at}] ${level.toUpperCase()} ${entry.message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    this.emit('log', entry);
    return entry;
  }

  info(message, meta) { return this.push('info', message, meta); }
  success(message, meta) { return this.push('success', message, meta); }
  warn(message, meta) { return this.push('warn', message, meta); }
  error(message, meta) { return this.push('error', message, meta); }

  tail(limit = 80) {
    return this.entries.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)));
  }
}
