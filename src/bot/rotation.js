import { computeFrame } from './frame.js';
import { normalizeChannelName } from './channels.js';
import { SlidingWindow } from './limiter.js';
import { clampPostRate, sleep } from '../util.js';

const TEN_MINUTES = 10 * 60_000;
const RESTORE_ROUND_DELAY = 30_000;

/**
 * Motore del loop: ogni tick applica nomi + ordine e accoda il burst di messaggi.
 * Tutte le azioni passano da un rate limiter perché Discord consente solo
 * ~2 modifiche per canale ogni 10 minuti: quando il budget è finito l'azione
 * viene rimandata (e mostrata) invece di generare errori 429.
 */
export class Rotation {
  constructor({ store, manager, logger }) {
    this.store = store;
    this.manager = manager;
    this.logger = logger;
    this.limits = {
      rename: new SlidingWindow(2, TEN_MINUTES),
      reorder: new SlidingWindow(2, TEN_MINUTES),
      send: new SlidingWindow(5, 5_000),
    };
    this.state = {
      running: false,
      busy: false,
      msgBusy: false,
      tick: 0,
      nextAt: null,
      nextMessageAt: null,
      pending: [],
      last: null,
      lastError: null,
      startedAt: null,
      restore: null,
    };
    this.wakes = new Set();
    this.generation = 0;
    this.loop = null;
    this.messageLoop = null;
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakes.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.wakes.add(done);
    });
  }

  #wakeAll() {
    for (const wake of [...this.wakes]) wake();
  }

  async start() {
    const cfg = this.store.data;
    if (!this.manager.ready) throw new Error('Il bot non è connesso a Discord.');
    if (!cfg.channels.animated.length) throw new Error('Nessun canale selezionato.');
    if (!cfg.channels.animated.some((channel) => cfg.rotation.names[channel.id]?.length)) {
      throw new Error('Nessun nome configurato per i canali.');
    }
    if (cfg.messages.enabled && cfg.messages.mode !== 'off' && !cfg.channels.message) {
      throw new Error('Canale dei messaggi non configurato.');
    }
    if (this.state.running) return this.status();

    await this.takeSnapshot();

    this.state.running = true;
    this.state.startedAt = Date.now();
    this.state.lastError = null;
    // Eventuali burst accodati da tick manuali a loop fermo non devono partire in blocco.
    this.state.pending = [];
    this.state.nextAt = Date.now() + cfg.loop.intervalSec * 1000;
    this.state.nextMessageAt = cfg.messages.mode === 'timer' ? Date.now() + 2000 : null;
    this.store.update((data) => { data.stats.lastStartedAt = new Date().toISOString(); });

    this.logger.success(
      `Loop avviato · tick ogni ${cfg.loop.intervalSec}s${cfg.loop.jitterSec ? ` (+/-${cfg.loop.jitterSec}s jitter)` : ''}${cfg.loop.dryRun ? ' · DRY RUN' : ''}`,
    );

    this.loop = this.#runRotation();
    this.messageLoop = this.#runMessages();
    return this.status();
  }

  stop(reason = '') {
    if (!this.state.running) return this.status();
    this.state.running = false;
    this.generation += 1;
    this.state.nextAt = null;
    this.state.nextMessageAt = null;
    this.state.pending = [];
    this.#wakeAll();
    this.store.update((data) => { data.stats.lastStoppedAt = new Date().toISOString(); });
    this.logger.info(`Loop fermato${reason ? ` (${reason})` : ''}.`);
    return this.status();
  }

  async #runRotation() {
    while (this.state.running) {
      const wait = Math.max(0, (this.state.nextAt ?? Date.now()) - Date.now());
      await this.#sleep(wait);
      if (!this.state.running) break;
      try {
        await this.runTick({ manual: false });
      } catch (err) {
        this.state.lastError = err.message;
        this.logger.error(`Tick non eseguito: ${err.message}`);
      }
      if (!this.state.running) break;
      const cfg = this.store.data;
      const jitter = Math.floor(Math.random() * Math.max(0, cfg.loop.jitterSec) * 1000);
      this.state.nextAt = Date.now() + cfg.loop.intervalSec * 1000 + jitter;
    }
  }

  async #runMessages() {
    while (this.state.running) {
      await this.#sleep(1000);
      if (!this.state.running) break;
      const cfg = this.store.data;
      if (!cfg.messages.enabled || cfg.messages.mode === 'off') {
        this.state.pending = [];
        continue;
      }
      if (this.state.msgBusy) continue;

      const job = this.state.pending.shift();
      if (job) {
        try { await this.burst(job); } catch (err) { this.logger.error(`Burst messaggi fallito: ${err.message}`); }
        continue;
      }

      if (cfg.messages.mode === 'timer') {
        if (!this.state.nextMessageAt) {
          this.state.nextMessageAt = Date.now() + cfg.messages.intervalSec * 1000;
        }
        if (Date.now() >= this.state.nextMessageAt) {
          this.state.nextMessageAt = Date.now() + cfg.messages.intervalSec * 1000;
          try { await this.burst({}); } catch (err) { this.logger.error(`Burst messaggi fallito: ${err.message}`); }
        }
      }
    }
  }

  async takeSnapshot(force = false) {
    const cfg = this.store.data;
    if (!cfg.bot.guildId || !cfg.channels.animated.length) return null;
    const existing = cfg.snapshot;
    if (!force && existing && existing.guildId === cfg.bot.guildId && !existing.restoredAt) {
      return existing;
    }
    const states = this.manager.channelStates();
    const channels = cfg.channels.animated
      .map((channel) => states.get(channel.id))
      .filter(Boolean)
      .map((state) => ({ id: state.id, name: state.name, position: state.position }));
    if (!channels.length) return null;
    const snapshot = {
      guildId: cfg.bot.guildId,
      takenAt: new Date().toISOString(),
      restoredAt: null,
      channels,
    };
    this.store.update((data) => { data.snapshot = snapshot; });
    this.logger.info(`Nomi originali salvati per ${channels.length} canali (utili per il ripristino).`);
    return snapshot;
  }

  async runTick({ manual = false } = {}) {
    if (this.state.busy) return { skipped: true, reason: 'Un tick è già in corso.' };
    if (!this.manager.ready) throw new Error('Il bot non è connesso a Discord.');

    this.state.busy = true;
    let saved = false;
    try {
      const cfg = this.store.data;
      const tickIndex = this.state.tick;
      const frame = computeFrame(cfg, tickIndex);
      const dryRun = Boolean(cfg.loop.dryRun);
      const result = { tick: tickIndex, at: Date.now(), dryRun, actions: [] };
      const states = this.manager.channelStates();

      if (cfg.rotation.enabled && cfg.rotation.applyNames) {
        for (const entry of frame.names) {
          const state = states.get(entry.id);
          if (!state) {
            result.actions.push({ type: 'rename', channelId: entry.id, ok: false, detail: 'Canale non trovato' });
            continue;
          }
          const desired = normalizeChannelName(entry.name, state.type);
          if (!desired) continue;
          if (desired === state.name) {
            result.actions.push({ type: 'rename', channelId: entry.id, to: desired, skipped: 'nome già aggiornato' });
            continue;
          }
          if (dryRun) {
            result.actions.push({ type: 'rename', channelId: entry.id, from: state.name, to: desired, dryRun: true });
            continue;
          }
          if (!this.limits.rename.take(entry.id)) {
            result.actions.push({
              type: 'rename', channelId: entry.id, to: desired,
              deferred: true, nextAt: this.limits.rename.nextAt(entry.id),
            });
            continue;
          }
          try {
            await this.manager.renameChannel(entry.id, desired, cfg.loop.reason);
            result.actions.push({ type: 'rename', channelId: entry.id, from: state.name, to: desired, ok: true });
            this.store.data.stats.renames += 1;
            saved = true;
          } catch (err) {
            this.#handleRateLimit('rename', entry.id, err);
            result.actions.push({ type: 'rename', channelId: entry.id, to: desired, ok: false, error: err.message });
            this.logger.error(`Rinomina fallita su #${state.name}: ${err.message}`);
          }
          await sleep(500);
        }
      }

      if (cfg.rotation.enabled && cfg.rotation.applyOrder && frame.shift > 0) {
        const ordered = cfg.channels.animated
          .map((channel) => states.get(channel.id))
          .filter(Boolean)
          .sort((a, b) => a.position - b.position);
        if (ordered.length >= 2) {
          const slots = ordered.map((channel) => channel.position);
          const targets = ordered.map((channel, index) => ({
            id: channel.id,
            position: slots[(index + frame.shift) % slots.length],
          }));
          const currentOrder = ordered.map((channel) => channel.id).join(',');
          const nextOrder = [...targets].sort((a, b) => a.position - b.position).map((item) => item.id).join(',');
          if (currentOrder === nextOrder) {
            result.actions.push({ type: 'reorder', skipped: 'ordine invariato' });
          } else if (dryRun) {
            result.actions.push({ type: 'reorder', dryRun: true, order: nextOrder.split(',') });
          } else if (!this.limits.reorder.take('guild')) {
            result.actions.push({ type: 'reorder', deferred: true, nextAt: this.limits.reorder.nextAt('guild') });
          } else {
            try {
              await this.manager.reorder(targets);
              result.actions.push({ type: 'reorder', ok: true, order: nextOrder.split(',') });
              this.store.data.stats.reorders += 1;
              saved = true;
            } catch (err) {
              this.#handleRateLimit('reorder', 'guild', err);
              result.actions.push({ type: 'reorder', ok: false, error: err.message });
              this.logger.error(`Riordino fallito: ${err.message}`);
            }
          }
        }
      }

      if (cfg.messages.enabled && cfg.messages.mode === 'rotation' && cfg.channels.message && this.state.running) {
        this.state.pending.push({
          text: frame.text,
          count: cfg.messages.repeat,
          gapMs: cfg.messages.gapMs,
          tick: tickIndex,
        });
      }

      this.state.tick = tickIndex + 1;
      this.store.data.stats.ticks += 1;
      saved = true;
      this.state.last = result;

      const applied = result.actions.filter((action) => action.ok).length;
      const deferred = result.actions.filter((action) => action.deferred).length;
      const unchanged = result.actions.filter((action) => action.skipped).length;
      const labels = result.actions
        .filter((action) => action.type === 'rename' && action.to)
        .map((action) => action.to)
        .slice(0, 4)
        .join(' · ');
      this.logger.info(
        `Tick #${tickIndex}${dryRun ? ' [dry run]' : ''}: ${applied} applicate, ${deferred} rimandate, ${unchanged} già a posto${labels ? ` → ${labels}` : ''}`,
      );

      if (manual && !this.state.running) {
        this.logger.info('Tick manuale completato (il loop è fermo).');
      }
      return result;
    } finally {
      this.state.busy = false;
      if (saved) this.store.save();
    }
  }

  #handleRateLimit(kind, key, err) {
    const status = err?.status ?? err?.httpStatus;
    const raw = err?.rawError?.retry_after;
    let waitMs = 0;
    if (typeof raw === 'number') waitMs = raw * 1000;
    else if (typeof err?.retryAfter === 'number') waitMs = err.retryAfter;
    else if (typeof err?.timeToReset === 'number') waitMs = err.timeToReset;
    if (status === 429 || waitMs > 0) {
      const blocked = clampPostRate(waitMs);
      this.limits[kind]?.block(key, Date.now() + blocked);
      this.logger.warn(`Rate limit Discord su ${kind}: pausa ${Math.round(blocked / 1000)}s.`);
    }
  }

  /** Burst di messaggi con spaziatura e limite per canale. */
  async burst({ text = '', count, gapMs, tick, force = false } = {}) {
    const cfg = this.store.data;
    const channel = cfg.channels.message;
    if (!channel) {
      this.logger.warn('Nessun canale messaggi configurato: burst ignorato.');
      return { sent: 0, total: 0 };
    }
    const frame = computeFrame(cfg, tick ?? this.state.tick);
    const content = String(text || frame.text || '').trim();
    if (!content) return { sent: 0, total: 0 };

    const dryRun = Boolean(cfg.loop.dryRun) && !force;
    const total = Math.min(25, Math.max(1, Math.round(Number(count ?? cfg.messages.repeat) || 1)));
    const gap = Math.min(60_000, Math.max(300, Math.round(Number(gapMs ?? cfg.messages.gapMs) || 1200)));
    const generation = this.generation;

    if (this.state.msgBusy) {
      this.logger.warn('Invio già in corso: burst accodato al prossimo giro.');
      return { sent: 0, total, queued: true };
    }
    this.state.msgBusy = true;
    let sent = 0;
    try {
      for (let index = 0; index < total; index += 1) {
        if (generation !== this.generation) break;
        while (!this.limits.send.take(channel.id)) {
          await sleep(600);
          if (generation !== this.generation) return { sent, total };
        }
        if (dryRun) {
          sent += 1;
        } else {
          try {
            await this.manager.send(channel.id, content, { allowMentions: cfg.messages.allowMentions });
            sent += 1;
            this.store.data.stats.messages += 1;
          } catch (err) {
            this.#handleRateLimit('send', channel.id, err);
            this.logger.error(`Invio messaggio fallito: ${err.message}`);
            break;
          }
        }
        if (index < total - 1) await sleep(gap);
      }
      this.store.save();
      const preview = content.length > 70 ? `${content.slice(0, 70)}…` : content;
      this.logger.success(
        `${dryRun ? '[DRY RUN] ' : ''}Inviati ${sent}/${total} messaggi in #${channel.name}: “${preview}”`,
      );
      return { sent, total };
    } finally {
      this.state.msgBusy = false;
    }
  }

  async sendNow({ text, count, gapMs } = {}) {
    if (!text || !String(text).trim()) throw new Error('Testo del messaggio mancante.');
    return this.burst({ text: String(text), count, gapMs, force: true });
  }

  /** Ripristina i nomi e l'ordine originali (panic button). */
  restore({ stopFirst = true } = {}) {
    const snapshot = this.store.data.snapshot;
    if (!snapshot?.channels?.length) throw new Error('Nessun nome originale salvato da ripristinare.');
    if (stopFirst) this.stop('ripristino');
    if (this.state.restore?.active) return this.restoreStatus();

    this.state.restore = {
      active: true,
      done: 0,
      total: snapshot.channels.length,
      startedAt: Date.now(),
      finishedAt: null,
      errors: [],
      queue: snapshot.channels.map((channel) => ({ ...channel })),
    };
    this.logger.info(`Ripristino avviato per ${snapshot.channels.length} canali…`);
    this.#restoreLoop(snapshot).catch((err) => {
      this.state.restore.active = false;
      this.logger.error(`Ripristino interrotto: ${err.message}`);
    });
    return this.restoreStatus();
  }

  async #restoreLoop(snapshot) {
    const restore = this.state.restore;
    let reorderDone = false;
    for (let round = 0; round < 60; round += 1) {
      const states = this.manager.channelStates();
      for (let index = restore.queue.length - 1; index >= 0; index -= 1) {
        const item = restore.queue[index];
        const state = states.get(item.id);
        if (!state) {
          restore.queue.splice(index, 1);
          restore.done += 1;
          continue;
        }
        if (state.name === item.name) {
          restore.queue.splice(index, 1);
          restore.done += 1;
          continue;
        }
        if (!this.limits.rename.take(item.id)) continue;
        try {
          await this.manager.renameChannel(item.id, item.name, 'Bot Nuke: ripristino');
          restore.queue.splice(index, 1);
          restore.done += 1;
        } catch (err) {
          this.#handleRateLimit('rename', item.id, err);
          restore.errors.push(err.message);
        }
        await sleep(600);
      }

      if (!restore.queue.length && !reorderDone) {
        const ordered = snapshot.channels.slice().sort((a, b) => a.position - b.position);
        if (ordered.length < 2) {
          reorderDone = true;
        } else if (this.limits.reorder.take('guild')) {
          try {
            await this.manager.reorder(ordered.map((channel) => ({ id: channel.id, position: channel.position })));
            reorderDone = true;
          } catch (err) {
            this.#handleRateLimit('reorder', 'guild', err);
          }
        }
      }

      if (!restore.queue.length && reorderDone) break;
      await sleep(RESTORE_ROUND_DELAY);
    }

    restore.active = false;
    restore.finishedAt = Date.now();
    if (!restore.queue.length) {
      this.store.update((data) => {
        if (data.snapshot) data.snapshot.restoredAt = new Date().toISOString();
      });
      this.logger.success('Ripristino completato: nomi e ordine originali ripristinati.');
    } else {
      this.logger.warn(
        `Ripristino incompleto: ${restore.queue.length} canali restano da sistemare (limite Discord di 2 modifiche / 10 minuti). Riprova più tardi.`,
      );
    }
  }

  restoreStatus() {
    const restore = this.state.restore;
    if (!restore) return null;
    return {
      active: restore.active,
      done: restore.done,
      total: restore.total,
      remaining: restore.queue?.length ?? 0,
      startedAt: restore.startedAt,
      finishedAt: restore.finishedAt,
      errors: restore.errors.slice(-5),
    };
  }

  status() {
    const cfg = this.store.data;
    const states = this.manager.channelStates();
    const channels = (cfg.channels.animated ?? []).map((channel) => {
      const state = states.get(channel.id);
      return {
        id: channel.id,
        name: state?.name ?? channel.name,
        remaining: this.limits.rename.remaining(channel.id),
        nextAt: this.limits.rename.nextAt(channel.id),
      };
    });
    return {
      running: this.state.running,
      busy: this.state.busy,
      tick: this.state.tick,
      nextAt: this.state.nextAt,
      nextMessageAt: this.state.nextMessageAt,
      startedAt: this.state.startedAt,
      lastError: this.state.lastError,
      last: this.state.last,
      pendingMessages: this.state.pending.length,
      dryRun: Boolean(cfg.loop.dryRun),
      intervalSec: cfg.loop.intervalSec,
      restore: this.restoreStatus(),
      budget: {
        channels,
        reorder: {
          remaining: this.limits.reorder.remaining('guild'),
          nextAt: this.limits.reorder.nextAt('guild'),
        },
        messages: {
          remaining: cfg.channels.message ? this.limits.send.remaining(cfg.channels.message.id) : 0,
        },
      },
      preview: computeFrame(cfg, this.state.tick),
    };
  }
}
