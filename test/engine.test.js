import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindow } from '../src/bot/limiter.js';
import { computeFrame } from '../src/bot/frame.js';
import { renderText } from '../src/bot/render.js';
import { normalizeChannelName } from '../src/bot/channels.js';
import { sanitizeConfig, validateForComplete, defaultConfig } from '../src/config.js';

test('SlidingWindow permette 2 azioni ogni 10 minuti e poi blocca', () => {
  const window = new SlidingWindow(2, 600_000);
  const start = 1_000_000;
  assert.equal(window.take('a', start), true);
  assert.equal(window.take('a', start + 1000), true);
  assert.equal(window.take('a', start + 2000), false);
  // La più vecchia scade dopo 10 minuti
  assert.equal(window.take('a', start + 600_001), true);
  // Chiavi diverse hanno budget indipendente
  assert.equal(window.take('b', start), true);
});

test('SlidingWindow rispetta i blocchi da rate limit', () => {
  const window = new SlidingWindow(2, 600_000);
  const now = 5_000_000;
  window.block('a', now + 30_000);
  assert.equal(window.take('a', now), false);
  assert.equal(window.nextAt('a', now), now + 30_000);
  assert.equal(window.take('a', now + 30_001), true);
});

test('computeFrame cicla nomi, shift e messaggi', () => {
  const cfg = defaultConfig();
  const channelA = '100000000000000001';
  const channelB = '100000000000000002';
  cfg.channels.animated = [
    { id: channelA, name: 'uno', type: 0 },
    { id: channelB, name: 'due', type: 0 },
  ];
  // Chiavi calcolate: gli snowflake superano 2^53, un literal numerico perderebbe precisione.
  cfg.rotation.names = {
    [channelA]: ['🔥-{n}', '💥-{n}'],
    [channelB]: ['🎉-festa'],
  };
  cfg.rotation.shifts = [0, 1];
  cfg.messages.texts = ['A {n}', 'B {n}'];

  const first = computeFrame(cfg, 0);
  assert.equal(first.names[0].name, '🔥-1');
  assert.equal(first.names[1].name, '🎉-festa');
  assert.equal(first.shift, 0);
  assert.equal(first.text, 'A 1');

  const second = computeFrame(cfg, 1);
  assert.equal(second.names[0].name, '💥-2');
  assert.equal(second.shift, 1);
  assert.equal(second.text, 'B 2');

  const third = computeFrame(cfg, 2);
  assert.equal(third.names[0].name, '🔥-3');
  assert.equal(third.shift, 0);
});

test('computeFrame gestisce configurazioni vuote senza errori', () => {
  const frame = computeFrame(defaultConfig(), 4);
  assert.deepEqual(frame.names, []);
  assert.equal(frame.shift, 0);
  assert.equal(frame.text, '');
});

test('renderText sostituisce i template', () => {
  const now = new Date('2026-11-03T09:05:00');
  assert.equal(renderText('{n} · {tick} · {time} · {date}', { n: 3, tick: 2, now }), '3 · 2 · 09:05 · 03/11');
  const random = renderText('{rand:si|no}', {});
  assert.ok(['si', 'no'].includes(random));
  assert.equal(renderText('nessun template', {}), 'nessun template');
});

test('normalizeChannelName imita la normalizzazione di Discord', () => {
  assert.equal(normalizeChannelName('  Festa  Di  Nuke ', 0), 'festa-di-nuke');
  assert.equal(normalizeChannelName('Sala Principale', 2), 'Sala Principale');
  assert.equal(normalizeChannelName('x'.repeat(200), 0).length, 100);
});

test('sanitizeConfig accetta una configurazione valida', () => {
  const guildId = '100000000000000001';
  const channelId = '100000000000000002';
  const payload = {
    bot: { guildId },
    channels: {
      animated: [{ id: channelId, name: 'chat', type: 0 }],
      message: { id: channelId, name: 'chat' },
    },
    rotation: { names: { [channelId]: ['🔥-{n}'] }, shifts: [0, 1, 2] },
    messages: { texts: ['ciao'], repeat: 3, gapMs: 1200 },
    loop: { intervalSec: 300, jitterSec: 10, dryRun: true },
  };
  const result = sanitizeConfig(payload, defaultConfig());
  assert.equal(result.ok, true);
  assert.equal(result.config.rotation.names[channelId].length, 1);
  assert.deepEqual(result.config.rotation.shifts, [0, 1, 2]);
  assert.equal(result.errors.length, 0);
});

test('sanitizeConfig rifiuta token e ID non validi', () => {
  const result = sanitizeConfig({ bot: { token: 'nope', guildId: 'abc' }, channels: { animated: [{ id: 'x' }] } }, defaultConfig());
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('token')));
  assert.equal(result.config.channels.animated.length, 0);
});

test('sanitizeConfig limita i valori fuori range', () => {
  const result = sanitizeConfig({
    messages: { repeat: 500, gapMs: 1, intervalSec: 0 },
    loop: { intervalSec: 1, jitterSec: 9999 },
  }, defaultConfig());
  assert.equal(result.config.messages.repeat, 25);
  assert.equal(result.config.messages.gapMs, 300);
  assert.equal(result.config.messages.intervalSec, 5);
  assert.equal(result.config.loop.intervalSec, 30);
  assert.equal(result.config.loop.jitterSec, 120);
});

