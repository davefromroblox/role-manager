require('dotenv').config();

const fs      = require('fs');
const path    = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const express = require('express');

const logger       = require('./lib/logger');
const { pool, initDatabase, listenForQueueJobs } = require('./lib/db');
const { processQueue }       = require('./lib/queue');
const { dbAll }              = require('./lib/db');

/* =========================================================
   VALIDATE ENV
========================================================= */

const TOKEN        = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT         = process.env.PORT || 3000;

if (!TOKEN)        { logger.error('Missing DISCORD_TOKEN');  process.exit(1); }
if (!DATABASE_URL) { logger.error('Missing DATABASE_URL');   process.exit(1); }

/* =========================================================
   GLOBAL ERROR HANDLERS
========================================================= */

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.message}`);
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
   LOAD COMMANDS
========================================================= */

const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
    const command = require(path.join(commandsPath, file));
    if (!command.data || !command.execute) {
        logger.warn(`Skipping ${file} — missing data or execute`);
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
   EXPRESS SERVER
========================================================= */

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/process-queue', async (_req, res) => {
    if (!client.isReady()) return res.status(503).json({ error: 'Discord client not ready' });
    try {
        await processQueue(client);
        res.json({ status: 'success' });
    } catch (err) {
        logger.error(`/process-queue error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/stats', async (_req, res) => {
    try {
        const [pending, success, failed, logs] = await Promise.all([
            dbAll(`SELECT COUNT(*) as count FROM action_queue WHERE status='PENDING'`),
            dbAll(`SELECT COUNT(*) as count FROM action_queue WHERE status='SUCCESS'`),
            dbAll(`SELECT COUNT(*) as count FROM action_queue WHERE status LIKE 'FAILED%'`),
            dbAll(`SELECT COUNT(*) as count FROM audit_log`)
        ]);
        res.json({
            bot_status:       client.isReady() ? 'online' : 'offline',
            pending_jobs:     parseInt(pending[0]?.count  || 0),
            success_jobs:     parseInt(success[0]?.count  || 0),
            failed_jobs:      parseInt(failed[0]?.count   || 0),
            total_audit_logs: parseInt(logs[0]?.count     || 0),
            timestamp:        new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================================================
   BOOT
========================================================= */

async function start() {
    try {
        await initDatabase();

        await client.login(TOKEN);

        // Coalesce bursts of NOTIFY events into a single processQueue() call
        let queueRunScheduled = false;
        const scheduleQueueRun = () => {
            if (queueRunScheduled) return;
            queueRunScheduled = true;
            setImmediate(() => {
                queueRunScheduled = false;
                processQueue(client).catch(err => {
                    logger.error(`Queue trigger error: ${err.message}`);
                });
            });
        };

        // Event-driven: process immediately when a job becomes PENDING
        const listenerClient = await listenForQueueJobs(() => scheduleQueueRun());

        // Catch up on anything that was queued while the bot was offline
        scheduleQueueRun();

        // Safety-net poll in case a NOTIFY is ever missed (e.g. brief
        // listener reconnects).
        const queueInterval = setInterval(() => {
            processQueue(client).catch(err => {
                logger.error(`Queue fallback tick error: ${err.message}`);
            });
        }, 600000); // 10 minutes

        const server = app.listen(PORT, () => {
            logger.info(`Express server listening on port ${PORT}`);
        });

        // Graceful shutdown
        const shutdown = async () => {
            logger.info('Shutting down gracefully...');
            clearInterval(queueInterval);
            if (listenerClient) {
                try { await listenerClient.query('UNLISTEN queue_jobs'); } catch (_) {}
                try { listenerClient.release(); } catch (_) {}
            }
            server.close();
            client.destroy();
            await pool.end();
            logger.info('Shutdown complete');
            process.exit(0);
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT',  shutdown);

    } catch (err) {
        logger.error(`Startup failed: ${err.message}`);
        process.exit(1);
    }
}

start();