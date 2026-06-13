const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { dbGet, dbRun } = require('../lib/db');
const logger = require('../lib/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('role')
        .setDescription('Advanced role management system')
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a role to a user')
            .addUserOption(o => o.setName('user').setDescription('The user').setRequired(true))
            .addRoleOption(o => o.setName('role').setDescription('The role to add').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for this action').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a role from a user')
            .addUserOption(o => o.setName('user').setDescription('The user').setRequired(true))
            .addRoleOption(o => o.setName('role').setDescription('The role to remove').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for this action').setRequired(true))),

    async execute(interaction) {
        const { guild, member, options } = interaction;

        if (!member?.roles) {
            return interaction.reply({ content: '❌ Unable to access your member data.', ephemeral: true });
        }

        const config = await dbGet(
            `SELECT manager_role_id, reason_required, protected_role_id FROM config WHERE guild_id = $1`,
            [guild.id]
        );

        const managerRoleId      = config?.manager_role_id ?? null;
        const reasonRequired     = (config?.reason_required ?? 0) === 1;
        const isAdmin            = member.permissions.has(PermissionFlagsBits.Administrator);
        const isOwner            = guild.ownerId === member.id;
        const subcommand         = options.getSubcommand();
        const targetUser         = options.getUser('user', true);
        const targetRole         = options.getRole('role', true);
        const rawReason          = options.getString('reason');

        if (!targetUser || !targetRole) {
            return interaction.reply({ content: '❌ Invalid user or role provided.', ephemeral: true });
        }

        if (reasonRequired && (!rawReason || !rawReason.trim())) {
            return interaction.reply({
                content: '❌ A reason is required.\nThis server requires a reason when assigning or removing roles.',
                ephemeral: true
            });
        }

        const reason = rawReason?.trim() || 'No reason provided';

        // Authorization
        const isAuthorized = isAdmin || isOwner || (managerRoleId && member.roles.cache.has(managerRoleId));
        if (!isAuthorized) {
            return interaction.reply({
                content: '❌ Access Denied.\nYou must be a server admin or hold the configured manager role.',
                ephemeral: true
            });
        }

        // Bot hierarchy check
        const botMember = await guild.members.fetchMe().catch(() => null);
        if (!botMember) {
            return interaction.reply({ content: '❌ Could not fetch bot member data.', ephemeral: true });
        }

        if (targetRole.position >= botMember.roles.highest.position) {
            return interaction.reply({
                content: `❌ I cannot manage **${targetRole.name}** — it's above my highest role.\nMove my role above it in server settings.`,
                ephemeral: true
            });
        }

        // User hierarchy check
        if (!isOwner && !isAdmin && targetRole.position >= member.roles.highest.position) {
            return interaction.reply({
                content: `❌ You cannot manage **${targetRole.name}** — it's equal to or above your highest role.`,
                ephemeral: true
            });
        }

        // Protected role check
        if (config?.protected_role_id && targetRole.id === config.protected_role_id) {
            return interaction.reply({
                content: `❌ **${targetRole.name}** is a protected role and cannot be modified.`,
                ephemeral: true
            });
        }

        try {
            const type = subcommand.toUpperCase();
            await dbRun(
                `INSERT INTO action_queue
                    (guild_id, actor_id, target_user_id, role_id, action_type, reason, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')`,
                [guild.id, member.id, targetUser.id, targetRole.id, type, reason]
            );
            logger.info(`[${guild.id}] Queued ${type} ${targetRole.id} for ${targetUser.id}`);
            return interaction.reply({
                content: `**${type}** ${targetRole} for <@${targetUser.id}>, this may take some time to process, depending on the queue length.`,
                ephemeral: true
            });
        } catch (err) {
            logger.error(`Database error in /role: ${err.message}`);
            return interaction.reply({ content: '❌ Database error occurred.', ephemeral: true });
        }
    }
};
