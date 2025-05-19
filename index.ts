import { Client, GatewayIntentBits, Interaction, TextChannel, Message } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();
import { TornFactionMembersResponse, TornFactionMember } from './types';
import cron from 'node-cron';
import { sequelize, syncDb, Config, User, Alert } from './db';

// --- CONFIGURATION ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
if (!DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN not set in .env');
    process.exit(1);
}
const TORN_API_KEY = process.env.TORN_API_KEY || '';

// --- DB INIT ---
syncDb();

// --- Discord Client Setup ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });


// --- Torn API Fetch ---
async function fetchTornFactionMembers(apiKey: string): Promise<TornFactionMembersResponse | null> {
    try {
        const res = await fetch('https://api.torn.com/v2/faction/members?key=' + apiKey);
        if (!res.ok) throw new Error('Failed to fetch Torn API');
        return (await res.json()) as TornFactionMembersResponse;
    } catch (err) {
        console.error('Torn API fetch error:', err);
        return null;
    }
}

// --- OC Update Logic ---
async function runOcUpdate() {
    let apiKey = TORN_API_KEY;
    if (!apiKey) {
        // Fallback to DB if not set in env
        const keyRow = await Config.findByPk('torn_api_key');
        apiKey = keyRow?.value || '';
    }
    if (!apiKey) {
        console.warn('No Torn API key set. Skipping OC check.');
        return;
    }
    // Get update channel from config
    const channelConfig = await Config.findByPk('update_channel');
    if (!channelConfig) {
        console.log('Update channel not set.');
        return;
    }
    const channelId = channelConfig.value;
    const data = await fetchTornFactionMembers(apiKey);
    if (!data) return;

    // Import users on first fetch
    const nowTs = Math.floor(Date.now() / 1000);
    const usersImported = await User.count();
    if (!usersImported) {
        for (const member of data.members) {
            await User.upsert({
                id: member.id,
                name: member.name,
                last_action_timestamp: member.last_action.timestamp,
                last_action_status: member.last_action.status,
                is_in_oc: !!member.is_in_oc,
                not_in_oc_since: !member.is_in_oc ? nowTs : null,
            });
        }
        console.log('Imported users from Torn API.');
    } else {
        // Update users and not_in_oc_since logic
            for (const member of data.members) {
                const dbRow = await User.findByPk(member.id);
                if (!member.is_in_oc) {
                    if (!dbRow || !dbRow.not_in_oc_since) {
                        // Mark the time they went out of OC
                        await User.upsert({
                            id: member.id,
                            name: member.name,
                            last_action_timestamp: member.last_action.timestamp,
                            last_action_status: member.last_action.status,
                            is_in_oc: !!member.is_in_oc,
                            not_in_oc_since: nowTs,
                        });
                    } else {
                        // Already marked as out of OC, just update other fields
                        await User.upsert({
                            id: member.id,
                            name: member.name,
                            last_action_timestamp: member.last_action.timestamp,
                            last_action_status: member.last_action.status,
                            is_in_oc: !!member.is_in_oc,
                            not_in_oc_since: dbRow.not_in_oc_since,
                        });
                    }
                } else {
                    // In OC, reset not_in_oc_since if needed
                    await User.upsert({
                        id: member.id,
                        name: member.name,
                        last_action_timestamp: member.last_action.timestamp,
                        last_action_status: member.last_action.status,
                        is_in_oc: !!member.is_in_oc,
                        not_in_oc_since: null,
                    });
                }
            }
        

        // Prepare a summary message
        const membersArr = Object.values(data.members);
        const total = membersArr.length;
        const inOC = membersArr.filter(m => m.is_in_oc).length;
        const notInOC = total - inOC;
        // List members not in OC with duration
        const now = Math.floor(Date.now() / 1000);
        // We'll need to query the DB for not_in_oc_since
        const rows = await User.findAll({
            where: { is_in_oc: false },
            attributes: ['id', 'name', 'not_in_oc_since', 'last_action_timestamp']
        });
        const notInOCMembers = rows.map(row => {
            // Time not in OC
            let durationNotInOC = '';
            if (row.not_in_oc_since) {
                const seconds = now - row.not_in_oc_since;
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                if (hours > 0) durationNotInOC += `${hours}h `;
                durationNotInOC += `${minutes}m`;
            } else {
                durationNotInOC = '0m';
            }
            // Time since last action
            let durationLastAction = '';
            if (row.last_action_timestamp) {
                const seconds = now - row.last_action_timestamp;
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                if (hours > 0) durationLastAction += `${hours}h `;
                durationLastAction += `${minutes}m`;
            } else {
                durationLastAction = '0m';
            }
            return {
                id: row.id,
                name: row.name,
                notInOcSince: row.not_in_oc_since,
                durationNotInOC,
                durationLastAction
            };
        });
            const notInOCList = notInOCMembers.length ? notInOCMembers.map(m => `• ${m.name} (Not in OC: ${m.durationNotInOC}, Last action: ${m.durationLastAction})`).join('\n') : 'None!';
            const lastUpdated = Math.floor(Date.now() / 1000);
            // Next full minute (seconds === 0)
            const nextUpdate = lastUpdated + (60 - (lastUpdated % 60));
            const summary = `**Faction OC Status**\nTotal: ${total}\nIn OC: ${inOC}\nNot in OC: ${notInOC}` +
                `\n\n**Not in OC:**\n${notInOCList}` +
                `\n\nLast updated: <t:${lastUpdated}:R>` +
                `\nNext update in: <t:${nextUpdate}:R>`;


            // --- 24h alert logic ---
            for (const m of notInOCMembers) {
                if (m.notInOcSince && (now - m.notInOcSince) >= 86400) {
                    // Only alert if not already alerted in last 24h (use a simple table)
                    const alertRow = await Alert.findByPk(m.id);
                    if (!alertRow || !alertRow.last_alert || (now - alertRow.last_alert) >= 86400) {
                        // Send alert
                        const channel = await client.channels.fetch(channelId).catch(() => null);
                        if (channel && 'send' in channel) {
                            const alertMsg = await (channel as TextChannel).send(`⚠️ <@&everyone> ${m.name} has not been in an OC for 24h! React ✅ to increment their tally, ❌ to ignore.`);
                            // Insert/Update alert
                            await Alert.upsert({ user_id: m.id, last_alert: now });
                            // Add reactions
                            await alertMsg.react('✅');
                            await alertMsg.react('❌');
                            // Listen for reactions
                            const filter = (reaction: any, user: any) => ['✅', '❌'].includes(reaction.emoji.name) && !user.bot;
                            const collector = alertMsg.createReactionCollector({ filter, time: 5 * 60 * 1000, max: 1 });
                            collector.on('collect', async (reaction, user) => {
                                if (reaction.emoji.name === '✅') {
                                    await User.increment('fuckup_tally', { by: 1, where: { id: m.id } });
                                }
                                // No action for ❌
                            });
                            collector.on('end', async () => {
                                await alertMsg.delete().catch(() => {});
                            });
                        }
                    }
                }
            }

            // Get the channel and send/update the message
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel || !('send' in channel)) return;
            // Get message ID from config
            const msgConfig = await Config.findByPk('update_message');
            if (!msgConfig) {
                // Send new message and save ID
                const sentMsg = await (channel as TextChannel).send(summary);
                await Config.upsert({ key: 'update_message', value: sentMsg.id });
            } else {
                // Edit existing message
                try {
                    const msg = await (channel as TextChannel).messages.fetch(msgConfig.value);
                    await msg.edit(summary);
                } catch (e) {
                    // If message not found, send a new one
                    const sentMsg = await (channel as TextChannel).send(summary);
                    await Config.upsert({ key: 'update_message', value: sentMsg.id });
                }
            }
        }

    }

