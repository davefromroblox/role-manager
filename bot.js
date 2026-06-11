require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Pool } = require('pg');

/* =========================================================
   CONFIG
========================================================= */

const DATABASE_URL = process.env.DATABASE_URL;
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
    console.error('❌ Missing required environment variables: DISCORD_TOKEN');
    process.exit(1);
}

if (!DATABASE_URL) {
    console.error('❌ Missing required environment variables: DATABASE_URL');
    process.exit(1);
}

/* =========================================================
   LOGGING
========================================================= */

const logger = {
    info: (msg) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${new Date().toISOString()} ${msg}`),
    error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`),
    debug: (msg) => {
        if (process.env.DEBUG) console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`);
    }
};

/* =========================================================
   ERROR HANDLING
========================================================= */

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    console.error(promise);
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    console.error(error);
    process.exit(1);
});

/* =========================================================
   DB
========================================================= */

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.on('error', (err) => {
    logger.error(`Unexpected error on idle client: ${err.message}`);
});

const dbGet = async (q, p) => {
    const result = await pool.query(q, p);
    return result.rows[0] || null;
};

const dbRun = async (q, p) => {
    return pool.query(q, p);
};

const dbAll = async (q, p) => {
    const result = await pool.query(q, p);
    return result.rows;
};

/* =========================================================
   INIT
========================================================= */

async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Config table
        await client.query(`
            CREATE TABLE IF NOT EXISTS config (
                guild_id TEXT PRIMARY KEY,
                log_channel_id TEXT,
                manager_role_id TEXT,
                protected_role_id TEXT,
                reason_required INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Action queue table
        await client.query(`
            CREATE TABLE IF NOT EXISTS action_queue (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                target_user_id TEXT NOT NULL,
                role_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                reason TEXT,
                status TEXT DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP,
                attempt_count INTEGER DEFAULT 0,
                last_error TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create indexes for better query performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_action_queue_status 
            ON action_queue(status, attempt_count, created_at DESC)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_action_queue_guild 
            ON action_queue(guild_id, status)
        `);

        // Audit log table
        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                role_id TEXT NOT NULL,
                action TEXT NOT NULL,
                reason TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata JSONB DEFAULT '{}'::jsonb
            )
        `);

        // Create indexes for audit log
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_log_guild_timestamp 
            ON audit_log(guild_id, timestamp DESC)
        `);

        await client.query('COMMIT');
        logger.info('Database tables initialized');
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Database initialization failed: ${err.message}`);
        throw err;
    } finally {
        client.release();
    }
}

/* =========================================================
   CORE HELPERS
========================================================= */

async function ensureConfigRow(guildId) {
    await dbRun(
        `INSERT INTO config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
        [guildId]
    );
}

function parseDuration(str) {
    const m = /^(\d+)([smhd])$/.exec(str || '');
    if (!m) return null;

    const v = Number(m[1]);
    if (v <= 0) return null;

    const map = {
        s: 1000,
        m: 60000,
        h: 3600000,
        d: 86400000
    };

    return v * map[m[2]];
}

function canManage(member, config, targetRole) {
    if (!member) return false;

    // Absolute Overrides - Allows setup on fresh installs
    if (member.id === member.guild.ownerId) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

    // Lockdown logic for everyone else
    if (config.manager_role_id) {
        if (!member.roles.cache.has(config.manager_role_id)) return false;
    } else {
        return false; 
    }

    // Target role check (only matters if targetRole is passed)
    if (targetRole && member.roles.highest.position <= targetRole.position) {
        return false;
    }

    return true;
}

function botCanManage(guild, role) {
    const bot = guild.members.me;
    if (!bot?.roles?.highest) return false;
    return role.position < bot.roles.highest.position;
}

/* =========================================================
   AUDIT
========================================================= */

