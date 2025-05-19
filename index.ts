import { Client, GatewayIntentBits, Interaction, TextChannel, Message } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();
import { TornFactionMembersResponse, TornFactionMember } from './types';
import sqlite3 from 'sqlite3';
import cron from 'node-cron';

// --- CONFIGURATION ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
if (!DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN not set in .env');
    process.exit(1);
}
const TORN_API_KEY = process.env.TORN_API_KEY || '';
const DB_PATH = './botdata.sqlite';

// --- Discord Client Setup ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// --- SQLite Setup ---
const db = new sqlite3.Database(DB_PATH, (err: Error | null) => {
    if (err) {
        console.error('Could not connect to database', err);
    } else {
        console.log('Connected to SQLite database');
    }
});

// Config table for storing channel ID
const CONFIG_TABLE = `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)`;
db.run(CONFIG_TABLE);

// User table for storing Torn API members
const USER_TABLE = `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    last_action_timestamp INTEGER NOT NULL,
    last_action_status TEXT NOT NULL,
    is_in_oc INTEGER NOT NULL,
    not_in_oc_since INTEGER,
    fuckup_tally INTEGER DEFAULT 0
)`;
db.run(USER_TABLE);


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
        const keyRow: { value: string } | undefined = await new Promise(resolve => {
            db.get('SELECT value FROM config WHERE key = ?', ['torn_api_key'], (err, row) => {
                if (err || !row) resolve(undefined);
                else resolve(row as { value: string });
            });
        });
        apiKey = keyRow?.value || '';
    }
    if (!apiKey) {
        console.warn('No Torn API key set. Skipping OC check.');
        return;
    }
    // Get Torn API key and update channel from config
    db.get('SELECT value FROM config WHERE key = ?', ['update_channel'], async (err, channelRow) => {
        if (err || !channelRow) {
            if (!err) console.log('Update channel not set.');
            return;
        }
        const channelId = (channelRow as { value: string }).value;
        const data = await fetchTornFactionMembers(apiKey);
        if (!data) return;

        // Import users on first fetch
        const nowTs = Math.floor(Date.now() / 1000);
        const usersImported = await new Promise<boolean>(resolve => {
            db.get('SELECT COUNT(*) as count FROM users', (err, row: { count: number }) => {
                resolve(row && row.count > 0);
            });
        });
        if (!usersImported) {
            const stmt = db.prepare('INSERT OR REPLACE INTO users (id, name, last_action_timestamp, last_action_status, is_in_oc, not_in_oc_since) VALUES (?, ?, ?, ?, ?, ?)');
            for (const member of data.members) {
                stmt.run(
                    member.id,
                    member.name,
                    member.last_action.timestamp,
                    member.last_action.status,
                    member.is_in_oc ? 1 : 0,
                    !member.is_in_oc ? nowTs : null
                );
            }
            stmt.finalize();
            console.log('Imported users from Torn API.');
        } else {
            // Update users and not_in_oc_since logic
            for (const member of data.members) {
                db.get('SELECT not_in_oc_since FROM users WHERE id = ?', [member.id], (err, row) => {
                    const dbRow = row as { not_in_oc_since: number | null };
                    if (!err && dbRow) {
                        if (!member.is_in_oc && !dbRow.not_in_oc_since) {
                            // Set not_in_oc_since
                            db.run('UPDATE users SET not_in_oc_since = ? WHERE id = ?', [nowTs, member.id]);
                        } else if (member.is_in_oc && dbRow.not_in_oc_since) {
                            // Clear not_in_oc_since
                            db.run('UPDATE users SET not_in_oc_since = NULL WHERE id = ?', [member.id]);
                        }
                        db.run('UPDATE users SET last_action_timestamp = ?, last_action_status = ?, is_in_oc = ? WHERE id = ?', [
                            member.last_action.timestamp,
                            member.last_action.status,
                            member.is_in_oc ? 1 : 0,
                            member.id
                        ]);
                    }
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
        db.all('SELECT id, name, not_in_oc_since, last_action_timestamp FROM users WHERE is_in_oc = 0', (err, rows) => {
            const notInOCMembers = (rows as Array<{ id: number, name: string, not_in_oc_since: number, last_action_timestamp: number }>).map(row => {
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
            notInOCMembers.forEach(async m => {
                if (m.notInOcSince && (now - m.notInOcSince) >= 86400) {
                    // Only alert if not already alerted in last 24h (use a simple table)
                    db.get('SELECT last_alert FROM alerts WHERE user_id = ?', [m.id], async (err, row) => {
                        const alertRow = row as { last_alert?: number };
                        if (!alertRow || !alertRow.last_alert || (now - alertRow.last_alert) >= 86400) {
                            // Send alert
                            const channel = await client.channels.fetch(channelId).catch(() => null);
                            if (channel && 'send' in channel) {
                                const alertMsg = await (channel as TextChannel).send(`⚠️ <@&everyone> ${m.name} has not been in an OC for 24h! React ✅ to increment their tally, ❌ to ignore.`);
                                // Insert/Update alert
                                db.run('INSERT OR REPLACE INTO alerts (user_id, last_alert) VALUES (?, ?)', [m.id, now]);
                                // Add reactions
                                await alertMsg.react('✅');
                                await alertMsg.react('❌');
                                // Listen for reactions
                                const filter = (reaction: any, user: any) => ['✅', '❌'].includes(reaction.emoji.name) && !user.bot;
                                const collector = alertMsg.createReactionCollector({ filter, time: 5 * 60 * 1000, max: 1 });
                                collector.on('collect', (reaction, user) => {
                                    if (reaction.emoji.name === '✅') {
                                        db.run('UPDATE users SET fuckup_tally = COALESCE(fuckup_tally, 0) + 1 WHERE id = ?', [m.id]);
                                    }
                                    // No action for ❌
                                });
                                collector.on('end', () => {
                                    alertMsg.delete().catch(() => {});
                                });
                            }
                        }
                    });
                }
            });

            // Get the channel and send/update the message
            (async () => {
                const channel = await client.channels.fetch(channelId).catch(() => null);
                if (!channel || !('send' in channel)) return;
                // Get message ID from config
                db.get('SELECT value FROM config WHERE key = ?', ['update_message'], async (err, msgRow) => {
                    if (err) return;
                    if (!msgRow) {
                        // Send new message and save ID
                        const sentMsg = await (channel as TextChannel).send(summary);
                        db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['update_message', sentMsg.id]);
                    } else {
                        // Edit existing message
                        try {
                            const msg = await (channel as TextChannel).messages.fetch((msgRow as { value: string }).value);
                            await msg.edit(summary);
                        } catch (e) {
                            // If message not found, send a new one
                            const sentMsg = await (channel as TextChannel).send(summary);
                            db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['update_message', sentMsg.id]);
                        }
                    }
                });
            })();
        });
    });
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
        db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['torn_api_key', apiKey], (err) => {
            if (err) {
                message.reply('Failed to save API key.');
            } else {
                message.reply('Torn API key saved successfully.');
            }
        });
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
        db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['update_channel', channelId], (err) => {
            if (err) {
                message.reply('Failed to save channel.');
            } else {
                message.reply(`Channel set to <#${channelId}> for updates.`);
            }
        });
    }
});

client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong!');
    }
});

client.login(DISCORD_TOKEN);
