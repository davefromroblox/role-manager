// commands/config.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { dbRun, ensureConfigRow } = require('../lib/db');
const logger = require('../lib/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configure the role manager settings')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => sub
            .setName('log-channel')
            .setDescription('Set the channel where role actions are logged')
            .addChannelOption(o => o.setName('channel').setDescription('The log channel').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('requests-channel')
            .setDescription('Set the channel where role requests are sent for approval')
            .addChannelOption(o => o.setName('channel').setDescription('The role requests channel').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('manager-role')
            .setDescription('Set a role that grants access to this bot')
            .addRoleOption(o => o.setName('role').setDescription('The manager role').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('protected-role')
            .setDescription('Protect a role from being modified')
            .addRoleOption(o => o.setName('role').setDescription('The protected role').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('blacklist-add')
            .setDescription('Prevent a user from using /requestrole')
            .addUserOption(o => o.setName('user').setDescription('The user to blacklist').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('blacklist-remove')
            .setDescription('Allow a user to use /requestrole again')
            .addUserOption(o => o.setName('user').setDescription('The user to remove from blacklist').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('reason-required')
            .setDescription('Require a reason for all role actions')
            .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable').setRequired(true))),

    async execute(interaction) {
        const { guild, member, options } = interaction;
        const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
        const isOwner = guild.ownerId === member.id;

        if (!isAdmin && !isOwner) {
            return interaction.reply({
                content: '❌ Only server administrators can use config commands.',
                ephemeral: true
            });
        }

        await ensureConfigRow(guild.id);
        const subcommand = options.getSubcommand();

        if (subcommand === 'log-channel') {
            const channel = options.getChannel('channel', true);

            await dbRun(
                `UPDATE config SET log_channel_id=$1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$2`,
                [channel.id, guild.id]
            );

            logger.info(`[${guild.id}] Log channel set to ${channel.id}`);

            return interaction.reply({
                content: `✅ Log channel set to ${channel}.`,
                ephemeral: true
            });
        }

        if (subcommand === 'requests-channel') {
            const channel = options.getChannel('channel', true);

            await dbRun(
                `UPDATE config SET role_requests_channel_id=$1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$2`,
                [channel.id, guild.id]
            );

            logger.info(`[${guild.id}] Role requests channel set to ${channel.id}`);

            return interaction.reply({
                content: `✅ Role requests channel set to ${channel}.`,
                ephemeral: true
            });
        }

        if (subcommand === 'manager-role') {
            const role = options.getRole('role', true);

            await dbRun(
                `UPDATE config SET manager_role_id=$1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$2`,
                [role.id, guild.id]
            );

            logger.info(`[${guild.id}] Manager role set to ${role.id}`);

            return interaction.reply({
                content: `✅ Manager role set to ${role}.`,
                ephemeral: true
            });
        }

        if (subcommand === 'protected-role') {
            const role = options.getRole('role', true);

            await dbRun(
                `UPDATE config SET protected_role_id=$1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$2`,
                [role.id, guild.id]
            );

            logger.info(`[${guild.id}] Protected role set to ${role.id}`);

            return interaction.reply({
                content: `✅ Protected role set to ${role}.`,
                ephemeral: true
            });
        }

        if (subcommand === 'reason-required') {
            const enabled = options.getBoolean('enabled', true) ? 1 : 0;

            await dbRun(
                `UPDATE config SET reason_required=$1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$2`,
                [enabled, guild.id]
            );

            logger.info(`[${guild.id}] Reason required set to ${enabled}`);

            return interaction.reply({
                content: `✅ Reason requirement: **${enabled ? 'ENABLED' : 'DISABLED'}**`,
                ephemeral: true
            });
        }

        if (subcommand === 'blacklist-add') {
            const target = options.getUser('user', true);

            await dbRun(
                `INSERT INTO request_blacklist (guild_id, user_id, added_by)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [guild.id, target.id, member.id]
            );

            return interaction.reply({
                content: `🚫 <@${target.id}> has been blacklisted from requesting roles.`,
                ephemeral: true
            });
        }

        if (subcommand === 'blacklist-remove') {
            const target = options.getUser('user', true);

            await dbRun(
                `DELETE FROM request_blacklist WHERE guild_id = $1 AND user_id = $2`,
                [guild.id, target.id]
            );

            return interaction.reply({
                content: `✅ <@${target.id}> is no longer blacklisted.`,
                ephemeral: true
            });
        }
    }
};