async function audit(entry) {
    try {
        await dbRun(
            `INSERT INTO audit_log (
                guild_id, actor_id, target_id,
                role_id, action, reason, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                entry.guildId,
                entry.actorId,
                entry.targetId,
                entry.roleId,
                entry.action,
                entry.reason || null,
                JSON.stringify(entry.meta || {})
            ]
        );
    } catch (err) {
        logger.error(`Audit log failed: ${err.message}`);
    }
}

/* =========================================================
   QUEUE
========================================================= */

async function enqueue(job) {
    try {
        return dbRun(
            `INSERT INTO action_queue (
                guild_id, actor_id, target_user_id,
                role_id, action_type, reason,
                expires_at, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')`,
            [
                job.guildId,
                job.actorId,
                job.targetId,
                job.roleId,
                job.type,
                job.reason || null,
                job.expiresAt ? new Date(job.expiresAt) : null
            ]
        );
    } catch (err) {
        logger.error(`Enqueue failed: ${err.message}`);
        throw err;
    }
}

/* =========================================================
   INTERACTION HANDLER
========================================================= */

async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member, options } = interaction;

    if (!guild || !member) {
        return interaction.reply({
            content: "❌ This command can only be used in a server.",
            ephemeral: true
        });
    }

    try {
        /* =========================================================
           LOAD CONFIG (SAFE DEFAULTS)
        ========================================================= */
        const config = await dbGet(
            `SELECT manager_role_id, reason_required, log_channel_id, protected_role_id
             FROM config WHERE guild_id = $1`,
            [guild.id]
        );

        const managerRoleId = config?.manager_role_id ?? null;
        const reasonRequiredSetting = config?.reason_required ?? 0;

        const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
        const isOwner = guild.ownerId === member.id;

        /* =========================================================
           COMMAND: DIAGNOSTICS
        ========================================================= */
        if (commandName === 'diagnostics') {
            if (!isAdmin && !isOwner) {
                return interaction.reply({
                    content: "❌ Only server administrators can run diagnostics.",
                    ephemeral: true
                });
            }
            return runDiagnostics(interaction);
        }

        /* =========================================================
           COMMAND: CONFIG
        ========================================================= */
        if (commandName === 'config') {
            if (!isAdmin && !isOwner) {
                return interaction.reply({
                    content: "❌ Only server administrators can use config commands.",
                    ephemeral: true
                });
            }

            const subcommand = options.getSubcommand();

            await ensureConfigRow(guild.id);

            if (subcommand === 'log-channel') {
                const channel = options.getChannel('channel', true);
                if (!channel) {
                    return interaction.reply({
                        content: "❌ Invalid channel provided.",
                        ephemeral: true
                    });
                }
                await dbRun("UPDATE config SET log_channel_id = $1, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $2", [channel.id, guild.id]);
                logger.info(`[${guild.id}] Log channel updated to ${channel.id}`);
                return interaction.reply({ content: `✅ Log channel updated to ${channel}.`, ephemeral: true });
            }

            if (subcommand === 'manager-role') {
                const role = options.getRole('role', true);
                if (!role) {
                    return interaction.reply({
                        content: "❌ Invalid role provided.",
                        ephemeral: true
                    });
                }
                await dbRun("UPDATE config SET manager_role_id = $1, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $2", [role.id, guild.id]);
                logger.info(`[${guild.id}] Manager role updated to ${role.id}`);
                return interaction.reply({ content: `✅ Manager role set to ${role}.`, ephemeral: true });
            }

            if (subcommand === 'protected-role') {
                const role = options.getRole('role', true);
                if (!role) {
                    return interaction.reply({
                        content: "❌ Invalid role provided.",
                        ephemeral: true
                    });
                }
                await dbRun("UPDATE config SET protected_role_id = $1, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $2", [role.id, guild.id]);
                logger.info(`[${guild.id}] Protected role updated to ${role.id}`);
                return interaction.reply({ content: `✅ Protected role set to ${role}.`, ephemeral: true });
            }

            if (subcommand === 'reason-required') {
                const enabled = options.getBoolean('enabled', true) ? 1 : 0;
                await dbRun("UPDATE config SET reason_required = $1, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $2", [enabled, guild.id]);
                logger.info(`[${guild.id}] Reason requirement set to ${enabled}`);
                return interaction.reply({ content: `✅ Reason requirement: **${enabled ? "ENABLED" : "DISABLED"}**`, ephemeral: true });
            }
        }

        /* =========================================================
           COMMAND: ROLE
           Hierarchy & Authorization Checks (Verbose)
        ========================================================= */
        if (commandName === 'role') {
            if (!member?.roles) {
                return interaction.reply({
                    content: "❌ Unable to access your member data.",
                    ephemeral: true
                });
            }

            const subcommand = options.getSubcommand();
            const targetUser = options.getUser('user', true);
            const targetRole = options.getRole('role', true);
            const rawReason = options.getString('reason'); // may be null
            const reasonRequired = reasonRequiredSetting === 1;

            if (!targetUser || !targetRole) {
                return interaction.reply({
                    content: "❌ Invalid user or role provided.",
                    ephemeral: true
                });
            }

            if (reasonRequired && (!rawReason || !rawReason.trim())) {
                return interaction.reply({
                    content: "❌ A reason is required.\nThis server requires moderators to provide a reason when assigning or removing roles.",
                    ephemeral: true
                });
            }

            const reason = rawReason?.trim() || 'No reason provided';

            // 1. Authorization & Hierarchy Checks
            const isAuthorized = isAdmin || (managerRoleId && member.roles.cache.has(managerRoleId));
            if (!isAuthorized) {
                return interaction.reply({
                    content: "❌ Access Denied.\nYou must be a server admin or hold the configured manager role to use role commands.",
                    ephemeral: true
                });
            }

            const botMember = await guild.members.fetchMe().catch(() => null);
            if (!botMember) {
                return interaction.reply({
                    content: "❌ Bot member inaccessible.\nI could not fetch my own member data, which is required to check role hierarchy.",
                    ephemeral: true
                });
            }

            // Bot hierarchy check
            if (targetRole.position >= botMember.roles.highest.position) {
                return interaction.reply({
                    content: `❌ I cannot manage the role **${targetRole.name}**.\nThis role is equal to or higher than my highest role in the server hierarchy. 
To fix this, move my bot role above **${targetRole.name}** in the server role settings.`,
                    ephemeral: true
                });
            }

            // User hierarchy check
            if (!isOwner && !isAdmin && targetRole.position >= member.roles.highest.position) {
                return interaction.reply({
                    content: `❌ You cannot manage the role **${targetRole.name}**.\nThis role is equal to or higher than your highest role. 
Discord prevents moderators from modifying roles above their own position in the hierarchy.`,
                    ephemeral: true
                });
            }

            // 2. Logic Handler
            try {
                if (['add', 'remove'].includes(subcommand)) {
                    const type = subcommand.toUpperCase();
                    await dbRun(
                        `INSERT INTO action_queue (guild_id, actor_id, target_user_id, role_id, action_type, reason, status) 
                         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')`,
                        [guild.id, member.id, targetUser.id, targetRole.id, type, reason]
                    );
                    logger.info(`[${guild.id}] Queued ${type} ${targetRole.id} for ${targetUser.id}`);
                    return interaction.reply({
                        content: `⏱️ Queued: **${type}** ${targetRole} for <@${targetUser.id}>`,
                        ephemeral: true
                    });
                }
            } catch (err) {
                logger.error(`Database error in role command: ${err.message}`);
                return interaction.reply({ content: "❌ Database error occurred.", ephemeral: true });
            }
        }
    } catch (err) {
        logger.error(`[handleInteraction] ${err.message}`);
        try {
            return interaction.reply({
                content: "❌ An unexpected error occurred.",
                ephemeral: true
            });
        } catch (replyErr) {
            logger.error(`Failed to send error reply: ${replyErr.message}`);
        }
    }
}

