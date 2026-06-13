const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { dbGet, dbAll } = require('../lib/db');

/* =========================================================
   SECTION RUNNERS
========================================================= */

async function checkDatabase(guild, addSection) {
    try {
        const start = Date.now();
        await dbGet('SELECT 1');
        const ping = Date.now() - start;

        const tables = await dbAll(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
        const rowCounts = {};
        for (const t of tables) {
            const r = await dbGet(`SELECT COUNT(*) as count FROM "${t.tablename}"`);
            rowCounts[t.tablename] = parseInt(r?.count ?? 0, 10);
        }

        const tableSizes = await dbAll(`
            SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS size
            FROM pg_catalog.pg_statio_user_tables
            ORDER BY pg_total_relation_size(relid) DESC
        `);

        const indexHealth = await dbAll(`
            SELECT indexrelname AS indexname, relname AS tablename, idx_scan, idx_tup_read, idx_tup_fetch
            FROM pg_stat_user_indexes
            ORDER BY idx_scan DESC
            LIMIT 10
        `);

        addSection('Database Ping', ping < 100 ? 'pass' : ping < 500 ? 'warn' : 'fail',
            `Latency: **${ping}ms**`
        );

        addSection('Tables & Row Counts', 'pass',
            tables.map(t => `**${t.tablename}:** ${rowCounts[t.tablename].toLocaleString()} rows`).join('\n') || 'No tables found'
        );

        addSection('Table Sizes', 'pass',
            tableSizes.map(t => `**${t.table}:** ${t.size}`).join('\n') || 'No data'
        );

        addSection('Index Health', indexHealth.length ? 'pass' : 'warn',
            indexHealth.length
                ? indexHealth.map(i =>
                    `**${i.indexname}** on \`${i.tablename}\`\nScans: ${i.idx_scan} | Rows read: ${i.idx_tup_read}`
                  ).join('\n\n')
                : 'No indexes found'
        );

    } catch (err) {
        addSection('Database Errors', 'fail', `DB failure: ${err.message}`);
    }

    try {
        const config = await dbGet(`SELECT * FROM config WHERE guild_id=$1`, [guild.id]);
        if (!config) {
            addSection('Guild Config', 'warn', 'No config row exists for this guild.');
        } else {
            const missing = [];
            if (!config.log_channel_id)   missing.push('log_channel_id');
            if (!config.manager_role_id)  missing.push('manager_role_id');
            if (!config.protected_role_id) missing.push('protected_role_id');
            addSection('Guild Config', missing.length ? 'warn' : 'pass',
                `\`\`\`json\n${JSON.stringify(config, null, 2).slice(0, 1500)}\n\`\`\`\n` +
                `Missing fields: ${missing.length ? missing.join(', ') : 'none'}`
            );
        }
    } catch (err) {
        addSection('Guild Config Error', 'fail', err.message);
    }
}

async function checkDiscord(guild, interaction, addSection) {
    try {
        const botMember = await guild.members.fetch(interaction.client.user.id).catch(() => null);
        if (!botMember) {
            addSection('Bot Permissions', 'fail', 'Could not fetch bot member');
        } else {
            const required = ['ManageRoles', 'ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];
            const missing  = required.filter(p => !botMember.permissions.has(p));
            const all      = botMember.permissions.toArray();

            addSection('Bot Permissions', missing.length ? 'warn' : 'pass',
                `Highest role: **${botMember.roles.highest.name}** (position ${botMember.roles.highest.position})\n` +
                `Missing critical perms: ${missing.length ? missing.map(p => `\`${p}\``).join(', ') : 'none'}\n` +
                `All perms: ${all.map(p => `\`${p}\``).join(', ').slice(0, 1500)}`
            );
        }
    } catch (err) {
        addSection('Bot Permissions Error', 'fail', err.message);
    }

    try {
        const roles     = guild.roles.cache.sort((a, b) => b.position - a.position).first(15);
        const botMember = await guild.members.fetchMe().catch(() => null);
        const botTopPos = botMember?.roles?.highest?.position ?? -1;

        addSection('Role Hierarchy (Top 15)', 'pass',
            roles.map(r =>
                `**${r.position}.** ${r.name}${r.position === botTopPos ? ' ← bot' : ''}${r.managed ? ' *(managed)*' : ''}`
            ).join('\n')
        );
    } catch (err) {
        addSection('Role Hierarchy Error', 'fail', err.message);
    }

    try {
        const botMember = await guild.members.fetchMe().catch(() => null);
        if (!botMember) {
            addSection('Channel Permissions', 'fail', 'Could not fetch bot member');
        } else {
            const channels = guild.channels.cache.filter(c => c.isTextBased).first(10);
            const needed   = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
            const issues   = [];

            for (const ch of channels.values()) {
                const perms   = ch.permissionsFor(botMember);
                const missing = needed.filter(p => !perms?.has(p));
                if (missing.length) {
                    issues.push(`**#${ch.name}:** missing ${missing.map(p => `\`${p}\``).join(', ')}`);
                }
            }

            addSection('Channel Permissions', issues.length ? 'warn' : 'pass',
                issues.length
                    ? `Channels with missing permissions:\n${issues.join('\n')}`
                    : `No permission issues across ${channels.length} checked channel(s)`
            );
        }
    } catch (err) {
        addSection('Channel Permissions Error', 'fail', err.message);
    }

    try {
        const wsPing = interaction.client.ws.ping;
        addSection('WebSocket Ping', wsPing < 100 ? 'pass' : wsPing < 300 ? 'warn' : 'fail',
            `Gateway latency: **${wsPing}ms**`
        );
    } catch (err) {
        addSection('WebSocket Ping Error', 'fail', err.message);
    }

    try {
        addSection('Guild Info', 'pass',
            `Name: **${guild.name}**\n` +
            `Members: **${guild.memberCount.toLocaleString()}**\n` +
            `Channels: **${guild.channels.cache.size}**\n` +
            `Roles: **${guild.roles.cache.size}**\n` +
            `Owner: <@${guild.ownerId}>`
        );
    } catch (err) {
        addSection('Guild Info Error', 'fail', err.message);
    }
}

