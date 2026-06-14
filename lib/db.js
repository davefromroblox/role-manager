const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
    logger.error(`Unexpected error on idle DB client: ${err.message}`);
});

const dbGet = async (q, p = []) => {
    try {
        logger.debug(`dbGet: ${q} | params: ${JSON.stringify(p)}`);
        const result = await pool.query(q, p);
        return result.rows[0] || null;
    } catch (err) {
        logger.error(`dbGet failed: ${err.message} | query: ${q}`);
        throw err;
    }
};

const dbRun = async (q, p = []) => {
    try {
        logger.debug(`dbRun: ${q} | params: ${JSON.stringify(p)}`);
        return await pool.query(q, p);
    } catch (err) {
        logger.error(`dbRun failed: ${err.message} | query: ${q}`);
        throw err;
    }
};

const dbAll = async (q, p = []) => {
    try {
        logger.debug(`dbAll: ${q} | params: ${JSON.stringify(p)}`);
        const result = await pool.query(q, p);
        return result.rows;
    } catch (err) {
        logger.error(`dbAll failed: ${err.message} | query: ${q}`);
        throw err;
    }
};

async function initDatabase() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS config (
                guild_id                  TEXT PRIMARY KEY,
                log_channel_id            TEXT,
                role_requests_channel_id  TEXT,
                manager_role_id           TEXT,
                protected_role_id         TEXT,
                reason_required           INTEGER DEFAULT 0,
                created_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS action_queue (
                id                  SERIAL PRIMARY KEY,
                guild_id            TEXT NOT NULL,
                actor_id            TEXT NOT NULL,
                target_user_id      TEXT NOT NULL,
                role_id             TEXT NOT NULL,
                action_type         TEXT NOT NULL,
                reason              TEXT,
                status              TEXT DEFAULT 'PENDING',
                created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at          TIMESTAMP,
                attempt_count       INTEGER DEFAULT 0,
                last_error          TEXT,
                updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                approver_id         TEXT,
                approval_message_id TEXT
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS request_blacklist (
                guild_id   TEXT NOT NULL,
                user_id    TEXT NOT NULL,
                added_by   TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, user_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id        SERIAL PRIMARY KEY,
                guild_id  TEXT NOT NULL,
                actor_id  TEXT NOT NULL,
                target_id TEXT NOT NULL,
                role_id   TEXT NOT NULL,
                action    TEXT NOT NULL,
                reason    TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata  JSONB DEFAULT '{}'::jsonb
            )
        `);

        // Queue indexes
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_action_queue_status
            ON action_queue(status, attempt_count, created_at DESC)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_action_queue_guild
            ON action_queue(guild_id, status)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_action_queue_pending
            ON action_queue(status)
            WHERE status = 'PENDING'
        `);

        // Audit indexes
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_log_guild_timestamp
            ON audit_log(guild_id, timestamp DESC)
        `);

        // Notify trigger: wake the queue processor whenever a job becomes PENDING
        await client.query(`
            CREATE OR REPLACE FUNCTION notify_queue_job() RETURNS trigger AS $$
            BEGIN
                PERFORM pg_notify('queue_jobs', NEW.id::text);
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        await client.query(`
            DROP TRIGGER IF EXISTS trg_notify_queue_job ON action_queue;
            CREATE TRIGGER trg_notify_queue_job
            AFTER INSERT OR UPDATE OF status ON action_queue
            FOR EACH ROW
            WHEN (NEW.status = 'PENDING')
            EXECUTE FUNCTION notify_queue_job();
        `);

        await client.query('COMMIT');
        logger.info('Database tables initialised successfully.');

    } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Database initialisation failed: ${err.message}`);
        throw err;
    } finally {
        client.release();
    }

    // =========================================================
    // Safe Migration Execution Block (For pre-existing schemas)
    // =========================================================
    try {
        await pool.query(`
            ALTER TABLE action_queue
            ADD COLUMN IF NOT EXISTS approver_id TEXT,
            ADD COLUMN IF NOT EXISTS approval_message_id TEXT;

            ALTER TABLE config
            ADD COLUMN IF NOT EXISTS role_requests_channel_id TEXT;
        `);
        logger.info('Database migrations completed');
    } catch (migrationErr) {
        logger.error(`Non-fatal Migration Failure: ${migrationErr.message}`);
    }
}

async function listenForQueueJobs(onNotify) {
    let listenerClient;

    try {
        listenerClient = await pool.connect();

        listenerClient.on('notification', (msg) => {
            if (msg.channel === 'queue_jobs') onNotify(msg.payload);
        });

        // FIX: Isolated single-execution tracking prevents recursive listener flooding
        listenerClient.once('error', (err) => {
            logger.error(`Queue listener connection dropped: ${err.message}. Reconnecting...`);

            try {
                listenerClient.removeAllListeners();
                listenerClient.release(true); // Passes truthy value to destroy the damaged socket immediately
            } catch (_) {}

            setTimeout(() => {
                listenForQueueJobs(onNotify).catch(e =>
                    logger.error(`Queue listener reconnect failed: ${e.message}`)
                );
            }, 5000);
        });

        await listenerClient.query('LISTEN queue_jobs');
        logger.info('Listening for queue_jobs notifications');
        return listenerClient;

    } catch (err) {
        logger.error(`Failed to establish queue listener client: ${err.message}`);
        // Attempt recovery if initial connect fails
        setTimeout(() => {
            listenForQueueJobs(onNotify).catch(() => {});
        }, 10000);
    }
}

async function ensureConfigRow(guildId) {
    await dbRun(
        `INSERT INTO config (guild_id)
         VALUES ($1)
         ON CONFLICT (guild_id) DO NOTHING`,
        [guildId]
    );
}

module.exports = {
    pool, dbGet, dbRun, dbAll, initDatabase, ensureConfigRow, listenForQueueJobs
};