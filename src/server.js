import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicConfig, sanitizeConfig, validateForComplete, exportConfig } from './config.js';
import { computeFrame } from './bot/frame.js';
import { isSnowflake, maskToken } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const VERSION = '1.0.0';

function originGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const parsed = new URL(origin);
    if (req.headers.host && parsed.host === req.headers.host) return next();
    const allowed = String(process.env.PUBLIC_ORIGIN ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (allowed.includes(origin)) return next();
  } catch { /* origine malformata: blocca */ }
  return res.status(403).json({ error: 'Origine della richiesta non consentita.' });
}

export function createApp({ store, auth, manager, rotation, logger, mock }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '512kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'self'",
    ].join('; '));
    next();
  });

  const api = express.Router();
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const requireAuth = (req, res, next) => {
    if (!auth.hasPassword) {
      return res.status(428).json({ error: 'Dashboard non ancora inizializzata: imposta la password.' });
    }
    if (!auth.isAuthenticated(req)) {
      return res.status(401).json({ error: 'Sessione scaduta. Effettua di nuovo il login.' });
    }
    return next();
  };

  async function buildState() {
    const cfg = store.data;
    const botStatus = manager.status();
    let guild = null;
    let channels = [];
    let guilds = [];
    if (manager.ready) {
      try { guild = await manager.guildInfo(); } catch { guild = null; }
      if (cfg.bot.guildId) {
        try { channels = await manager.fetchChannels(cfg.bot.guildId); } catch { channels = []; }
      }
      try { guilds = await manager.listGuilds(); } catch { guilds = []; }
    }
    return {
      version: VERSION,
      mock,
      auth: { hasPassword: auth.hasPassword },
      bot: {
        ...botStatus,
        guild,
        guildId: cfg.bot.guildId,
        guildName: cfg.bot.guildName,
        tokenSet: Boolean(cfg.bot.token || process.env.DISCORD_TOKEN),
        tokenPreview: maskToken(cfg.bot.token || process.env.DISCORD_TOKEN),
      },
      guilds,
      channels,
      config: publicConfig(cfg),
      runtime: rotation.status(),
      logs: logger.tail(80),
    };
  }

  // ---------- Pubblici ----------
  api.get('/health', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), version: VERSION, mock });
  });

  api.get('/auth/status', (req, res) => {
    res.json({
      hasPassword: auth.hasPassword,
      authenticated: auth.isAuthenticated(req),
      mock,
      version: VERSION,
    });
  });

  api.post('/auth/setup', (req, res) => {
    if (auth.hasPassword) return res.status(409).json({ error: 'Password già impostata.' });
    if (!auth.attemptAllowed(req.ip)) {
      return res.status(429).json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' });
    }
    try {
      const cookie = auth.setPassword(req.body?.password);
      res.setHeader('Set-Cookie', cookie);
      logger.success('Dashboard inizializzata: password impostata.');
      return res.json({ ok: true });
    } catch (err) {
      auth.noteFailure(req.ip);
      return res.status(400).json({ error: err.message });
    }
  });

  api.post('/auth/login', (req, res) => {
    if (!auth.hasPassword) return res.status(428).json({ error: 'Imposta prima la password della dashboard.' });
    if (!auth.attemptAllowed(req.ip)) {
      return res.status(429).json({ error: 'Troppi tentativi falliti. Riprova tra 5 minuti.' });
    }
    if (!auth.verify(req.body?.password)) {
      auth.noteFailure(req.ip);
      logger.warn(`Tentativo di login fallito da ${req.ip}`);
      return res.status(401).json({ error: 'Password errata.' });
    }
    auth.noteSuccess(req.ip);
    res.setHeader('Set-Cookie', auth.issueCookie());
    return res.json({ ok: true });
  });

  api.post('/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', auth.clearCookie());
    res.json({ ok: true });
  });

  // ---------- Da qui in poi serve la sessione ----------
  api.use(requireAuth);
  api.use(originGuard);

  api.get('/state', async (req, res) => {
    res.json(await buildState());
  });

  api.post('/bot/token', async (req, res) => {
    const token = String(req.body?.token ?? '').trim();
    if (manager.mock) {
      await manager.connect({ guildId: store.data.bot.guildId });
      return res.json({ ok: true, bot: manager.status(), guilds: await manager.listGuilds() });
    }
    if (!token) return res.status(400).json({ error: 'Token mancante.' });

    const previousToken = store.data.bot.token;
    const wasConnected = manager.ready;
    try {
      await manager.connect({ token, guildId: store.data.bot.guildId });
    } catch (err) {
      if (wasConnected && previousToken) {
        try { await manager.connect({ token: previousToken, guildId: store.data.bot.guildId }); } catch { /* ignore */ }
      }
      return res.status(400).json({ error: err.message });
    }

    store.update((cfg) => { cfg.bot.token = token; });
    logger.success('Token del bot salvato.');
    return res.json({ ok: true, bot: manager.status(), guilds: await manager.listGuilds() });
  });

  api.post('/bot/guild', async (req, res) => {
    const guildId = String(req.body?.guildId ?? '');
    if (!isSnowflake(guildId)) return res.status(400).json({ error: 'ID server non valido.' });
    try {
      const guild = await manager.setGuild(guildId);
      store.update((cfg) => {
        cfg.bot.guildId = guildId;
        cfg.bot.guildName = guild?.name ?? null;
      });
      const channels = await manager.fetchChannels(guildId);
      logger.info(`Server selezionato: ${guild?.name ?? guildId}`);
      return res.json({ ok: true, guild, channels });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  api.get('/bot/guilds', async (req, res) => {
    res.json({ guilds: await manager.listGuilds() });
  });

  api.get('/bot/channels', async (req, res) => {
    const guildId = String(req.query.guildId ?? store.data.bot.guildId ?? '');
    if (!isSnowflake(guildId)) return res.status(400).json({ error: 'ID server non valido.' });
    try {
      res.json({ channels: await manager.fetchChannels(guildId) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/preview', (req, res) => {
    const { config, ticks } = req.body ?? {};
    const sanitized = sanitizeConfig(config ?? {}, store.data);
    const count = Math.max(1, Math.min(20, Number(ticks) || 6));
    const base = Number(req.body?.fromTick);
    const start = Number.isFinite(base) ? Math.max(0, base) : rotation.state.tick;
    const frames = [];
    for (let index = 0; index < count; index += 1) {
      frames.push(computeFrame(sanitized.config, start + index));
    }
    res.json({ ok: true, errors: sanitized.errors, frames, start });
  });

  api.post('/config', (req, res) => {
    const { config } = req.body ?? {};
    const result = sanitizeConfig(config ?? {}, store.data);
    if (!result.ok) return res.status(400).json({ error: result.errors[0], errors: result.errors });
    const next = result.config;
    store.update((cfg) => {
      cfg.channels = next.channels;
      cfg.rotation = next.rotation;
      cfg.messages = next.messages;
      cfg.loop = next.loop;
      cfg.bot.guildId = next.bot.guildId ?? cfg.bot.guildId;
      cfg.bot.guildName = next.bot.guildName ?? cfg.bot.guildName;
    });
    logger.info('Configurazione aggiornata.');
    res.json({ ok: true, config: publicConfig(store.data) });
  });

  api.post('/setup/complete', async (req, res) => {
    const { config, start } = req.body ?? {};
    const result = sanitizeConfig(config ?? {}, store.data);
    const hasToken = Boolean(result.config.bot.token || process.env.DISCORD_TOKEN || manager.mock);
    const blocking = [...result.errors, ...validateForComplete(result.config, { hasToken })];
    if (blocking.length) {
      return res.status(400).json({ error: blocking[0], errors: blocking });
    }
    const next = result.config;
    store.update((cfg) => {
      cfg.channels = next.channels;
      cfg.rotation = next.rotation;
      cfg.messages = next.messages;
      cfg.loop = next.loop;
      cfg.bot.guildId = next.bot.guildId ?? cfg.bot.guildId;
      cfg.bot.guildName = next.bot.guildName ?? cfg.bot.guildName;
      cfg.setup = { complete: true, updatedAt: new Date().toISOString() };
    });
    logger.success('Configurazione completata.');

    if (start) {
      try {
        await rotation.start();
      } catch (err) {
        return res.status(400).json({ error: `Configurazione salvata, ma il loop non è partito: ${err.message}`, saved: true });
      }
    }
    return res.json({ ok: true, state: await buildState() });
  });

  api.post('/control', async (req, res) => {
    const action = String(req.body?.action ?? '');
    try {
      switch (action) {
        case 'start':
          await rotation.start();
          break;
        case 'stop':
          rotation.stop('dalla dashboard');
          break;
        case 'tick':
          if (!store.data.setup.complete) throw new Error('Completa prima la configurazione.');
          await rotation.runTick({ manual: true });
          break;
        case 'restore':
          rotation.restore({ stopFirst: true });
          break;
        case 'panic':
          rotation.stop('panic button');
          rotation.restore({ stopFirst: false });
          break;
        case 'snapshot':
          await rotation.takeSnapshot(true);
          break;
        default:
          return res.status(400).json({ error: 'Azione sconosciuta.' });
      }
      return res.json({ ok: true, runtime: rotation.status() });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  api.post('/control/send', async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'Scrivi il messaggio da inviare.' });
    if (!store.data.channels.message) {
      return res.status(400).json({ error: 'Nessun canale messaggi configurato.' });
    }
    if (!manager.ready) return res.status(400).json({ error: 'Il bot non è connesso.' });
    const count = Math.max(1, Math.min(25, Number(req.body?.count) || 1));
    const gapMs = Math.max(300, Math.min(60_000, Number(req.body?.gapMs) || store.data.messages.gapMs));
    rotation.sendNow({ text, count, gapMs }).catch((err) => {
      logger.error(`Invio manuale fallito: ${err.message}`);
    });
    return res.json({ ok: true, queued: true, count });
  });

  api.get('/logs', (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 120));
    res.json({ logs: logger.tail(limit) });
  });

  api.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

    const onLog = (entry) => {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    };
    logger.on('log', onLog);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      logger.off('log', onLog);
    });
  });

  api.get('/export', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="bot-nuke-config.json"');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(exportConfig(store.data), null, 2));
  });

  api.post('/import', (req, res) => {
    const payload = req.body?.config ?? req.body;
    const result = sanitizeConfig(payload, store.data);
    if (!result.ok) return res.status(400).json({ error: result.errors[0], errors: result.errors });
    const next = result.config;
    store.update((cfg) => {
      cfg.channels = next.channels;
      cfg.rotation = next.rotation;
      cfg.messages = next.messages;
      cfg.loop = next.loop;
      if (next.bot.guildId) cfg.bot.guildId = next.bot.guildId;
    });
    logger.success('Configurazione importata.');
    return res.json({ ok: true });
  });

  api.post('/password', (req, res) => {
    const current = String(req.body?.current ?? '');
    const next = String(req.body?.next ?? '');
    if (!auth.verify(current)) return res.status(401).json({ error: 'Password attuale errata.' });
    try {
      const cookie = auth.setPassword(next);
      res.setHeader('Set-Cookie', cookie);
      logger.info('Password della dashboard aggiornata.');
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.use('/api', api);

  // Sempre rivalidati: dopo un aggiornamento dell'immagine la dashboard non resta in cache vecchia.
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0, etag: true }));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint inesistente.' });
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'JSON non valido.' });
    }
    logger.error(`Errore HTTP ${req.method} ${req.path}: ${err?.message ?? err}`);
    return res.status(500).json({ error: 'Errore interno del server.' });
  });

  return app;
}