async function checkQueue(guild, addSection) {
    try {
        const pending = await dbAll(`
            SELECT * FROM action_queue
            WHERE guild_id=$1 AND status='PENDING'
            ORDER BY created_at ASC
            LIMIT 10
        `, [guild.id]);

        const oldest = pending[0]
            ? Math.round((Date.now() - new Date(pending[0].created_at).getTime()) / 1000)
            : null;

        addSection('Pending Jobs', 'pass',
            `Count: **${pending.length}**\n` +
            (oldest !== null ? `Oldest: **${oldest}s ago**\n` : '') +
            (pending.length
                ? '\n' + pending.map(p =>
                    `**#${p.id}** ${p.action_type} | <@${p.target_user_id}> | <@&${p.role_id}>\nQueued: ${new Date(p.created_at).toISOString()}`
                  ).join('\n\n')
                : 'No pending jobs')
        );
    } catch (err) {
        addSection('Pending Jobs Error', 'fail', err.message);
    }

    try {
        const failed = await dbAll(`
            SELECT * FROM action_queue
            WHERE guild_id=$1 AND status LIKE 'FAILED%'
            ORDER BY updated_at DESC
            LIMIT 10
        `, [guild.id]);

        addSection('Failed Jobs', failed.length ? 'warn' : 'pass',
            failed.length
                ? failed.map(f =>
                    `**#${f.id}** \`${f.status}\`\n` +
                    `Action: ${f.action_type} | Attempts: ${f.attempt_count}\n` +
                    `Error: ${f.last_error || 'none'}\n` +
                    `Last updated: ${new Date(f.updated_at).toISOString()}`
                  ).join('\n\n')
                : 'No failed jobs'
        );
    } catch (err) {
        addSection('Failed Jobs Error', 'fail', err.message);
    }

    try {
        const recent = await dbAll(`
            SELECT * FROM action_queue
            WHERE guild_id=$1 AND status='SUCCESS'
            ORDER BY updated_at DESC
            LIMIT 5
        `, [guild.id]);

        addSection('Recent Successes', 'pass',
            recent.length
                ? recent.map(j =>
                    `**#${j.id}** ${j.action_type} | <@${j.target_user_id}> | <@&${j.role_id}>\n` +
                    `Completed: ${new Date(j.updated_at).toISOString()}`
                  ).join('\n\n')
                : 'No completed jobs yet'
        );
    } catch (err) {
        addSection('Recent Successes Error', 'fail', err.message);
    }

    try {
        const lastLogs = await dbAll(`
            SELECT * FROM audit_log
            WHERE guild_id=$1
            ORDER BY timestamp DESC
            LIMIT 5
        `, [guild.id]);

        const lastTime = lastLogs[0]?.timestamp;
        const age      = lastTime ? Date.now() - new Date(lastTime).getTime() : null;

        addSection('Audit Log (Recent)', age !== null && age < 300000 ? 'pass' : 'warn',
            `Last event: **${age !== null ? Math.round(age / 1000) + 's ago' : 'never'}**\n\n` +
            (lastLogs.length
                ? lastLogs.map(l =>
                    `${new Date(l.timestamp).toISOString()}\n${l.action} | <@${l.actor_id}> → <@${l.target_id}> | <@&${l.role_id}>\n` +
                    `Reason: ${l.reason || 'none'}`
                  ).join('\n\n')
                : 'No audit entries yet')
        );
    } catch (err) {
        addSection('Audit Log Error', 'fail', err.message);
    }
}

