const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { dbGet, dbAll } = require('../lib/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('history')
        .setDescription('View role change history for a user')
        .addUserOption(o => o.setName('user').setDescription('The user to look up').setRequired(true))
        .addIntegerOption(o => o.setName('limit').setDescription('Number of entries to show (default 10, max 25)').setMinValue(1).setMaxValue(25)),

    async execute(interaction) {
        const { guild, member, options } = interaction;

        const isAdmin   = member.permissions.has(PermissionFlagsBits.Administrator);
        const isOwner   = guild.ownerId === member.id;
        const config    = await dbGet(`SELECT manager_role_id FROM config WHERE guild_id = $1`, [guild.id]);
        const isManager = config?.manager_role_id && member.roles.cache.has(config.manager_role_id);

        if (!isAdmin && !isOwner && !isManager) {
            return interaction.reply({ content: '❌ Access Denied.', flags: MessageFlags.Ephemeral });
        }

        const targetUser = options.getUser('user', true);
        const limit      = options.getInteger('limit') ?? 10;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const entries = await dbAll(
            `SELECT action, role_id, actor_id, reason, timestamp
             FROM audit_log
             WHERE guild_id = $1 AND target_id = $2
             ORDER BY timestamp DESC
             LIMIT $3`,
            [guild.id, targetUser.id, limit]
        );

        if (!entries.length) {
            return interaction.editReply({ content: `ℹ️ No role history found for <@${targetUser.id}>.` });
        }

        const lines = entries.map(e => {
            const icon = e.action === 'ADD' ? '🟢' : '🔴';
            const time = Math.floor(new Date(e.timestamp).getTime() / 1000);
            return `${icon} <@&${e.role_id}> by <@${e.actor_id}>\n-# <t:${time}:f> — ${e.reason || 'No reason provided'}`;
        });

        const embed = new EmbedBuilder()
            .setTitle(`Role History — ${targetUser.username}`)
            .setThumbnail(targetUser.displayAvatarURL())
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: `Showing ${entries.length} most recent entries` })
            .setColor(0x5865f2)
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
};