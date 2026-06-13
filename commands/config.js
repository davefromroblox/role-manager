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
            .setName('manager-role')
            .setDescription('Set a role that grants access to this bot')
            .addRoleOption(o => o.setName('role').setDescription('The manager role').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('protected-role')
            .setDescription('Protect a role from being modified')
            .addRoleOption(o => o.setName('role').setDescription('The protected role').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('reason-required')
            .setDescription('Require a reason for all role actions')
            .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable').setRequired(true))),

    async execute(interaction) {
        const { guild, member, options } = interaction;
        const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
        const isOwner = guild.ownerId === member.id;

        if (!isAdmin && !isOwner) {
            return interaction.reply({ content: '❌ Only server administrators can use config commands.', ephemeral: true });
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
            return interaction.reply({ content: `✅ Log channel set to ${channel}.`, ephemeral: true });
        }

        if (subcommand === 'manager-role') {
            const role = options.getRole('role', true);
            await dbRun(
                `UPDATE config SET manager_role_id=$1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$2`,
                [role.id, guild.id]
            );
            logger.info(`[${guild.id}] Manager role set to ${role.id}`);
            return interaction.reply({ content: `✅ Manager role set to ${role}.`, ephemeral: true });
        }

        if (subcommand === 'protected-role') {
            const role = options.getRole('role', true);
            await dbRun(
                `UPDATE config SET protected_role_id=$1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$2`,
                [role.id, guild.id]
            );
            logger.info(`[${guild.id}] Protected role set to ${role.id}`);
            return interaction.reply({ content: `✅ Protected role set to ${role}.`, ephemeral: true });
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
    }
};
