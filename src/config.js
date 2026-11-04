import { isSnowflake } from './util.js';
import { normalizeChannelName } from './bot/channels.js';

export const NAME_MAX_LENGTH = 100;
export const MAX_ANIMATED_CHANNELS = 50;
export const MAX_VARIANTS = 30;
export const MAX_MESSAGES_PER_BURST = 25;
// Tetto di Discord per server: include canali testuali, vocali e categorie.
export const MAX_GUILD_CHANNELS = 500;

export function defaultConfig() {
  return {
    version: 1,
    auth: { passwordHash: null, salt: null, epoch: 0 },
    bot: { token: '', guildId: null, guildName: null },
    setup: { complete: false, updatedAt: null },
    channels: {
      animated: [],
      message: null,
    },
    rotation: {
      enabled: true,
      applyNames: true,
      applyOrder: true,
      names: {},
      shifts: [0, 1, 2],
    },
    messages: {
      enabled: true,
      mode: 'rotation',
      // 'all' = ogni canale di testo del server, 'one' = solo channels.message.
      target: 'all',
      texts: [],
      repeat: 3,
      gapMs: 1200,
      intervalSec: 60,
      allowMentions: false,
    },
    flood: {
      // Canali creati dal loop: nome = prefisso + numero progressivo.
      prefix: 'nuke-',
      intervalSec: 5,
      created: [],
    },
    loop: {
      intervalSec: 300,
      jitterSec: 15,
      dryRun: true,
      autoStart: false,
      reason: 'Bot Nuke — evento',
    },
    snapshot: null,
    stats: {
      ticks: 0,
      renames: 0,
      reorders: 0,
      messages: 0,
      created: 0,
      lastStartedAt: null,
      lastStoppedAt: null,
    },
  };
}

function intOr(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(max, Math.max(min, number)));
}

function stringList(value, { max, maxLength }) {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0)
    .slice(0, max)
    .map((item) => item.slice(0, maxLength));
}

/** Nome del prossimo canale creato: prefisso + numero progressivo. */
export function floodChannelName(prefix, index) {
  const base = String(prefix ?? '').trim() || 'nuke-';
  return normalizeChannelName(`${base}${Math.max(1, Math.round(Number(index) || 1))}`, 0).slice(0, 100);
}

/**
 * Valida e normalizza il payload inviato dalla dashboard.
 * Non lancia eccezioni: restituisce la lista di errori leggibili in UI.
 */
