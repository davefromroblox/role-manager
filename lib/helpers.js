const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { dbGet, dbRun } = require('./db');
const logger = require('./logger');

function parseDuration(str) {
    const m = /^(\d+)([smhd])$/.exec(str || '');
    if (!m) return null;
    const v = Number(m[1]);
    if (v <= 0) return null;
    const map = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return v * map[m[2]];
}

function canManage(member, config, targetRole) {
    if (!member) return false;
    if (member.id === member.guild.ownerId) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (config.manager_role_id) {
        if (!member.roles.cache.has(config.manager_role_id)) return false;
    } else {
        return false;
    }
    if (targetRole && member.roles.highest.position <= targetRole.position) return false;
    return true;
}

function botCanManage(guild, role) {
    const bot = guild.members.me;
    if (!bot?.roles?.highest) return false;
    return role.position < bot.roles.highest.position;
}

async function audit(entry) {
    try {
        await dbRun(
            `INSERT INTO audit_log (guild_id, actor_id, target_id, role_id, action, reason, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
                { name: 'Target',   value: `<@${target.id}>\n-# ${target.username} (${target.id})`,   inline: true },
                { name: 'Executor', value: `<@${executor.id}>\n-# ${executor.username} (${executor.id})`, inline: true },
                { name: 'Role',     value: role.id ? `<@&${role.id}>` : `${role.name ?? role}`,        inline: true },
                { name: 'Reason',   value: reason || 'None provided' }
            )
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (err) {
        logger.error(`logAction failed: ${err.message}`);
    }
}

module.exports = { parseDuration, canManage, botCanManage, audit, logAction };
