import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaultConfig } from './config.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeDefaults(base, incoming) {
  if (!isPlainObject(incoming)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = mergeDefaults(base[key], value);
    else out[key] = value;
  }
  return out;
}

/**
 * Persistenza su un singolo JSON dentro il volume Umbrel.
 * Scrittura atomica (tmp + rename) per non corrompere il file se il container muore.
 */
export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'config.json');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.data = this.#load();
  }

  #load() {
    const base = defaultConfig();
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Impossibile leggere ${this.file}: ${err.message}`);
      return base;
    }
    try {
      const parsed = JSON.parse(raw);
      return mergeDefaults(base, parsed);
    } catch (err) {
      // File corrotto: lo conserviamo per analisi invece di perdere i dati.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.file, backup); } catch { /* ignore */ }
      console.error(`config.json non valido (${err.message}). Backup in ${backup}`);
      return base;
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const json = `${JSON.stringify(this.data, null, 2)}\n`;
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* ignore */ }
  }

  update(mutator) {
    const result = mutator(this.data);
    if (result !== false) this.save();
    return this.data;
  }

  /** Segreto di firma delle sessioni, persistente tra i riavvii. */
  secret() {
    const file = path.join(this.dir, 'session.key');
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing.length >= 32) return existing;
    } catch { /* crea */ }
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
    return secret;
  }
}
