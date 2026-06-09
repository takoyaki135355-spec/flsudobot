import "dotenv/config";
import { Client } from "@fluxerjs/core";
import fs from "fs";
import path from "path";

const client = new Client({
    token: process.env.FLUXER_BOT_TOKEN,
    // Request intents and partials so reaction events and uncached messages are available.
    // `intents` number is a broad mask to include message and reaction events; adjust if you prefer explicit flags.
    intents: 32767,
    partials: ["MESSAGE", "CHANNEL", "REACTION"],
});

let logChannel = null;

// Megaphone state
let megaphoneChannels = [];
let megaphoneActive = false;
let megaphoneTarget = null;

// Echo state
let echoActive = false;

// In-memory poll storage: messageId -> pollState
const polls = {};

// Minimal local ReactionCollector for Fluxer - scoped per-message
class ReactionCollector {
    constructor(message, options = {}) {
        this.message = message;
        this.filter = options.filter || (() => true);
        this.max = options.max ?? Infinity;
        this.time = options.time ?? 0;
        this.collected = new Map(); // userId -> emoji
        this._events = {};
        this._onReaction = this._onReaction.bind(this);
        client.on('messageReactionAdd', this._onReaction);
        if (this.time > 0) this._timeout = setTimeout(() => this.stop('time'), this.time);
    }

    async _onReaction(reaction, user) {
        try {
            if (!reaction) return;
            if (!user || user.bot) return;
            // fetch partials if necessary
            if (reaction.partial && typeof reaction.fetch === 'function') await reaction.fetch();
            if (reaction.message && reaction.message.partial && typeof reaction.message.fetch === 'function') await reaction.message.fetch();
        } catch (e) {
            // ignore
        }

        if (!reaction || !reaction.message) return;
        if (reaction.message.id !== this.message.id) return;
        if (!this.filter(reaction, user)) return;

        const emoji = reaction.emoji && (reaction.emoji.name || (typeof reaction.emoji.toString === 'function' ? reaction.emoji.toString() : reaction.emoji.id));

        if (this.collected.has(user.id)) {
            // try remove extra reaction to enforce single-vote
            try {
                if (reaction.users && typeof reaction.users.remove === 'function') await reaction.users.remove(user.id);
                else if (typeof reaction.remove === 'function') await reaction.remove();
            } catch (e) {}
            return;
        }

        this.collected.set(user.id, emoji);
        this.emit('collect', reaction, user);

        if (this.collected.size >= this.max) this.stop('limit');
    }

    stop(reason = 'manual') {
        client.off('messageReactionAdd', this._onReaction);
        if (this._timeout) clearTimeout(this._timeout);
        this.emit('end', this.collected, reason);
    }

    on(event, fn) {
        this._events[event] = this._events[event] || [];
        this._events[event].push(fn);
    }

    emit(event, ...args) {
        (this._events[event] || []).forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } });
    }
}

const HW_FILE = path.join(process.cwd(), "hwlist.json");

function readHW() {
    try {
        if (!fs.existsSync(HW_FILE)) return [];
        const data = fs.readFileSync(HW_FILE, "utf8");
        if (!data.trim()) return [];
        return JSON.parse(data);
    } catch {
        return [];
    }
}

function writeHW(list) {
    fs.writeFileSync(HW_FILE, JSON.stringify(list, null, 2));
}

async function sendWithLog(channel, content) {
    console.log(`[OUT → ${channel.id}] ${content}`);
    return await channel.send(content);
}

client.on("ready", async () => {
    console.log("sudokys is online!");
    if (process.env.LOG_CHANNEL_ID) {
        try {
            logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
        } catch (e) {
            console.error('Failed fetching log channel:', e);
        }
    }

    // Only send the startup notification to the owner's DM (do not spam log channel)
    if (process.env.OWNER_DM) {
        try {
            const ownerDM = await client.channels.fetch(process.env.OWNER_DM);
            if (ownerDM) await sendWithLog(ownerDM, "sudokys is online!");
        } catch (e) {
            console.error('Failed sending startup message to OWNER_DM:', e);
        }
    }
});

