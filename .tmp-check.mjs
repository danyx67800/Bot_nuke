import { Client, GatewayIntentBits } from 'discord.js';
import { DiscordManager } from './src/bot/discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.guilds._add({ id: '100000000000000001', name: 'Server con icona', icon: 'a_0123456789abcdef0123456789abcdef' });
const guild = client.guilds.cache.get('100000000000000001');
console.log('size 128 ->', guild.iconURL({ size: 128, extension: 'png' }));

client.guilds.fetch = async () => client.guilds.cache;
const logger = { info(m) { console.log('[info]', m); }, warn(m) { console.log('[warn]', m); }, success() {}, error() {} };
const manager = new DiscordManager({ logger });
manager.client = client;
manager.guildId = '100000000000000001';
console.log('senza client.user ->', JSON.stringify(await manager.listGuilds()));

client.user = { id: '999', username: 'BotNuke', displayAvatarURL: () => 'x' };
guild.members.cache.set('999', { permissions: { has: () => true } });
console.log('con client.user ->', JSON.stringify(await manager.listGuilds()));
