import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import { channelTypeLabel } from './channels.js';

const REQUIRED_FLAGS = [
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
];

const PERMISSION_LABELS = {
  ManageChannels: 'Gestire i canali',
  ViewChannel: 'Vedere i canali',
  SendMessages: 'Inviare messaggi',
};

function permissionNames(bitfield) {
  const missing = [];
  for (const [name, flag] of Object.entries(PermissionsBitField.Flags)) {
    if (typeof flag !== 'bigint') continue;
    if (!REQUIRED_FLAGS.includes(flag)) continue;
    if (!bitfield.has(flag)) missing.push(PERMISSION_LABELS[name] ?? name);
  }
  return missing;
}

export class DiscordManager {
  constructor({ logger }) {
    this.logger = logger;
    this.mock = false;
    this.client = null;
    this.ready = false;
    this.guild = null;
    this.guildId = null;
    this.token = '';
    this.botUser = null;
    this.lastError = null;
    this.connectedAt = null;
    this.lastGuildCount = null;
  }

  get connected() {
    return Boolean(this.ready && this.client?.isReady?.());
  }

  get latency() {
    return this.client?.ws?.ping ?? null;
  }

  get id() {
    return this.client?.user?.id ?? null;
  }

  get tag() {
    return this.client?.user?.username ?? null;
  }

  avatarUrl(size = 128) {
    return this.client?.user?.displayAvatarURL?.({ size, extension: 'png' }) ?? null;
  }