client.on("messageCreate", async (message) => {
    const content = message.content || "";
    
    if (message.author.id === client.user.id) return;
    
    const channelId = message.channel?.id || message.channelId;

    // Helpers: detect category-like channels and produce a friendly display name
    function isCategoryChannel(ch) {
        if (!ch) return false;
        const t = ch.type;
        if (typeof t === "string" && t.toLowerCase().includes("category")) return true;
        if (ch.isCategory) return true;
        const cname = ch.constructor && ch.constructor.name;
        if (typeof cname === "string" && cname.toLowerCase().includes("category")) return true;
        return false;
    }

    function getChannelDisplayName(ch) {
        if (!ch) return "Unknown";
        if (ch.name) return ch.name;
        const t = ch.type && String(ch.type).toLowerCase();
        if (t && t.includes("dm")) {
            if (ch.recipient && ch.recipient.username) return `DM with ${ch.recipient.username}`;
            if (ch.recipientId) return `DM with ${ch.recipientId}`;
            if (ch.user && ch.user.username) return `DM with ${ch.user.username}`;
            if (ch.users && Array.isArray(ch.users) && ch.users.length > 0) return `DM with ${ch.users[0].username || ch.users[0].id}`;
            return `DM (${ch.id})`;
        }
        if (ch.recipient && ch.recipient.username) return `DM with ${ch.recipient.username}`;
        if (ch.users && Array.isArray(ch.users) && ch.users.length > 0) return `DM with ${ch.users[0].username || ch.users[0].id}`;
        return ch.id || "Unknown";
    }

    // OWNER_DM commands — OWNER only
    if (channelId === process.env.OWNER_DM && message.author.id === process.env.OWNER_ID) {
        if (content === "!echo") {
            if (echoActive) {
                const replyText = "Echo is already active.";
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }
            echoActive = true;
            const replyText = "Echo activated. Every message you send here will be parroted back. Use `!unecho` to stop.";
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
            return;
        }

        if (content === "!unecho") {
            if (!echoActive) {
                const replyText = "Echo is not currently active.";
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }
            echoActive = false;
            const replyText = "Echo deactivated.";
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
            return;
        }

        // Parrot messages back when echo is active
        if (echoActive && content.trim() && content !== "!echo" && content !== "!unecho") {
            await message.reply(content);
            console.log(`[ECHO → ${channelId}] ${content}`);
        }

        // OWNER send command: !send {userid} "message"
        if (content.startsWith("!send ")) {
            const m = content.match(/^!send\s+(\S+)\s+"([\s\S]+)"\s*$/);
            if (!m) {
                const replyText = 'Usage: !send {userid} "message"';
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }

            let targetId = m[1];
            const msgText = m[2];
            const mentionMatch = targetId.match(/^<@!?(\d+)>$/);
            if (mentionMatch) targetId = mentionMatch[1];

            try {
                let user = null;
                // Try ID/mention resolution first
                const looksLikeId = /^\d{17,20}$/.test(targetId);
                if (looksLikeId) {
                    if (client.users) {
                        if (typeof client.users.get === 'function') user = client.users.get(targetId);
                        else if (client.users.cache && typeof client.users.cache.get === 'function') user = client.users.cache.get(targetId);
                    }
                    if (!user && client.users && typeof client.users.fetch === 'function') {
                        try { user = await client.users.fetch(targetId); } catch (e) { /* ignore */ }
                    }
                }

                // If not found by ID, try username/global name search in cache (case-insensitive)
                if (!user) {
                    const userIter = client.users?.cache?.values ? Array.from(client.users.cache.values())
                        : client.users?.values ? Array.from(client.users.values())
                        : [];
                    const needle = targetId.toLowerCase();
                    const matches = [];
                    for (const u of userIter) {
                        if (!u) continue;
                        const uname = (u.globalName || u.username || '').toLowerCase();
                        const combo = `${u.username ?? ''}#${u.discriminator ?? ''}`.toLowerCase();
                        if (uname === needle || (u.username && u.username.toLowerCase() === needle) || combo === needle) {
                            matches.push(u);
                        }
                    }
                    if (matches.length === 1) user = matches[0];
                    else if (matches.length > 1) {
                        const replyText = `Multiple users match \'${targetId}\': ${matches.slice(0,5).map(x=>`${x.id}`).join(', ')}. Please provide a user ID.`;
                        await message.reply(replyText);
                        console.log(`[OUT → ${channelId}] ${replyText}`);
                        return;
                    }
                }

                if (!user) {
                    const replyText = `User not found: ${targetId}`;
                    await message.reply(replyText);
                    console.log(`[OUT → ${channelId}] ${replyText}`);
                    return;
                }

                if (user && typeof user.send === 'function') {
                    await user.send(msgText);
                } else {
                    // REST fallback: POST /users/:id/messages
                    await client.rest.post(`/users/${user.id || targetId}/messages`, { content: msgText });
                }

                const replyText = `Sent DM to ${user.id || targetId}.`;
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
            } catch (err) {
                const replyText = `Failed to send DM to ${targetId}: ${err?.message || String(err)}`;
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
            }
            return;
        }

        if (content === "!megaphone") {
            megaphoneChannels = [];
            megaphoneActive = false;
            megaphoneTarget = null;

            try {
                let index = 1;
                const seenIds = new Set();
                let allChannels = [];

                const guilds = client.guilds?.cache?.values ? Array.from(client.guilds.cache.values()) : [];
                for (const guild of guilds) {
                    const channels = guild.channels?.cache?.values ? Array.from(guild.channels.cache.values()) : [];
                    for (const channel of channels) {
                        if (!channel || seenIds.has(channel.id)) continue;
                        seenIds.add(channel.id);
                        allChannels.push(channel);
                    }
                }

                // Fluxer client collections expose .values() and .get() rather than
                // Discord-style .cache. Try multiple fallbacks to gather channels.
                const channelIter = client.channels?.cache?.values ? client.channels.cache.values()
                    : client.channels?.values ? client.channels.values()
                    : null;
                if (channelIter) {
                    for (const channel of Array.from(channelIter)) {
                        if (!channel || seenIds.has(channel.id)) continue;
                        seenIds.add(channel.id);
                        allChannels.push(channel);
                    }
                }

                // Include DM wrappers from client.users so we can show/send to user DMs.
                const userIter = client.users?.cache?.values ? client.users.cache.values()
                    : client.users?.values ? client.users.values()
                    : null;
                if (userIter) {
                    for (const user of Array.from(userIter)) {
                        if (!user || user.bot) continue;
                        const dmId = `dm:${user.id}`;
                        if (seenIds.has(dmId)) continue;
                        // Build a lightweight DM-like channel wrapper that exposes .id, .recipient, .send
                        const dmChannel = {
                            id: dmId,
                            recipient: user,
                            send: async (content) => {
                                try {
                                    // Prefer user.send if available
                                    if (typeof user.send === 'function') return await user.send(content);
                                    // Fallback: use client.rest to create/send (best-effort)
                                    return await client.rest.post(`/users/${user.id}/messages`, { content });
                                } catch (e) {
                                    throw e;
                                }
                            },
                        };
                        seenIds.add(dmId);
                        allChannels.push(dmChannel);
                    }
                }

                for (const channel of allChannels) {
                    if (!channel || channel.id === channelId) continue;
                    // Exclude category-like channels explicitly
                    if (isCategoryChannel(channel)) continue;
                    if (typeof channel.send !== "function") continue;

                    let canSend = true;
                    if (channel.permissionsFor) {
                        try {
                            const perms = channel.permissionsFor(client.user);
                            if (perms) {
                                canSend = perms.has?.("SendMessages") || perms.has?.("SendMessagesInThreads") || false;
                            }
                        } catch {
                            canSend = true;
                        }
                    }

                    if (canSend) {
                        megaphoneChannels.push({ index: index++, channel });
                    }
                }
            } catch (err) {
                console.error("Megaphone error:", err);
                await message.reply("Error fetching channel list: " + err.message);
                console.log(`[OUT → ${channelId}] Error fetching channel list: ${err.message}`);
                return;
            }

            if (megaphoneChannels.length === 0) {
                await message.reply("No channels found where I can send messages.");
                console.log(`[OUT → ${channelId}] No channels found where I can send messages.`);
                return;
            }

            const lines = megaphoneChannels.map(c => `[${c.index}] ${getChannelDisplayName(c.channel)}`).join("\n");
            await message.reply(`**Megaphone Channels:**\n${lines}`);
            console.log(`[OUT → ${channelId}] Megaphone Channels: ${lines.replace(/\n/g, ' | ')}`);
            return;
        }

        if (content.startsWith("!select ")) {
            if (megaphoneChannels.length === 0) {
                const replyText = "You must use `!megaphone` first to list channels.";
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }

            const arg = content.slice(8).trim();
            const selectedIndex = parseInt(arg, 10);

            if (isNaN(selectedIndex) || arg !== String(selectedIndex)) {
                const replyText = "Please provide a valid indexing number. Usage: `!select 1`";
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }

            const found = megaphoneChannels.find(c => c.index === selectedIndex);
            if (!found) {
                const replyText = `No channel found with index **${selectedIndex}**. Use \`!megaphone\` to see the list.`;
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }

            megaphoneTarget = found.channel;
            megaphoneActive = true;
            const replyText = `Megaphone activated for **[${selectedIndex}] ${getChannelDisplayName(megaphoneTarget)}**. Send \`!END!\` to stop.`;
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
            return;
        }

        if (content === "!END!") {
            if (!megaphoneActive) {
                const replyText = "Megaphone is not currently active.";
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }
            megaphoneActive = false;
            megaphoneTarget = null;
            megaphoneChannels = [];
            const replyText = "Megaphone deactivated.";
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
            return;
        }

        if (megaphoneActive && megaphoneTarget && content.trim()) {
            try {
                await megaphoneTarget.send(content);
                console.log(`[MEGAPHONE → ${megaphoneTarget.id}] ${content}`);
            } catch (err) {
                console.error(`Megaphone send failed:`, err);
                const replyText = `Failed to send to **[${getChannelDisplayName(megaphoneTarget)}]**: ${err.message}`;
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
            }
        }
        }

    if (content.startsWith("hey sudobot ") || content.match(/^<@!?(1512055278927880192)>\s*/)) {
        // Determine prompt text without the trigger (either the phrase or the mention)
        const mentionRegex = /^<@!?(1512055278927880192)>\s*/;
        let prompt = null;

        if (content.startsWith("hey sudobot ")) {
            prompt = message.content.slice("hey sudobot ".length);
        } else {
            const m = message.content.match(mentionRegex);
            if (m) prompt = message.content.slice(m[0].length);
        }

        // If no prompt provided, ignore
        if (!prompt || !prompt.trim()) return;

        try {
            const response = await fetch(
                "https://api.groq.com/openai/v1/chat/completions",
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: "llama-3.3-70b-versatile",
                        messages: [
                            {
                                role: "user",
                                content: prompt
                            }
                        ]
                    })
                }
            );

            const data = await response.json();
            const aiReply = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? JSON.stringify(data);

            await message.reply(aiReply);
            console.log(`[AI → ${channelId}] ${String(aiReply).slice(0,200)}`);
        } catch (err) {
            console.error(err);
            await message.reply("AI exploded.");
        }
    }

    if (content === "!ping") {
        await message.reply("Pong!");
        console.log(`[OUT → ${channelId}] Pong!`);
    }

    // Poll command: !poll <min-votes> "<question>" <option1> ... <option9>
    if (content.startsWith("!poll ")) {
        // Require quoted question to reliably parse options
        const m = content.match(/^!poll\s+(\d+)\s+"([^"]+)"\s+([\s\S]+)$/);
        if (!m) {
            const replyText = 'Usage: !poll <min-votes> "<question>" <option1> <option2> ... (up to 9 options)';
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
            return;
        }

        const minVotes = parseInt(m[1], 10);
        const question = m[2].trim();
        const optionsRaw = m[3].trim();

        // Split options by whitespace, but allow options with spaces if wrapped in quotes
        // We'll support both unquoted single-word options and quoted multi-word options
        const optionMatches = [];
        const optRe = /"([^"]+)"|(\S+)/g;
        let om;
        while ((om = optRe.exec(optionsRaw)) !== null) {
            optionMatches.push(om[1] ?? om[2]);
        }

        if (optionMatches.length < 2) {
            const replyText = "Please provide at least 2 options for the poll.";
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
            return;
        }

        if (optionMatches.length > 9) {
            const replyText = "A poll can have at most 9 options. Please reduce the number of options.";
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
            return;
        }

        const emojiMap = [
            '1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'
        ];

        const options = optionMatches;

        // Build poll message
        let pollText = `**Poll:** ${question}\n\n`;
        for (let i = 0; i < options.length; i++) {
            pollText += `${emojiMap[i]}  ${options[i]}\n`;
        }
        pollText += `\nMinimum unique votes required: ${minVotes}`;

        try {
            const pollMessage = await message.channel.send(pollText);

            // Add number reactions corresponding to options
            for (let i = 0; i < options.length; i++) {
                try { await pollMessage.react(emojiMap[i]); } catch (e) { /* ignore reaction errors */ }
            }

            // Store poll state
            const pollState = {
                messageId: pollMessage.id,
                channelId: pollMessage.channel.id || channelId,
                question,
                options,
                emojiMap: emojiMap.slice(0, options.length),
                minVotes,
                votes: {}, // userId -> emojiIndex
                complete: false,
            };
            polls[pollMessage.id] = pollState;

            // Create a ReactionCollector scoped to this poll which stops when minVotes unique voters collected
            const collector = new ReactionCollector(pollMessage, {
                filter: (reaction, user) => {
                    try {
                        if (!reaction || !reaction.emoji) return false;
                        const rep = reaction.emoji.name || (reaction.emoji.toString && reaction.emoji.toString());
                        return !!rep && pollState.emojiMap.includes(rep) && !user?.bot;
                    } catch (e) { return false; }
                },
                max: minVotes,
            });

            collector.on('collect', (reaction, user) => {
                try {
                    const rep = reaction.emoji.name || (reaction.emoji.toString && reaction.emoji.toString());
                    const idx = pollState.emojiMap.indexOf(rep);
                    if (idx >= 0 && !pollState.votes[user.id]) {
                        pollState.votes[user.id] = idx;
                        console.log(`[DEBUG] collector recorded vote: poll=${pollMessage.id} user=${user.id} idx=${idx}`);
                    }
                } catch (e) { console.warn('collector collect handler error', e); }
            });

            pollState.collector = collector;

            collector.on('end', async (collected, reason) => {
                try {
                    // Tally from collector.collected (Map)
                    const counts = new Array(pollState.options.length).fill(0);
                    const votersByOption = new Array(pollState.options.length).fill(null).map(() => []);

                    for (const [uid, emojiRep] of collected.entries()) {
                        const idx = pollState.emojiMap.indexOf(emojiRep);
                        if (idx >= 0) {
                            counts[idx]++;
                            votersByOption[idx].push(uid);
                        }
                    }

                    // Build result message
                    let resultText = `**Poll Results:** ${pollState.question}\n\n`;
                    for (let i = 0; i < pollState.options.length; i++) {
                        const emojiLabel = pollState.emojiMap[i];
                        const optText = pollState.options[i];
                        const voterMentions = votersByOption[i].map(id => `<@${id}>`).join(', ') || 'None';
                        resultText += `${emojiLabel}  **${optText}** — ${counts[i]} vote(s)\nVoters: ${voterMentions}\n\n`;
                    }

                    const maxVotes = Math.max(...counts);
                    const winners = [];
                    for (let i = 0; i < counts.length; i++) if (counts[i] === maxVotes) winners.push(i);

                    if (maxVotes === 0) {
                        resultText += 'No votes were cast.';
                    } else if (winners.length === 1) {
                        resultText += `Winner: **${pollState.options[winners[0]]}** with ${maxVotes} vote(s).`;
                    } else {
                        const tiedOptions = winners.map(i => `**${pollState.options[i]}**`).join(', ');
                        resultText += `Tie between: ${tiedOptions} with ${maxVotes} vote(s) each.`;
                    }

                    try {
                        const channel = await client.channels.fetch(pollState.channelId);
                        if (channel) await channel.send(resultText);
                        else await pollMessage.channel.send(resultText);
                    } catch (e) {
                        try { await pollMessage.channel.send(resultText); } catch (ee) { console.error('Failed posting poll result:', ee); }
                    }

                    pollState.complete = true;
                    delete polls[pollMessage.id];
                } catch (e) {
                    console.error('Error finalizing poll:', e);
                }
            });

            const replyText = `Poll posted with ${options.length} options. Voting via reactions.`;
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
        } catch (err) {
            console.error('Failed to post poll:', err);
            await message.reply('Failed to create poll: ' + (err?.message || String(err)));
        }

        return;
    }

    // Force-tally command for debugging: owner-only
    if (content.startsWith("!tally ")) {
        const arg = content.slice(7).trim();
        if (!arg) {
            await message.reply("Usage: !tally <pollMessageId>");
            return;
        }

        if (message.author.id !== process.env.OWNER_ID) {
            await message.reply("Only the owner can force-tally polls.");
            return;
        }

        const poll = polls[arg];
        if (!poll) {
            await message.reply(`No active poll found with message ID ${arg}.`);
            return;
        }

        const computeAndPost = async (counts, votersByOption) => {
            try {
                let resultText = `**Poll Results:** ${poll.question}\n\n`;
                for (let i = 0; i < poll.options.length; i++) {
                    const emojiLabel = poll.emojiMap[i];
                    const optText = poll.options[i];
                    const voterMentions = (votersByOption[i] || []).map(id => `<@${id}>`).join(', ') || 'None';
                    resultText += `${emojiLabel}  **${optText}** — ${counts[i] || 0} vote(s)\nVoters: ${voterMentions}\n\n`;
                }

                const maxVotes = Math.max(...counts);
                const winners = [];
                for (let i = 0; i < counts.length; i++) if (counts[i] === maxVotes) winners.push(i);

                if (maxVotes === 0) {
                    resultText += 'No votes were cast.';
                } else if (winners.length === 1) {
                    resultText += `Winner: **${poll.options[winners[0]]}** with ${maxVotes} vote(s).`;
                } else {
                    const tiedOptions = winners.map(i => `**${poll.options[i]}**`).join(', ');
                    resultText += `Tie between: ${tiedOptions} with ${maxVotes} vote(s) each.`;
                }

                try {
                    const channel = await client.channels.fetch(poll.channelId);
                    if (channel) await channel.send(resultText);
                    else await message.channel.send(resultText);
                } catch (e) {
                    try { await message.channel.send(resultText); } catch (ee) { console.error('Failed posting forced tally:', ee); }
                }
            } catch (e) {
                console.error('computeAndPost error:', e);
            }
        };

        try {
            if (poll.collector) {
                // Wait for collector to finish after we stop it, using a one-time listener
                await new Promise((resolve) => {
                    const onEnd = (collected) => {
                        try {
                            // build counts/voters from collected Map of userId->emojiRep
                            const counts = new Array(poll.options.length).fill(0);
                            const votersByOption = new Array(poll.options.length).fill(null).map(() => []);
                            for (const [uid, emojiRep] of collected.entries()) {
                                const idx = poll.emojiMap.indexOf(emojiRep);
                                if (idx >= 0) {
                                    counts[idx]++;
                                    votersByOption[idx].push(uid);
                                }
                            }
                            // mark complete and clean up
                            poll.complete = true;
                            delete polls[arg];
                            computeAndPost(counts, votersByOption).then(() => resolve());
                        } catch (e) { console.error('onEnd error:', e); resolve(); }
                    };

                    poll.collector.on('end', onEnd);
                    // stop collector (will trigger 'end' listener)
                    try { poll.collector.stop('forced'); } catch (e) { console.warn('collector.stop failed', e); resolve(); }
                });

                await message.reply('Tally forced — finalizing poll.');
                return;
            }

            // No collector: use poll.votes (expected userId -> optionIndex)
            const counts = new Array(poll.options.length).fill(0);
            const votersByOption = new Array(poll.options.length).fill(null).map(() => []);
            for (const [uid, optIdx] of Object.entries(poll.votes || {})) {
                const i = Number(optIdx);
                if (!Number.isNaN(i) && i >= 0 && i < counts.length) {
                    counts[i]++;
                    votersByOption[i].push(uid);
                }
            }

            // mark complete and cleanup
            poll.complete = true;
            delete polls[arg];

            await computeAndPost(counts, votersByOption);
            await message.reply('Tally complete.');
            return;
        } catch (err) {
            console.error('Error during forced tally:', err);
            await message.reply('Error during forced tally: ' + (err?.message || String(err)));
            return;
        }
    }

    // Owner-only: list active polls
    if (content === "!polls") {
        if (message.author.id !== process.env.OWNER_ID) {
            await message.reply("Only the owner can list active polls.");
            return;
        }

        const ids = Object.keys(polls);
        if (ids.length === 0) {
            await message.reply("No active polls.");
            return;
        }

        const lines = [];
        for (const id of ids) {
            const p = polls[id];
            const voters = p.votes ? Object.keys(p.votes).length : (p.collector ? p.collector.collected.size : 0);
            const channelLabel = p.channelId ? `<#${p.channelId}>` : 'Unknown';
            lines.push(`ID: ${id} | Channel: ${channelLabel} | Q: ${p.question} | minVotes: ${p.minVotes} | voters: ${voters}`);
        }

        // Send in chunks if long
        const chunk = lines.join('\n');
        await message.reply(`**Active Polls:**\n${chunk}`);
        return;
    }

    if (content === "hi sudobot") {
        await message.reply("Hello!");
        console.log(`[OUT → ${channelId}] Hello!`);
    }

    if (content === "what is ritvik") {
        await message.reply("a femboy");
        console.log(`[OUT → ${channelId}] a femboy`);
    }

    if (content === "what is arham") {
        await message.reply("hackyboy");
        console.log(`[OUT → ${channelId}] hackyboy`);
    }

    if (content === "what is vihaan") {
        await message.reply("DUH DUH DUH DA MAX VERSTAPPEN!!!");
        console.log(`[OUT → ${channelId}] Duh Duh D DA MAX VERSTAPPEN!!!`);
    }

    if (content === "what is deven") {
        await message.reply("a deven");
        console.log(`[OUT → ${channelId}] a deven`);
    }

    if (content === "what is samir") {
        await message.reply("a potato");
        console.log(`[OUT → ${channelId}] a potato`);
    }

    if (content === "what is eltenir") {
        await message.reply("a fraud (fix your game)");
        console.log(`[OUT → ${channelId}] a fraud (fix your game)`);
    }

    if (content === ":Tufftuffcurrypuff:") {
        await message.reply(":weirdo:");
        console.log(`[OUT → ${channelId}] :weirdo:`);
    }

    if (content.toLowerCase().startsWith("y/n")) {
        const answer = Math.random() < 0.5 ? "Yes" : "No";
        await message.reply(answer);
        console.log(`[OUT → ${channelId}] ${answer}`);
    }

    if (channelId === process.env.HW_CHANNEL_ID) {
        if (content.startsWith("!add ")) {
            const itemName = content.slice(5).trim();
            if (!itemName) {
                const replyText = "Please provide an item to add. Usage: `!add item name`";
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }

            const list = readHW();
            const newIndex = list.length > 0 ? Math.max(...list.map(i => i.index)) + 1 : 1;
            list.push({ index: newIndex, name: itemName });
            writeHW(list);

            const replyText = `Added **[${newIndex}] ${itemName}** to the homework list.`;
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
        }

        if (content === "!show") {
            const list = readHW();
            if (list.length === 0) {
                const replyText = "The homework list is empty.";
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }

            const lines = list.map(item => `[${item.index}] ${item.name}`).join("\n");
            const replyText = `**Homework List:**\n${lines}`;
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText.replace(/\n/g, ' | ')}`);
        }

        if (content.startsWith("!remove ")) {
            const arg = content.slice(8).trim();
            const indexNum = parseInt(arg, 10);

            if (isNaN(indexNum) || arg !== String(indexNum)) {
                const replyText = "Please provide a valid indexing number. Usage: `!remove 1`";
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }

            const list = readHW();
            const itemIndex = list.findIndex(item => item.index === indexNum);

            if (itemIndex === -1) {
                const replyText = `No item found with index **${indexNum}**.`;
                await message.reply(replyText);
                console.log(`[OUT → ${channelId}] ${replyText}`);
                return;
            }

            const removed = list.splice(itemIndex, 1)[0];
            writeHW(list);
            const replyText = `Removed **[${removed.index}] ${removed.name}**.`;
            await message.reply(replyText);
            console.log(`[OUT → ${channelId}] ${replyText}`);
        }
    }

    if (content === "!QUIT" && message.author.id === process.env.OWNER_ID) {
        if (logChannel) {
            await sendWithLog(logChannel, "quitting...");
        }
        await client.destroy();
        process.exit(0);
    }
});

process.on("uncaughtException", async (err) => {
    console.error("Uncaught Exception:", err);
    if (logChannel) {
        try {
            await logChannel.send("sudobot has run into an internal error");
        } catch (e) {
            console.error("Failed to send error message:", e);
        }
    }
    await client.destroy();
    process.exit(1);
});

process.on("unhandledRejection", async (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
    if (logChannel) {
        try {
            await logChannel.send("sudobot has run into an internal error");
        } catch (e) {
            console.error("Failed to send error message:", e);
        }
    }
    await client.destroy();
    process.exit(1);
});

process.on("SIGINT", async () => {
    if (logChannel) {
        await sendWithLog(logChannel, "quitting...");
    }
    await client.destroy();
    process.exit(0);
});

// (Per-poll collectors are used instead of a global `messageReactionAdd` handler.)

client.login(process.env.FLUXER_BOT_TOKEN);
