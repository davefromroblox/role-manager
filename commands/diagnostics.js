const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { dbGet, dbAll } = require('../lib/db');

/* =========================================================
   COMMAND READINESS & SIMULATION (SMOKE TESTS)
========================================================= */

async function checkCommandReadiness(interaction, addSection) {
    const { guild, client } = interaction;
    try {
        const config = await dbGet(`SELECT * FROM config WHERE guild_id=$1`, [guild.id]);
        const botMember = await guild.members.fetchMe();
        const results = [];

        // 1. Simulation: /requestrole
        const reqChannelId = config?.role_requests_channel_id;
        const reqFileLoaded = client.commands.has('requestrole');
        
        if (!reqFileLoaded) {
            results.push('❌ **/requestrole**: Command file failed to load.');
        } else if (!reqChannelId) {
            results.push('⚠️ **/requestrole**: Impaired (Approval channel not configured).');
        } else {
            const chan = await guild.channels.fetch(reqChannelId).catch(() => null);
            if (!chan) {
                results.push('❌ **/requestrole**: Broken (Configured channel no longer exists).');
            } else {
                const perms = chan.permissionsFor(botMember);
                const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter(p => !perms.has(p));
                if (missing.length) {
                    results.push(`❌ **/requestrole**: Broken (Missing perms in channel: ${missing.join(', ')}).`);
                } else {
                    results.push('✅ **/requestrole**: Operational (Simulation passed).');
                }
            }
        }

        // 2. Simulation: /role (Add/Remove)
        const roleFileLoaded = client.commands.has('role');
        if (!roleFileLoaded) {
            results.push('❌ **/role**: Command file failed to load.');
        } else if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
            results.push('❌ **/role**: Broken (Bot missing global `Manage Roles` permission).');
        } else if (botMember.roles.highest.position <= 1) {
            results.push('⚠️ **/role**: Impaired (Bot hierarchy position is too low).');
        } else {
            results.push('✅ **/role**: Operational (Simulation passed).');
        }

        // 3. Simulation: /history
        const historyFileLoaded = client.commands.has('history');
        const auditTableExists = await dbGet(`SELECT 1 FROM pg_tables WHERE tablename = 'audit_log'`);
        
        if (!historyFileLoaded) {
            results.push('❌ **/history**: Command file failed to load.');
        } else if (!auditTableExists) {
            results.push('❌ **/history**: Broken (Database table `audit_log` missing).');
        } else {
            results.push('✅ **/history**: Operational (Simulation passed).');
        }

        // 4. Simulation: /config & Blacklist
        const configFileLoaded = client.commands.has('config');
        const blacklistTableExists = await dbGet(`SELECT 1 FROM pg_tables WHERE tablename = 'request_blacklist'`);
        
        if (!configFileLoaded) {
            results.push('❌ **/config**: Command file failed to load.');
        } else if (!blacklistTableExists) {
            results.push('⚠️ **/config**: Impaired (Blacklist table missing).');
        } else {
            results.push('✅ **/config**: Operational (Simulation passed).');
        }

        // 5. Simulation: Logging System
        const logChannelId = config?.log_channel_id;
        if (!logChannelId) {
            results.push('⚠️ **Logging**: Disabled (No channel configured).');
        } else {
            const chan = await guild.channels.fetch(logChannelId).catch(() => null);
            if (!chan) {
                results.push('❌ **Logging**: Broken (Channel missing).');
            } else {
                results.push('✅ **Logging**: Operational.');
            }
        }

        const status = results.some(r => r.startsWith('❌')) ? 'fail' : results.some(r => r.startsWith('⚠️')) ? 'warn' : 'pass';
        addSection('Command Simulation', status, results.join('\n'));

    } catch (err) {
        addSection('Command Simulation Error', 'fail', err.message);
    }
}

/* =========================================================
   DATABASE CHECK
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

        addSection('Database Ping', ping < 100 ? 'pass' : ping < 500 ? 'warn' : 'fail', `Latency: **${ping}ms**`);

        addSection('Tables & Row Counts', 'pass',
            tables.map(t => `**${t.tablename}:** ${rowCounts[t.tablename].toLocaleString()} rows`).join('\n') || 'No tables found'
        );

        const hasBlacklist = tables.some(t => t.tablename === 'request_blacklist');
        addSection('Schema Validation', hasBlacklist ? 'pass' : 'fail', 
            hasBlacklist ? '✅ `request_blacklist` table found.' : '❌ `request_blacklist` table is missing!'
        );

    } catch (err) {
        addSection('Database Errors', 'fail', `DB failure: ${err.message}`);
    }
}

/* =========================================================
   DISCORD & QUEUE CHECKS (Standard structure maintained)
========================================================= */