/* =========================================================
   DIAGNOSTICS
========================================================= */

async function runDiagnostics(interaction) {
    const { guild } = interaction;

    await interaction.deferReply({ ephemeral: true });

    const report = {
        passed: 0,
        warnings: 0,
        failed: 0,
        sections: []
    };

    const addSection = (title, status, details) => {
        const icon =
            status === 'pass' ? '✅' :
            status === 'warn' ? '⚠️' : '❌';

        report.sections.push(`${icon} **${title}**\n${details}`);
        if (status === 'pass') report.passed++;
        else if (status === 'warn') report.warnings++;
        else report.failed++;
    };

    // =========================
    // 1. DB HEALTH (DEEP)
    // =========================
    try {
        const start = Date.now();
        await dbGet('SELECT 1');
        const duration = Date.now() - start;

        const tables = await dbAll(`
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public'
        `, []);

        const rowCounts = {};
        for (const t of tables) {
            const r = await dbGet(`SELECT COUNT(*) as count FROM ${t.tablename}`, []);
            rowCounts[t.tablename] = parseInt(r.count);
        }

        addSection(
            'Database Health Check',
            'pass',
            `Ping: ${duration}ms
Tables: ${tables.map(t => t.tablename).join(', ')}
Row counts: ${JSON.stringify(rowCounts, null, 2)}`
        );

    } catch (err) {
        addSection(
            'Database Health Check',
            'fail',
            `DB failure: ${err.message}`
        );
    }

    // =========================
    // 2. CONFIG STATE INSPECTION
    // =========================
    try {
        const config = await dbGet(
            `SELECT * FROM config WHERE guild_id = $1`,
            [guild.id]
        );

        if (!config) {
            addSection(
                'Guild Config',
                'warn',
                `No config row exists for this guild`
            );
        } else {
            const missing = [];

            if (!config.log_channel_id) missing.push('log_channel_id');
            if (!config.manager_role_id) missing.push('manager_role_id');
            if (!config.protected_role_id) missing.push('protected_role_id');

            addSection(
                'Guild Config',
                missing.length ? 'warn' : 'pass',
                `Raw Config:
${JSON.stringify(config, null, 2)}

Missing fields: ${missing.length ? missing.join(', ') : 'none'}`
            );
        }
    } catch (err) {
        addSection(
            'Guild Config',
            'fail',
            err.message
        );
    }

    // =========================
    // 3. DISCORD PERMISSIONS DEEP CHECK
    // =========================
    try {
        const botMember = await guild.members.fetch(interaction.client.user.id).catch(() => null);
        if (!botMember) {
            addSection(
                'Bot Permissions',
                'fail',
                'Could not fetch bot member'
            );
        } else {
            const perms = botMember.permissions.toArray();
            const role = botMember.roles.highest;

            const required = [
                'ManageRoles',
                'ViewChannel',
                'SendMessages'
            ];

            const missing = required.filter(p => !botMember.permissions.has(p));

            addSection(
                'Bot Permissions',
                missing.length ? 'warn' : 'pass',
                `Permissions:
${perms.join(', ')}

Highest role position: ${role.position}

Missing critical perms: ${missing.length ? missing.join(', ') : 'none'}`
            );
        }

    } catch (err) {
        addSection(
            'Bot Permissions',
            'fail',
            err.message
        );
    }

    // =========================
    // 4. QUEUE INSPECTION
    // =========================
    try {
        const pending = await dbAll(`
            SELECT * FROM action_queue
            WHERE status='PENDING'
            ORDER BY created_at DESC
            LIMIT 10
        `, []);

        addSection(
            'Action Queue',
            'pass',
            `Pending jobs: ${pending.length}

Sample:
${pending.slice(0, 3).map(p =>
    `- ${p.action_type} | user:${p.target_user_id} | role:${p.role_id}`
).join('\n') || 'none'}`
        );

    } catch (err) {
        addSection(
            'Action Queue',
            'fail',
            err.message
        );
    }

    // =========================
    // 5. AUDIT LOG SANITY CHECK
    // =========================
    try {
        const lastLogs = await dbAll(`
            SELECT * FROM audit_log
            ORDER BY timestamp DESC
            LIMIT 5
        `, []);

        const lastTime = lastLogs[0]?.timestamp;
        const age = lastTime ? Date.now() - new Date(lastTime).getTime() : null;

        addSection(
            'Audit Log Stream',
            age && age < 60000 ? 'pass' : 'warn',
            `Last event age: ${age ? Math.round(age / 1000) + 's' : 'never'}

Recent entries:
${lastLogs.map(l =>
    `${new Date(l.timestamp).toISOString()} | ${l.action} | ${l.actor_id} → ${l.target_id}`
).join('\n') || 'none'}`
        );

    } catch (err) {
        addSection(
            'Audit Log Stream',
            'fail',
            err.message
        );
    }

    // =========================
    // FINAL REPORT
    // =========================
    const summary =
        `PASS: ${report.passed} | WARN: ${report.warnings} | FAIL: ${report.failed}`;

    const embed = new EmbedBuilder()
        .setTitle('System Diagnostics (Verbose Mode)')
        .setColor(report.failed > 0 ? 0xe74c3c :
                 report.warnings > 0 ? 0xf1c40f : 0x2ecc71)
        .setDescription(
            `**Summary:** ${summary}\n\n` +
            report.sections.join('\n\n')
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

/* =========================================================
   WORKER
========================================================= */

const MAX_RETRIES = 5;
const BATCH_SIZE = 20;

async function processQueue(client) {
    try {
        const jobs = await dbAll(
            `SELECT * FROM action_queue 
             WHERE status = 'PENDING' AND attempt_count < $1
             ORDER BY created_at ASC
             LIMIT $2`,
            [MAX_RETRIES, BATCH_SIZE]
        );

        for (const job of jobs) {
            try {
                // Mark as in progress immediately (prevents double-processing)
                await dbRun(
                    `UPDATE action_queue SET status='IN_PROGRESS', updated_at = CURRENT_TIMESTAMP WHERE id=$1 AND status='PENDING'`,
                    [job.id]
                );

                const guild = await client.guilds.fetch(job.guild_id).catch(() => null);
                if (!guild) {
                    await dbRun(
                        `UPDATE action_queue SET status='FAILED_MISSING_CONTEXT', updated_at = CURRENT_TIMESTAMP WHERE id=$1`,
                        [job.id]
                    );
                    logger.warn(`Job ${job.id}: Guild not found`);
                    continue;
                }

                const member = await guild.members
                    .fetch(job.target_user_id, { force: true })
                    .catch(() => null);

                const role = await guild.roles
                    .fetch(job.role_id)
                    .catch(() => null);

                if (!member || !role) {
                    await dbRun(
                        `UPDATE action_queue SET status='FAILED_MISSING_CONTEXT', updated_at = CURRENT_TIMESTAMP WHERE id=$1`,
                        [job.id]
                    );
                    logger.warn(`Job ${job.id}: Member or role not found`);
                    continue;
                }

                // Prevent role hierarchy issues
                const botMember = await guild.members.fetchMe().catch(() => null);
                if (!botMember) {
                    await dbRun(
                        `UPDATE action_queue SET status='FAILED_INSUFFICIENT_PERMS', updated_at = CURRENT_TIMESTAMP WHERE id=$1`,
                        [job.id]
                    );
                    logger.warn(`Job ${job.id}: Bot member not found`);
                    continue;
                }

                if (role.position >= botMember.roles.highest.position) {
                    await dbRun(
                        `UPDATE action_queue SET status='FAILED_INSUFFICIENT_PERMS', updated_at = CURRENT_TIMESTAMP WHERE id=$1`,
                        [job.id]
                    );
                    logger.warn(`Job ${job.id}: Bot cannot manage role due to hierarchy`);
                    continue;
                }

                const hasRole = member.roles.cache.has(role.id);

                if (job.action_type === 'ADD') {
                    if (!hasRole) {
                        await member.roles.add(role, job.reason || undefined);
                        logger.info(`Job ${job.id}: Role ${role.id} added to ${member.id}`);
                    }
                } else if (job.action_type === 'REMOVE') {
                    if (hasRole) {
                        await member.roles.remove(role, job.reason || undefined);
                        logger.info(`Job ${job.id}: Role ${role.id} removed from ${member.id}`);
                    }
                } else {
                    throw new Error(`Unknown action_type: ${job.action_type}`);
                }

                await audit({
                    guildId: guild.id,
                    actorId: job.actor_id,
                    targetId: job.target_user_id,
                    roleId: job.role_id,
                    action: job.action_type,
                    reason: job.reason
                });

                await dbRun(
                    `UPDATE action_queue SET status='SUCCESS', updated_at = CURRENT_TIMESTAMP WHERE id=$1`,
                    [job.id]
                );

                // Safe executor fetch
                let executorUser;
                try {
                    executorUser = await client.users.fetch(job.actor_id);
                } catch {
                    executorUser = {
                        id: job.actor_id,
                        username: `Unknown (${job.actor_id})`
                    };
                }

                const displayAction = job.action_type;

                try {
                    await logAction(
                        guild,
                        executorUser,
                        member,
                        role,
                        displayAction,
                        job.reason
                    );
                } catch (logErr) {
                    logger.error(`Queue log dispatch failed: ${logErr.message}`);
                }

                // Small delay to avoid rate limits
                await new Promise(r => setTimeout(r, 250));

            } catch (e) {
                await dbRun(
                    `UPDATE action_queue
                     SET attempt_count = attempt_count + 1,
                         last_error = $1,
                         status = CASE 
                             WHEN attempt_count + 1 >= $2 THEN 'FAILED_RETRIES_EXCEEDED'
                             ELSE 'PENDING'
                         END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id=$3`,
                    [e.message, MAX_RETRIES, job.id]
                );

                logger.error(`Queue error [Job ${job.id}]: ${e.message}`);
            }
        }
    } catch (err) {
        logger.error(`Queue processing failed: ${err.message}`);
    }
}

/* =========================================================
   BOOT
========================================================= */

async function start() {
    try {
        await initDatabase();

        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMembers
            ]
        });

        client.on('ready', () => {
            logger.info(`Logged in as ${client.user.tag}`);
            
            client.user.setPresence({
                activities: [
                    {
                        name: 'with your roles',
                        type: 'PLAYING'
                    }
                ],
                status: 'online'
            });
        }); 

        client.on('interactionCreate', handleInteraction);

        client.on('error', (err) => {
            logger.error(`Client error: ${err.message}`);
        });

        const queueInterval = setInterval(() => {
            processQueue(client).catch(err => {
                logger.error(`Queue processing error: ${err.message}`);
            });
        }, 5000);

        await client.login(TOKEN);

        // Graceful shutdown
        const shutdown = async () => {
            logger.info('Shutting down gracefully...');
            clearInterval(queueInterval);
            client.destroy();
            await pool.end();
            logger.info('Database connection closed');
            process.exit(0);
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

    } catch (err) {
        logger.error(`Startup failed: ${err.message}`);
        process.exit(1);
    }
}