  async connect({ token, guildId = null } = {}) {
    if (!token) throw new Error('Token mancante.');
    await this.disconnect();
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.client = client;

    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Timeout di connessione a Discord (40s). Verifica la rete del server.'));
      }, 40_000);
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      // discord.js >= 14.19 emette 'clientReady' ('ready' è deprecato e logga un warning).
      client.once('clientReady', succeed);
      client.once('error', fail);
    });

    client.on('error', (err) => this.logger.error(`Errore client Discord: ${err.message}`));
    client.on('rateLimit', (info) => {
      this.logger.warn(`Rate limit Discord (${info.route ?? 'rotta ignota'}): attesa ${Math.round((info.timeToReset ?? 0) / 1000)}s`);
    });
    client.on('disconnect', () => {
      this.ready = false;
      this.logger.warn('Connessione al gateway Discord persa.');
    });
    client.on('shardResume', () => {
      this.ready = true;
      this.logger.success('Gateway Discord riconnesso.');
    });
    // Serve a capire subito se l'invito è andato a buon fine.
    client.on('guildCreate', (guild) => {
      this.logger.success(`Bot aggiunto al server "${guild.name}" (${guild.id}).`);
    });
    client.on('guildDelete', (guild) => {
      this.logger.warn(`Bot rimosso dal server "${guild.name}" (${guild.id}).`);
    });

    try {
      await client.login(token);
      await ready;
    } catch (err) {
      this.lastError = err.message;
      await this.disconnect();
      throw new Error(`Connessione a Discord fallita: ${err.message}`);
    }

    this.ready = true;
    this.token = token;
    this.botUser = client.user;
    this.connectedAt = Date.now();
    this.logger.success(`Bot connesso come ${client.user.username} (${client.user.id})`);
    await this.resolveGuild(guildId);
    return this.status();
  }

  async disconnect() {
    this.ready = false;
    this.guild = null;
    this.botUser = null;
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        client.removeAllListeners();
        await client.destroy();
      } catch { /* ignore */ }
    }
  }

  async resolveGuild(guildId) {
    this.guild = null;
    this.guildId = guildId || null;
    if (!this.client || !guildId) return null;
    try {
      const guild = this.client.guilds.cache.get(guildId) ?? await this.client.guilds.fetch(guildId);
      await guild.channels.fetch();
      this.guild = guild;
      return guild;
    } catch (err) {
      this.logger.warn(`Server ${guildId} non accessibile: ${err.message}`);
      return null;
    }
  }

  async setGuild(guildId) {
    const guild = await this.resolveGuild(guildId);
    if (!guild) throw new Error('Il bot non è presente in quel server (o l\'ID non è valido).');
    return this.guildInfo();
  }

  async listGuilds() {
    if (!this.client) return [];
    try {
      await this.client.guilds.fetch();
    } catch (err) {
      this.logger.warn(`Impossibile elencare i server: ${err.message}`);
    }
    const guilds = [...this.client.guilds.cache.values()].map((guild) => {
      const me = guild.members?.me;
      const missing = me ? permissionNames(me.permissions) : null;
      return {
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL?.({ size: 96, extension: 'png' }) ?? null,
        memberCount: guild.memberCount ?? null,
        selected: guild.id === this.guildId,
        missing,
      };
    }).sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));

    // Log solo quando cambia: la dashboard interroga questo metodo ogni 3 secondi.
    if (guilds.length !== this.lastGuildCount) {
      this.lastGuildCount = guilds.length;
      this.logger.info(guilds.length
        ? `Server visibili al bot: ${guilds.length} (${guilds.map((guild) => guild.name).join(', ')})`
        : 'Il bot non è in nessun server: invitalo dal passo 2 della configurazione.');
    }
    return guilds;
  }

  async guildInfo() {
    if (!this.guild) return null;
    let missing = [];
    try {
      const me = this.guild.members.me ?? await this.guild.members.fetchMe();
      missing = permissionNames(me.permissions);
    } catch (err) {
      this.logger.warn(`Permessi non verificabili: ${err.message}`);
    }
    return {
      id: this.guild.id,
      name: this.guild.name,
      icon: this.guild.iconURL?.({ size: 96, extension: 'png' }) ?? null,
      memberCount: this.guild.memberCount ?? null,
      missing,
      permissionsOk: missing.length === 0,
    };
  }

  async fetchChannels(guildId = this.guildId) {
    if (!this.client || !guildId) return [];
    let guild = this.guild;
    if (!guild || guild.id !== guildId) {
      guild = this.client.guilds.cache.get(guildId) ?? await this.client.guilds.fetch(guildId);
    }
    await guild.channels.fetch();
    return [...guild.channels.cache.values()].map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      typeLabel: channelTypeLabel(channel.type),
      parentId: channel.parentId ?? null,
      parentName: channel.parent?.name ?? null,
      position: channel.rawPosition ?? channel.position ?? 0,
    })).sort((a, b) => a.position - b.position);
  }

  channelStates() {
    const map = new Map();
    if (!this.guild) return map;
    for (const channel of this.guild.channels.cache.values()) {
      map.set(channel.id, {
        id: channel.id,
        name: channel.name,
        position: channel.rawPosition ?? channel.position ?? 0,
        type: channel.type,
      });
    }
    return map;
  }

  async renameChannel(channelId, name, reason) {
    if (!this.guild) throw new Error('Server non selezionato.');
    const channel = this.guild.channels.cache.get(channelId)
      ?? await this.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error('Canale non trovato (è stato eliminato?).');
    await channel.setName(name, reason);
  }

  async reorder(positions) {
    if (!this.guild) throw new Error('Server non selezionato.');
    const payload = positions.map(({ id, position }) => ({ channel: id, position }));
    await this.guild.channels.setPositions(payload);
  }

  async send(channelId, content, { allowMentions = false } = {}) {
    if (!this.guild) throw new Error('Server non selezionato.');
    const channel = this.guild.channels.cache.get(channelId)
      ?? await this.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error('Canale messaggi non trovato.');
    if (!channel.isTextBased?.()) throw new Error('Il canale scelto non accetta messaggi di testo.');
    await channel.send({
      content,
      allowedMentions: allowMentions ? { parse: ['everyone', 'roles', 'users'] } : { parse: [] },
    });
  }

  inviteUrl(guildId) {
    const permissions = new PermissionsBitField(REQUIRED_FLAGS).bitfield.toString();
    const params = new URLSearchParams({
      client_id: this.id ?? '',
      scope: 'bot applications.commands',
      permissions,
    });
    if (guildId) {
      params.set('guild_id', guildId);
      params.set('disable_guild_select', 'true');
    }
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  status() {
    return {
      connected: this.connected,
      mock: false,
      id: this.id,
      tag: this.tag,
      avatar: this.avatarUrl(),
      latency: this.latency,
      connectedAt: this.connectedAt,
      inviteUrl: this.id ? this.inviteUrl(this.guildId) : null,
    };
  }
}
