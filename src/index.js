import http from 'node:http';
import path from 'node:path';
import { Store } from './store.js';
import { Logger } from './logger.js';
import { Auth } from './auth.js';
import { DiscordManager } from './bot/discord.js';
import { MockManager } from './bot/mock.js';
import { Rotation } from './bot/rotation.js';
import { createApp } from './server.js';
import { toBool } from './util.js';

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const MOCK = toBool(process.env.MOCK_DISCORD, false);

const store = new Store(DATA_DIR);
const logger = new Logger();
const auth = new Auth({
  store,
  secret: store.secret(),
  secureCookies: toBool(process.env.COOKIE_SECURE, false),
});

if (!auth.hasPassword && process.env.DASHBOARD_PASSWORD) {
  try {
    auth.setPassword(process.env.DASHBOARD_PASSWORD);
    logger.info('Password iniziale impostata da DASHBOARD_PASSWORD.');
  } catch (err) {
    logger.warn(`DASHBOARD_PASSWORD ignorata: ${err.message}`);
  }
}

const manager = MOCK ? new MockManager({ logger }) : new DiscordManager({ logger });
const rotation = new Rotation({ store, manager, logger });
const app = createApp({ store, auth, manager, rotation, logger, mock: MOCK });

const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  logger.success(`Dashboard in ascolto su http://${HOST}:${PORT}${MOCK ? ' · MODALITÀ DEMO' : ''}`);
  logger.info(`Dati salvati in ${store.dir}`);
});

async function bootstrapBot() {
  if (MOCK) {
    try { await manager.connect({ guildId: store.data.bot.guildId }); } catch (err) { logger.error(err.message); }
    return;
  }
  const token = store.data.bot.token || process.env.DISCORD_TOKEN || '';
  if (!token) {
    logger.warn('Nessun token configurato: apri la dashboard e completa la configurazione guidata.');
    return;
  }
  try {
    await manager.connect({ token, guildId: store.data.bot.guildId });
  } catch (err) {
    logger.error(`Connessione iniziale non riuscita: ${err.message}`);
  }
}

bootstrapBot().then(async () => {
  if (store.data.loop.autoStart && store.data.setup.complete && manager.ready) {
    try {
      await rotation.start();
    } catch (err) {
      logger.error(`Avvio automatico del loop non riuscito: ${err.message}`);
    }
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Ricevuto ${signal}: chiusura in corso…`);
  try { rotation.stop('spegnimento'); } catch { /* ignore */ }
  try { await manager.disconnect(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.error(`Promise non gestita: ${err?.message ?? err}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Eccezione non gestita: ${err?.message ?? err}`);
});