cron.schedule('* * * * *', async () => {
    await runOcUpdate();
});

// --- Discord Event Handlers ---
client.once('ready', () => {
    if (client.user) {
        console.log(`Logged in as ${client.user.tag}!`);
    }
});

client.on('messageCreate', async (message: Message) => {
    // Only respond to commands from users (not bots)
    if (message.author.bot) return;
    if (!message.guild) return;

    // Command: !forceupdate
    if (message.content.trim() === '!forceupdate') {
        await runOcUpdate();
        await message.delete().catch(() => {});
        return;
    }

    // Command: !setapikey <APIKEY>
    if (message.content.startsWith('!setapikey')) {
        const match = message.content.match(/^!setapikey\s+([a-zA-Z0-9]+)$/);
        if (!match) {
            await message.reply('Usage: !setapikey <APIKEY>');
            return;
        }
        const apiKey = match[1];
        try {
            await Config.upsert({ key: 'torn_api_key', value: apiKey });
            await message.reply('Torn API key saved successfully.');
        } catch (err) {
            await message.reply('Failed to save API key.');
        }
        return;
    }

    // Command: !setchannel #channel-name
    if (message.content.startsWith('!setchannel')) {
        const match = message.content.match(/!setchannel\s+<#(\d+)>/);
        let channelId: string | undefined;
        if (match) {
            channelId = match[1];
        } else {
            // Try to get from mention
            const channelMention = message.mentions.channels.first();
            if (channelMention) {
                channelId = channelMention.id;
            }
        }
        if (!channelId) {
            await message.reply('Please mention a channel, e.g. `!setchannel #channel-name`');
            return;
        }
        // Store channel ID in DB
        try {
            await Config.upsert({ key: 'update_channel', value: channelId });
            await message.reply(`Channel set to <#${channelId}> for updates.`);
        } catch (err) {
            await message.reply('Failed to save channel.');
        }
    }
});

client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong!');
    }
});

client.login(DISCORD_TOKEN);
