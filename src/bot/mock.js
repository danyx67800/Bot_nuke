import { normalizeChannelName, channelTypeLabel } from './channels.js';

const DEMO_GUILD_ID = '100000000000000001';

function demoChannels() {
  return [
    { id: '100000000000000101', name: 'INFO', type: 4, position: 0, parentId: null },
    { id: '100000000000000102', name: '📢-annunci', type: 0, position: 1, parentId: '100000000000000101' },
    { id: '100000000000000103', name: '💬-chat', type: 0, position: 2, parentId: '100000000000000101' },
    { id: '100000000000000104', name: '🎉-festa', type: 0, position: 3, parentId: '100000000000000101' },
    { id: '100000000000000105', name: '🔥-hype', type: 0, position: 4, parentId: null },
    { id: '100000000000000106', name: 'Sala principale', type: 2, position: 5, parentId: null },
    { id: '100000000000000107', name: 'Musica', type: 2, position: 6, parentId: null },
  ];
}

/**
 * Adapter finto: stessa interfaccia di DiscordManager, nessuna chiamata a Discord.
 * Si attiva con MOCK_DISCORD=1 e serve per provare dashboard e loop senza token.
 */
export class MockManager {
  constructor({ logger }) {
    this.logger = logger;
    this.mock = true;
    this.ready = false;
    this.guildId = null;
    this.channels = demoChannels();
    this.sent = [];
    this.connectedAt = null;
    this.changes = 0;
  }

  get connected() { return this.ready; }
  get latency() { return 12; }
  get id() { return '999999999999999999'; }
  get tag() { return 'BotNuke (demo)'; }

  avatarUrl() { return null; }

  async connect({ guildId = null } = {}) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    this.ready = true;
    this.guildId = guildId ?? this.guildId;
    this.connectedAt = Date.now();
    this.logger.success('Modalità DEMO attiva: nessuna richiesta reale a Discord.');
    return this.status();
  }

  async disconnect() {
    this.ready = false;
  }

  async setGuild(guildId) {
    if (guildId !== DEMO_GUILD_ID) throw new Error('In modalità demo esiste un solo server.');
    this.guildId = guildId;
    return this.guildInfo();
  }

  async resolveGuild(guildId) { this.guildId = guildId || null; return this.guildInfo(); }

  async listGuilds() {
    return [{
      id: DEMO_GUILD_ID,
      name: 'Server Demo — Bot Nuke',
      icon: null,
      memberCount: 128,
      selected: this.guildId === DEMO_GUILD_ID,
      missing: [],
    }];
  }

  async guildInfo() {
    return {
      id: DEMO_GUILD_ID,
      name: 'Server Demo — Bot Nuke',
      icon: null,
      memberCount: 128,
      missing: [],
      permissionsOk: true,
    };
  }

  async fetchChannels() {
    return this.channels
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        typeLabel: channelTypeLabel(channel.type),
        parentId: channel.parentId,
        parentName: null,
        position: channel.position,
      }));
  }

  channelStates() {
    const map = new Map();
    for (const channel of this.channels) {
      map.set(channel.id, {
        id: channel.id,
        name: channel.name,
        position: channel.position,
        type: channel.type,
      });
    }
    return map;
  }

  async renameChannel(channelId, name) {
    const channel = this.channels.find((item) => item.id === channelId);
    if (!channel) throw new Error('Canale non trovato (demo).');
    channel.name = normalizeChannelName(name, channel.type);
    this.changes += 1;
  }

  async reorder(positions) {
    for (const { id, position } of positions) {
      const channel = this.channels.find((item) => item.id === id);
      if (channel) channel.position = position;
    }
    this.changes += 1;
  }

  async send(channelId, content) {
    const channel = this.channels.find((item) => item.id === channelId);
    if (!channel) throw new Error('Canale non trovato (demo).');
    this.sent.push({ channelId, channelName: channel.name, content, at: Date.now() });
    if (this.sent.length > 200) this.sent.shift();
  }

  /** In demo tutti i canali di testo accettano messaggi. */
  sendableChannels() {
    return this.channels
      .filter((channel) => channel.type === 0 || channel.type === 5)
      .map((channel) => ({ id: channel.id, name: channel.name }));
  }

  inviteUrl() { return null; }

  status() {
    return {
      connected: this.ready,
      mock: true,
      id: this.id,
      tag: this.tag,
      avatar: null,
      latency: this.latency,
      connectedAt: this.connectedAt,
      inviteUrl: null,
    };
  }
}

export { DEMO_GUILD_ID };