async function checkDiscord(guild, interaction, addSection) {
    try {
        const botMember = await guild.members.fetch(interaction.client.user.id);
        const wsPing = interaction.client.ws.ping;
        addSection('WebSocket Ping', wsPing < 100 ? 'pass' : 'warn', `Gateway latency: **${wsPing}ms**`);
        addSection('Guild Info', 'pass', `Members: **${guild.memberCount}**\nRoles: **${guild.roles.cache.size}**`);
    } catch (err) { addSection('Discord Check Error', 'fail', err.message); }
}

async function checkQueue(guild, addSection) {
    try {
        const pending = await dbAll(`SELECT COUNT(*) as count FROM action_queue WHERE guild_id=$1 AND status='PENDING'`, [guild.id]);
        const failed = await dbAll(`SELECT COUNT(*) as count FROM action_queue WHERE guild_id=$1 AND status LIKE 'FAILED%'`, [guild.id]);
        addSection('Queue Status', 'pass', `Pending: **${pending[0].count}**\nFailed: **${failed[0].count}**`);
    } catch (err) { addSection('Queue Check Error', 'fail', err.message); }
}

/* =========================================================
   COMMAND EXECUTION
========================================================= */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('diagnostics')
        .setDescription('Run system health checks (admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option =>
            option.setName('target')
                .setDescription('The system module you want to run diagnostics on')
                .setRequired(true)
                .addChoices(
                    { name: 'Full System', value: 'full' },
                    { name: 'Command Simulation', value: 'commands' },
                    { name: 'Discord Bot & API', value: 'discord' },
                    { name: 'Queue & Action Logs', value: 'queue' },
                    { name: 'Database Engine', value: 'database' }
                )),

    async execute(interaction) {
        const { guild, member } = interaction;
        if (!member.permissions.has(PermissionFlagsBits.Administrator) && guild.ownerId !== member.id) {
            return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const targetModule = interaction.options.getString('target');
        const report = { passed: 0, warnings: 0, failed: 0, sections: [] };

        const addSection = (title, status, details) => {
            const icon = status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : '❌';
            report.sections.push(`${icon} **${title}**\n${details}`);
            if (status === 'pass') report.passed++;
            else if (status === 'warn') report.warnings++;
            else report.failed++;
        };

        // Execution Logic
        if (targetModule === 'commands' || targetModule === 'full') await checkCommandReadiness(interaction, addSection);
        if (targetModule === 'database' || targetModule === 'full') await checkDatabase(guild, addSection);
        if (targetModule === 'discord'  || targetModule === 'full') await checkDiscord(guild, interaction, addSection);
        if (targetModule === 'queue'    || targetModule === 'full') await checkQueue(guild, addSection);

        const titles = {
            full: 'Full System Diagnostics',
            commands: 'Command Simulation Check',
            discord: 'Discord Diagnostics',
            queue: 'Queue Diagnostics',
            database: 'Database Diagnostics'
        };

        const summary = `PASS: ${report.passed} | WARN: ${report.warnings} | FAIL: ${report.failed}`;
        const header  = `**Summary:** ${summary}\n\n`;
        const color   = report.failed > 0 ? 0xe74c3c : report.warnings > 0 ? 0xf1c40f : 0x2ecc71;

        const chunks = [];
        let current = header;
        for (const section of report.sections) {
            if ((current + '\n\n' + section).length > 3500) {
                chunks.push(current);
                current = section;
            } else {
                current += (current === header ? '' : '\n\n') + section;
            }
        }
        chunks.push(current);

        const embeds = chunks.slice(0, 10).map((chunk, i) =>
            new EmbedBuilder()
                .setTitle(i === 0 ? titles[targetModule] : `${titles[targetModule]} (cont.)`)
                .setColor(color)
                .setDescription(chunk)
                .setTimestamp(i === chunks.length - 1 ? new Date() : null)
        );

        return interaction.editReply({ embeds });
    }
};