export function sanitizeConfig(input, current = defaultConfig()) {
  const errors = [];
  const cfg = structuredClone(current);

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Payload di configurazione non valido.'], config: cfg };
  }

  if (input.bot && typeof input.bot === 'object') {
    if (typeof input.bot.token === 'string' && input.bot.token.trim()) {
      const token = input.bot.token.trim();
      if (!/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/.test(token)) {
        errors.push('Il token del bot non ha un formato valido (tre parti separate da punto).');
      } else {
        cfg.bot.token = token;
      }
    }
    if (input.bot.guildId !== undefined) {
      if (input.bot.guildId === null || input.bot.guildId === '') {
        cfg.bot.guildId = null;
        cfg.bot.guildName = null;
      } else if (!isSnowflake(String(input.bot.guildId))) {
        errors.push('ID del server non valido.');
      } else {
        cfg.bot.guildId = String(input.bot.guildId);
      }
    }
    if (typeof input.bot.guildName === 'string') {
      cfg.bot.guildName = input.bot.guildName.slice(0, NAME_MAX_LENGTH);
    }
  }

  if (input.channels && typeof input.channels === 'object') {
    if (Array.isArray(input.channels.animated)) {
      const seen = new Set();
      const list = [];
      for (const item of input.channels.animated) {
        const id = String(item?.id ?? '');
        if (!isSnowflake(id) || seen.has(id)) continue;
        seen.add(id);
        list.push({
          id,
          name: String(item?.name ?? '').slice(0, NAME_MAX_LENGTH),
          type: Number.isFinite(Number(item?.type)) ? Number(item.type) : 0,
        });
      }
      if (list.length > MAX_ANIMATED_CHANNELS) {
        errors.push(`Puoi animare al massimo ${MAX_ANIMATED_CHANNELS} canali.`);
      }
      cfg.channels.animated = list.slice(0, MAX_ANIMATED_CHANNELS);
    }
    if (input.channels.message !== undefined) {
      const message = input.channels.message;
      if (!message || message.id === null || message.id === '') {
        cfg.channels.message = null;
      } else if (!isSnowflake(String(message.id))) {
        errors.push('Canale dei messaggi non valido.');
      } else {
        cfg.channels.message = {
          id: String(message.id),
          name: String(message.name ?? '').slice(0, NAME_MAX_LENGTH),
        };
      }
    }
  }

  if (input.rotation && typeof input.rotation === 'object') {
    const rotation = input.rotation;
    if (typeof rotation.enabled === 'boolean') cfg.rotation.enabled = rotation.enabled;
    if (typeof rotation.applyNames === 'boolean') cfg.rotation.applyNames = rotation.applyNames;
    if (typeof rotation.applyOrder === 'boolean') cfg.rotation.applyOrder = rotation.applyOrder;

    if (rotation.names && typeof rotation.names === 'object' && !Array.isArray(rotation.names)) {
      const names = {};
      for (const [channelId, value] of Object.entries(rotation.names)) {
        if (!isSnowflake(channelId)) continue;
        const list = stringList(value, { max: MAX_VARIANTS, maxLength: NAME_MAX_LENGTH });
        if (list && list.length) names[channelId] = list;
      }
      cfg.rotation.names = names;
    }

    if (Array.isArray(rotation.shifts)) {
      const shifts = rotation.shifts
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 60)
        .slice(0, 24);
      cfg.rotation.shifts = shifts.length ? shifts : [0];
    }
  }

  if (input.messages && typeof input.messages === 'object') {
    const messages = input.messages;
    if (typeof messages.enabled === 'boolean') cfg.messages.enabled = messages.enabled;
    if (['rotation', 'timer', 'off'].includes(messages.mode)) cfg.messages.mode = messages.mode;
    if (['all', 'one'].includes(messages.target)) cfg.messages.target = messages.target;

    if (Array.isArray(messages.texts)) {
      const texts = messages.texts
        .map((text) => String(text ?? '').trim())
        .filter(Boolean)
        .slice(0, 50)
        .map((text) => text.slice(0, 1900));
      cfg.messages.texts = texts;
    }
    if (messages.repeat !== undefined) {
      cfg.messages.repeat = intOr(messages.repeat, 3, 1, MAX_MESSAGES_PER_BURST);
    }
    if (messages.gapMs !== undefined) {
      cfg.messages.gapMs = intOr(messages.gapMs, 1200, 300, 60_000);
    }
    if (messages.intervalSec !== undefined) {
      cfg.messages.intervalSec = intOr(messages.intervalSec, 60, 5, 3600);
    }
    if (typeof messages.allowMentions === 'boolean') cfg.messages.allowMentions = messages.allowMentions;
  }

  if (input.flood && typeof input.flood === 'object') {
    const flood = input.flood;
    if (typeof flood.prefix === 'string') {
      const prefix = flood.prefix
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/, '')
        .slice(0, 60);
      cfg.flood.prefix = prefix || 'nuke-';
    }
    if (flood.intervalSec !== undefined) {
      cfg.flood.intervalSec = intOr(flood.intervalSec, 5, 1, 3600);
    }
  }

  if (input.loop && typeof input.loop === 'object') {
    const loop = input.loop;
    if (loop.intervalSec !== undefined) {
      cfg.loop.intervalSec = intOr(loop.intervalSec, 300, 30, 86_400);
    }
    if (loop.jitterSec !== undefined) {
      cfg.loop.jitterSec = intOr(loop.jitterSec, 0, 0, 120);
    }
    if (typeof loop.dryRun === 'boolean') cfg.loop.dryRun = loop.dryRun;
    if (typeof loop.autoStart === 'boolean') cfg.loop.autoStart = loop.autoStart;
    if (typeof loop.reason === 'string') cfg.loop.reason = loop.reason.slice(0, 512);
  }

  return { ok: errors.length === 0, errors, config: cfg };
}

/** Controlli bloccanti prima di dichiarare la configurazione completa. */
export function validateForComplete(cfg, { hasToken = Boolean(cfg.bot.token) } = {}) {
  const errors = [];
  if (!hasToken) errors.push('Token del bot mancante.');
  if (!cfg.bot.guildId) errors.push('Nessun server selezionato.');
  if (!cfg.channels.animated.length) errors.push('Seleziona almeno un canale da animare.');

  if (cfg.rotation.enabled && cfg.rotation.applyNames) {
    for (const channel of cfg.channels.animated) {
      const variants = cfg.rotation.names[channel.id] ?? [];
      if (!variants.length) {
        errors.push(`Aggiungi almeno un nome per il canale "${channel.name}".`);
      }
    }
  }

  if (cfg.messages.enabled && cfg.messages.mode !== 'off') {
    if (!cfg.messages.texts.length) errors.push('Scrivi almeno un messaggio da inviare.');
    // Con la destinazione "tutti i canali" non serve sceglierne uno.
    if (cfg.messages.target === 'one' && !cfg.channels.message) {
      errors.push('Seleziona il canale dove inviare i messaggi.');
    }
  }

  if (cfg.rotation.applyOrder && cfg.channels.animated.length < 2) {
    // Non è un errore: senza almeno 2 canali l'ordine non può cambiare.
  }

  return errors;
}

/** Configurazione senza segreti, destinata al browser. */
export function publicConfig(cfg) {
  const { auth, bot, snapshot, ...rest } = cfg;
  return {
    ...rest,
    bot: { guildId: bot.guildId, guildName: bot.guildName, tokenSet: Boolean(bot.token) },
    snapshot: snapshot
      ? { takenAt: snapshot.takenAt, channels: snapshot.channels.length, restoredAt: snapshot.restoredAt ?? null }
      : null,
  };
}

/** Back-up esportabile: nessun token, nessun hash password. */
export function exportConfig(cfg) {
  const clean = publicConfig(cfg);
  return { ...clean, exportedAt: new Date().toISOString() };
}
