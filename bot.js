require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Collection } = require('discord.js');

const logger = require('./lib/logger');
const { pool, initDatabase, listenForQueueJobs, dbAll } = require('./lib/db'); // Adjusted to match standard helper names
const { processQueue } = require('./lib/queue');

/* =========================================================
   ENVIRONMENT
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
   GLOBAL ERROR HANDLERS
========================================================= */

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.stack}`);
    process.exit(1);
});

/* =========================================================
   EXPRESS SERVER
========================================================= */

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
    res.send('Bot is running.');
});

// Refactored health check so Render does not kill the container while Discord logs in asynchronously
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptime_seconds: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.post('/process-queue', async (_req, res) => {
    try {
        if (!client.isReady()) {
            return res.status(503).json({
                error: 'Discord client not ready'
            });
        }

        await processQueue(client);

        res.json({
            status: 'success'
        });
    } catch (err) {
        logger.error(`/process-queue: ${err.stack || err}`);
        res.status(500).json({
            error: err.message
        });
    }
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
            total_audit_logs: Number(logs[0]?.count || 0),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error(err.stack || err);
        res.status(500).json({
            error: err.message
        });
    }
});

const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Express listening on 0.0.0.0:${PORT}`);
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
   LOAD COMMANDS
========================================================= */

const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
    for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
        const command = require(path.join(commandsPath, file));

        if (!command.data || !command.execute) {
            logger.warn(`Skipping ${file} (missing data or execute)`);
            continue;
        }

        client.commands.set(command.data.name, command);
        logger.info(`Loaded command: ${command.data.name}`);
    }
}

/* =========================================================
   LOAD EVENTS
========================================================= */

const eventsPath = path.join(__dirname, 'events');
if (fs.existsSync(eventsPath)) {
    for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
        const event = require(path.join(eventsPath, file));

        if (event.once) {
            client.once(event.name, (...args) => event.execute(...args, client));
        } else {
            client.on(event.name, (...args) => event.execute(...args, client));
        }

        logger.info(`Loaded event: ${event.name}`);
    }
}

/* =========================================================
   STARTUP
========================================================= */

let listenerClient = null;
let queueInterval = null;

async function start() {
    try {
        logger.info('Initializing database...');
        await initDatabase();

        logger.info('Logging into Discord...');
        await client.login(TOKEN);
        
        logger.info(`Logged in as ${client.user?.tag || 'Bot'}`);

        let queueScheduled = false;

        const scheduleQueueRun = () => {
            if (queueScheduled) return;
            queueScheduled = true;

            setImmediate(async () => {
                queueScheduled = false;
                try {
                    await processQueue(client);
                } catch (err) {
                    logger.error(`Queue processing failed: ${err.stack || err}`);
                }
            });
        };

        // Safely attach database queue listeners once client is fully live
        if (typeof listenForJobs === 'function') {
            listenerClient = await listenForJobs(scheduleQueueRun);
        }

        scheduleQueueRun();

        // Queue fallback/interval runner (every 10 minutes)
        queueInterval = setInterval(async () => {
            try {
                await processQueue(client);
            } catch (err) {
                logger.error(`Queue poll failed: ${err.stack || err}`);
            }
        }, 10 * 60 * 1000);

        logger.info('Bot startup complete.');
    } catch (err) {
        logger.error(`Startup failed:\n${err.stack || err}`);
        process.exit(1);
    }
}

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown(signal) {
    logger.info(`${signal} received. Shutting down...`);

    if (queueInterval) {
        clearInterval(queueInterval);
    }

    if (listenerClient) {
        try {
            await listenerClient.query
