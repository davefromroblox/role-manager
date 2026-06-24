require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Collection } = require('discord.js');

const logger = require('./lib/logger');
const { pool, initDatabase, listenForQueueJobs, dbAll } = require('./lib/db');
const { processQueue } = require('./lib/queue');

/* =========================================================
   ENV
========================================================= */

const TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT) || 3000;

if (!TOKEN) {
    logger.error('Missing DISCORD_TOKEN');
    process.exit(1);
}

if (!DATABASE_URL) {
    logger.error('Missing DATABASE_URL');
    process.exit(1);
}

/* =========================================================
   ERROR HANDLERS
========================================================= */

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason?.stack || reason}`);
});

process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.stack}`);
    process.exit(1);
});

/* =========================================================
   DISCORD CLIENT
========================================================= */

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

client.commands = new Collection();

/* =========================================================
   DEBUG (CRITICAL)
========================================================= */

client.on('debug', (m) => logger.info(`[DISCORD DEBUG] ${m}`));
client.on('error', (e) => logger.error(`[DISCORD ERROR] ${e?.stack || e}`));
client.on('shardError', (e) => logger.error(`[DISCORD SHARD ERROR] ${e?.stack || e}`));

client.once('ready', () => {
    logger.info(`Discord READY as ${client.user.tag}`);
});

/* =========================================================
   LOAD COMMANDS
========================================================= */

const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
    const command = require(path.join(commandsPath, file));

    if (!command.data || !command.execute) {
        logger.warn(`Skipping ${file} (invalid command)`);
        continue;
    }

    client.commands.set(command.data.name, command);
    logger.info(`Loaded command: ${command.data.name}`);
}

/* =========================================================
   LOAD EVENTS
========================================================= */

const eventsPath = path.join(__dirname, 'events');

for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
    const event = require(path.join(eventsPath, file));

    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args, client));
    } else {
        client.on(event.name, (...args) => event.execute(...args, client));
    }

    logger.info(`Loaded event: ${event.name}`);
}

/* =========================================================
   EXPRESS (START IMMEDIATELY FOR RENDER)
========================================================= */

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
    res.send('Bot running');
});

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        discord: client.isReady(),
        timestamp: new Date().toISOString()
    });
});

app.get('/stats', async (_req, res) => {
    try {
        const [pending, success, failed, logs] = await Promise.all([
            dbAll(`SELECT COUNT(*) AS count FROM action_queue WHERE status='PENDING'`),
            dbAll(`SELECT COUNT(*) AS count FROM action_queue WHERE status='SUCCESS'`),
            dbAll(`SELECT COUNT(*) AS count FROM action_queue WHERE status LIKE 'FAILED%'`),
            dbAll(`SELECT COUNT(*) AS count FROM audit_log`)
        ]);

        res.json({
            bot_status: client.isReady() ? 'online' : 'offline',
            pending_jobs: Number(pending[0]?.count || 0),
            success_jobs: Number(success[0]?.count || 0),
            failed_jobs: Number(failed[0]?.count || 0),
            total_logs: Number(logs[0]?.count || 0),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error(err);
        res.status(500).json({ error: err.message });
    }
});

const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Express listening on 0.0.0.0:${PORT}`);
});

/* =========================================================
   STARTUP LOGIC
========================================================= */

let listenerClient = null;
let queueInterval = null;

async function start() {
    try {
        logger.info('Initializing database...');
        await initDatabase();

        logger.info('Logging into Discord...');

        const loginPromise = client.login(TOKEN);

        loginPromise
            .then(() => logger.info('Discord login resolved'))
            .catch(err => logger.error(`Discord login failed: ${err.stack || err}`));

        await loginPromise;

        logger.info(`Logged in as ${client.user.tag}`);

        /* =========================
           QUEUE SYSTEM
        ========================= */

        let queueScheduled = false;

        const scheduleQueueRun = () => {
            if (queueScheduled) return;
            queueScheduled = true;

            setImmediate(async () => {
                queueScheduled = false;
                try {
                    await processQueue(client);
                } catch (err) {
                    logger.error(`Queue error: ${err.stack || err}`);
                }
            });
        };

        if (typeof listenForQueueJobs === 'function') {
            listenerClient = await listenForQueueJobs(scheduleQueueRun);
        }

        scheduleQueueRun();

        queueInterval = setInterval(async () => {
            try {
                await processQueue(client);
            } catch (err) {
                logger.error(`Queue tick error: ${err.stack || err}`);
            }
        }, 10 * 60 * 1000);

        logger.info('Startup complete.');
    } catch (err) {
        logger.error(`Startup failed: ${err.stack || err}`);
        process.exit(1);
    }
}

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown(signal) {
    logger.info(`${signal} received, shutting down...`);

    if (queueInterval) clearInterval(queueInterval);

    if (listenerClient) {
        try { await listenerClient.query('UNLISTEN queue_jobs'); } catch {}
        try { listenerClient.release(); } catch {}
    }

    try { server.close(); } catch {}
    try { client.destroy(); } catch {}
    try { await pool.end(); } catch {}

    logger.info('Shutdown complete');
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* =========================================================
   BOOT
========================================================= */

start();