/**
 * bot.js - Optimized for Render Deployment
 */

// 1. CRITICAL: Force IPv4 over IPv6 to prevent handshake hangs on Render
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Collection } = require('discord.js');

const logger = require('./lib/logger');
const { pool, initDatabase, listenForQueueJobs, dbAll } = require('./lib/db');
const { processQueue } = require('./lib/queue');

/* =========================================================
   CONFIGURATION & SANITIZATION
========================================================= */

const TOKEN = process.env.DISCORD_TOKEN?.trim().replace(/^["'](.+)["']$/, '$1');
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT) || 3000;

if (!TOKEN) {
    logger.error('Missing DISCORD_TOKEN. Check Render Environment Variables.');
    process.exit(1);
}

/* =========================================================
   EXPRESS SERVER (START EARLY)
   We start this immediately so Render's health check passes
   even if Discord takes time to connect.
========================================================= */

const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.send('Bot Web Surface Active'));
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        discord_connected: client?.isReady() || false,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 Express server live on port ${PORT}`);
});

/* =========================================================
   DISCORD CLIENT INITIALIZATION
========================================================= */

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences // Required for setting presence in ready event
    ],
    // 2. SHARD FIX: Explicitly set sharding to skip the 'gateway/bot' REST call 
    // where Render instances often hang.
    shards: 0,
    shardCount: 1
});

client.commands = new Collection();

// Enhanced Debugging
client.on('debug', (m) => {
    if (m.includes('Heartbeat')) return; 
    logger.info(`[DISCORD DEBUG] ${m}`);
});
client.on('error', (e) => logger.error(`[DISCORD ERROR] ${e.stack || e}`));
client.on('shardError', (e) => logger.error(`[DISCORD SHARD ERROR] ${e.stack || e}`));

/* =========================================================
   LOAD COMMANDS & EVENTS
========================================================= */

const loadFiles = (dir, handler) => {
    const fullPath = path.join(__dirname, dir);
    if (!fs.existsSync(fullPath)) return;
    const files = fs.readdirSync(fullPath).filter(f => f.endsWith('.js'));
    for (const file of files) {
        const module = require(path.join(fullPath, file));
        handler(module, file);
    }
};

loadFiles('commands', (cmd, file) => {
    if (cmd.data && cmd.execute) {
        client.commands.set(cmd.data.name, cmd);
        logger.info(`Loaded command: ${cmd.data.name}`);
    }
});

loadFiles('events', (event) => {
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args, client));
    } else {
        client.on(event.name, (...args) => event.execute(...args, client));
    }
    logger.info(`Loaded event: ${event.name}`);
});

/* =========================================================
   STARTUP SEQUENCE
========================================================= */

let listenerClient = null;
let queueInterval = null;

async function start() {
    try {
        logger.info('📦 Initializing database...');
        await initDatabase();

        // 3. NETWORK DIAGNOSTIC: Check if we can even see the internet
        logger.info('🌐 Testing Discord API reachability...');
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 5000);
            await fetch('https://discord.com/api/v10/gateway', { signal: controller.signal });
            clearTimeout(id);
            logger.info('✅ Discord API is reachable.');
        } catch (e) {
            logger.warn(`⚠️ Network Test Warning: ${e.message}. Attempting login anyway...`);
        }

        logger.info('🔑 Logging into Discord...');
        await client.login(TOKEN);
        
        logger.info(`✅ Discord READY as ${client.user.tag}`);

        // Setup Queue System
        setupQueue();

        logger.info('🚀 Startup complete.');
    } catch (err) {
        logger.error(`❌ Startup failed: ${err.stack || err}`);
        // We do NOT process.exit(1) here so the Express server stays up 
        // allowing you to check logs and /health
    }
}

function setupQueue() {
    let queueScheduled = false;
    const scheduleQueueRun = () => {
        if (queueScheduled) return;
        queueScheduled = true;
        setImmediate(async () => {
            queueScheduled = false;
            try { await processQueue(client); } catch (err) { logger.error(`Queue Error: ${err}`); }
        });
    };

    if (typeof listenForQueueJobs === 'function') {
        listenForQueueJobs(scheduleQueueRun).then(l => { listenerClient = l; });
    }

    scheduleQueueRun();
    queueInterval = setInterval(scheduleQueueRun, 10 * 60 * 1000);
}

/* =========================================================
   SHUTDOWN HANDLERS
========================================================= */

async function shutdown(signal) {
    logger.info(`🛑 ${signal} received. Cleaning up...`);
    if (queueInterval) clearInterval(queueInterval);
    if (listenerClient) {
        try { await listenerClient.query('UNLISTEN queue_jobs'); listenerClient.release(); } catch (e) {}
    }
    try { server.close(); } catch (e) {}
    try { client.destroy(); } catch (e) {}
    try { await pool.end(); } catch (e) {}
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* =========================================================
   EXECUTE
========================================================= */

start();