/* =========================================================
   COMMAND
========================================================= */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('diagnostics')
        .setDescription('Run system health checks (admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        // Replaced multi-subcommands with an Option choice menu
        .addStringOption(option =>
            option.setName('target')
                .setDescription('The system module you want to run diagnostics on')
                .setRequired(true)
                .addChoices(
                    { name: 'Full System', value: 'full' },
                    { name: 'Discord Bot & API', value: 'discord' },
                    { name: 'Queue & Action Logs', value: 'queue' },
                    { name: 'Database Engine', value: 'database' }
                )),

    async execute(interaction) {
        const { guild, member } = interaction;
        const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
        const isOwner = guild.ownerId === member.id;

        if (!isAdmin && !isOwner) {
            return interaction.reply({
                content: '❌ Only server administrators can run diagnostics.',
                ephemeral: true
            });
        }

        await interaction.deferReply({ ephemeral: true });

        // Retrieve option value instead of subcommand name
        const targetModule = interaction.options.getString('target');
        const report = { passed: 0, warnings: 0, failed: 0, sections: [] };

        const addSection = (title, status, details) => {
            const icon = status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : '❌';
            report.sections.push(`${icon} **${title}**\n${details}`);
            if (status === 'pass') report.passed++;
            else if (status === 'warn') report.warnings++;
            else report.failed++;
        };

        if (targetModule === 'database' || targetModule === 'full') await checkDatabase(guild, addSection);
        if (targetModule === 'discord'  || targetModule === 'full') await checkDiscord(guild, interaction, addSection);
        if (targetModule === 'queue'    || targetModule === 'full') await checkQueue(guild, addSection);

        const titles = {
            full:     'Full System Diagnostics',
            discord:  'Discord Diagnostics',
            queue:    'Queue & Audit Diagnostics',
            database: 'Database Diagnostics'
        };

        const summary = `PASS: ${report.passed} | WARN: ${report.warnings} | FAIL: ${report.failed}`;
        const header  = `**Summary:** ${summary}\n\n`;
        const color   = report.failed > 0 ? 0xe74c3c : report.warnings > 0 ? 0xf1c40f : 0x2ecc71;

        const chunks  = [];
        let current   = header;

        for (const section of report.sections) {
            if ((current + '\n\n' + section).length > 3500) {
                chunks.push(current);
                current = section;
            } else {
                current += (current === header ? '' : '\n\n') + section;
            }
        }
        chunks.push(current);

        const finalChunks = chunks.slice(0, 10);

        const embeds = finalChunks.map((chunk, i) =>
            new EmbedBuilder()
                .setTitle(i === 0 ? titles[targetModule] : `${titles[targetModule]} (cont.)`)
                .setColor(color)
                .setDescription(chunk)
                .setTimestamp(i === finalChunks.length - 1 ? new Date() : null)
        );

        return interaction.editReply({ embeds });
    }
};