start();

/* =========================================================
   LOG ACTION
========================================================= */

async function logAction(guild, executor, target, role, action, reason) {
    try {
        const config = await dbGet(
            `SELECT log_channel_id FROM config WHERE guild_id = $1`,
            [guild.id]
        );

        if (!config?.log_channel_id) return;

        const channel = guild.channels.cache.get(config.log_channel_id);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setTitle(`🛡️ Role Action: ${action}`)
            .setColor(
                action.toUpperCase().includes('ADD') || action.toUpperCase().includes('RESTORED')
                    ? 0x2ecc71
                    : 0xe74c3c
            )
            .addFields(
                { 
                    name: 'Target', 
                    value: `<@${target.id}>\n-# ${target.username} (${target.id})`, 
                    inline: true 
                },
                { 
                    name: 'Executor', 
                    value: `<@${executor.id}>\n-# ${executor.username} (${executor.id})`, 
                    inline: true 
                },
                { 
                    name: 'Role', 
                    value: role.id ? `<@&${role.id}>` : `${role.name ?? role}`, 
                    inline: true 
                },
                { 
                    name: 'Reason', 
                    value: reason || 'None provided' 
                }
            )
            .setTimestamp();
        await channel.send({ embeds: [embed] });

    } catch (err) {
        logger.error(`Log action failed: ${err.message}`);
    }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
    pool,
    initDatabase,
    handleInteraction,
    processQueue,
    runDiagnostics,
    parseDuration,
    logAction
};