test('validateForComplete segnala cosa manca', () => {
  const cfg = defaultConfig();
  const errors = validateForComplete(cfg, { hasToken: false });
  assert.ok(errors.some((error) => error.includes('Token')));
  assert.ok(errors.some((error) => error.includes('server')));

  const guildId = '100000000000000001';
  const channelId = '100000000000000002';
  cfg.bot.guildId = guildId;
  cfg.channels.animated = [{ id: channelId, name: 'chat', type: 0 }];
  cfg.channels.message = { id: channelId, name: 'chat' };
  cfg.messages.texts = ['ciao'];
  cfg.rotation.names = { [channelId]: ['🔥-{n}'] };
  assert.deepEqual(validateForComplete(cfg, { hasToken: true }), []);
});

test('di default i messaggi vanno in tutti i canali di testo', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.messages.target, 'all');

  cfg.bot.guildId = '100000000000000001';
  cfg.channels.animated = [{ id: '100000000000000002', name: 'chat', type: 0 }];
  cfg.rotation.names = { '100000000000000002': ['🔥-{n}'] };
  cfg.messages.texts = ['ciao'];
  // Nessun canale scelto: con "tutti" la configurazione è comunque completa.
  assert.deepEqual(validateForComplete(cfg, { hasToken: true }), []);

  cfg.messages.target = 'one';
  const errors = validateForComplete(cfg, { hasToken: true });
  assert.ok(errors.some((error) => error.includes('canale')));
});

test('sanitizeConfig conserva la destinazione dei messaggi', () => {
  assert.equal(sanitizeConfig({ messages: { target: 'one' } }, defaultConfig()).config.messages.target, 'one');
  assert.equal(sanitizeConfig({ messages: { target: 'all' } }, defaultConfig()).config.messages.target, 'all');
  assert.equal(sanitizeConfig({ messages: { target: 'x' } }, defaultConfig()).config.messages.target, 'all');
});

test('sanitizeConfig normalizza prefisso e intervallo della creazione canali', () => {
  const result = sanitizeConfig({ flood: { prefix: '  Nuke  Party', intervalSec: 0 } }, defaultConfig());
  assert.equal(result.config.flood.prefix, 'Nuke-Party');
  assert.equal(result.config.flood.intervalSec, 1);
  // Il trattino finale è il separatore tra prefisso e numero: non va perso.
  assert.equal(sanitizeConfig({ flood: { prefix: 'caos-' } }, defaultConfig()).config.flood.prefix, 'caos-');
  assert.equal(sanitizeConfig({ flood: { prefix: '' } }, defaultConfig()).config.flood.prefix, 'nuke-');
  assert.equal(sanitizeConfig({ flood: { intervalSec: 99_999 } }, defaultConfig()).config.flood.intervalSec, 3600);
});

test('MockManager elenca i canali di testo in cui scrivere', async () => {
  const { MockManager } = await import('../src/bot/mock.js');
  const logger = { info() {}, warn() {}, success() {}, error() {} };
  const manager = new MockManager({ logger });
  await manager.connect({});
  const channels = manager.sendableChannels();
  assert.equal(channels.length, 4);
  assert.ok(channels.every((channel) => channel.id && channel.name));
});

function memoryStore(config) {
  return {
    data: config,
    update(mutator) {
      mutator(this.data);
      return this.data;
    },
    save() {},
  };
}

test('Rotation crea canali in loop, si ferma al tetto e li elimina col ripristino', async () => {
  const { Rotation } = await import('../src/bot/rotation.js');
  const { MockManager, DEMO_GUILD_ID } = await import('../src/bot/mock.js');
  const logger = { info() {}, warn() {}, success() {}, error() {} };
  const manager = new MockManager({ logger });
  await manager.connect({});

  const cfg = defaultConfig();
  cfg.bot.guildId = DEMO_GUILD_ID;
  cfg.loop.dryRun = false;
  cfg.flood = { prefix: 'nuke-', intervalSec: 0.1, created: [] };
  const store = memoryStore(cfg);
  const base = manager.channels.length;
  const rotation = new Rotation({ store, manager, logger, channelLimit: base + 2 });

  await rotation.startFlood();
  assert.equal(rotation.status().flood.running, true);
  await new Promise((resolve) => setTimeout(resolve, 900));

  // Tetto raggiunto: il loop si ferma da solo.
  assert.equal(rotation.status().flood.running, false);
  const created = store.data.flood.created;
  assert.deepEqual(created.map((item) => item.name), ['nuke-1', 'nuke-2']);
  assert.equal(store.data.stats.created, 2);
  assert.equal(manager.channels.length, base + 2);

  // Panic: i canali creati vengono eliminati.
  rotation.restore({ stopFirst: false });
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(manager.channels.length, base);
  assert.equal(store.data.flood.created.length, 0);
});

test('con il dry run la creazione non tocca Discord', async () => {
  const { Rotation } = await import('../src/bot/rotation.js');
  const { MockManager, DEMO_GUILD_ID } = await import('../src/bot/mock.js');
  const logger = { info() {}, warn() {}, success() {}, error() {} };
  const manager = new MockManager({ logger });
  await manager.connect({});

  const cfg = defaultConfig();
  cfg.bot.guildId = DEMO_GUILD_ID;
  cfg.loop.dryRun = true;
  cfg.flood = { prefix: 'nuke-', intervalSec: 0.1, created: [] };
  const store = memoryStore(cfg);
  const base = manager.channels.length;
  const rotation = new Rotation({ store, manager, logger, channelLimit: base + 5 });

  await rotation.startFlood();
  await new Promise((resolve) => setTimeout(resolve, 350));
  rotation.stopFlood('test');

  assert.equal(manager.channels.length, base);
  assert.equal(store.data.flood.created.length, 0);
  assert.equal(rotation.status().flood.created, 0);
});
