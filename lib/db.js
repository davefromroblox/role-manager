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
    const result = await pool.query(q, p);
    return result.rows[0] || null;
};

const dbRun = async (q, p = []) => {
    return pool.query(q, p);
};

const dbAll = async (q, p = []) => {
    const result = await pool.query(q, p);
    return result.rows;
};

async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Added 'role_requests_channel_id' directly into the core table generation
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
            CREATE INDEX IF NOT EXISTS idx_action_queue_status
            ON action_queue(status, attempt_count, created_at DESC)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_action_queue_guild
            ON action_queue(guild_id, status)
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

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_log_guild_timestamp
            ON audit_log(guild_id, timestamp DESC)
        `);

        await client.query('COMMIT');
        logger.info('Database tables initialised');
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Database initialisation failed: ${err.message}`);
        throw err;
    } finally {
        client.release();
    }

    // Migrations — Safe execution patterns for existing live application installations
    await pool.query(`
        ALTER TABLE action_queue
        ADD COLUMN IF NOT EXISTS approver_id         TEXT,
        ADD COLUMN IF NOT EXISTS approval_message_id TEXT
    `);

    // NEW MIGRATION: Appends the separate channel tracking field into pre-existing configurations safely
    await pool.query(`
        ALTER TABLE config
        ADD COLUMN IF NOT EXISTS role_requests_channel_id TEXT
    `);
}

async function ensureConfigRow(guildId) {
    await dbRun(
        `INSERT INTO config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
        [guildId]
    );
}

module.exports = { pool, dbGet, dbRun, dbAll, initDatabase, ensureConfigRow };