const { 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits
} = require('discord.js');
const { dbGet, dbRun } = require('../lib/db');
const logger = require('../lib/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('requestrole')
        .setDescription('Submit a role request for approval')
        .addUserOption(o => o.setName('user').setDescription('The user who needs the role (NOT YOURSELF)').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('The role being requested').setRequired(true))
        .addStringOption(o => o.setName('reason')
            .setDescription('Business owners/public sector recruiters must provide proof in reason (Imgur link, Trello, etc.)')
            .setRequired(true)
            .setMaxLength(500)),

    async execute(interaction) {
        const { guild, member, options } = interaction;

        const blacklisted = await dbGet(
            `SELECT 1 FROM request_blacklist WHERE guild_id = $1 AND user_id = $2`,
            [guild.id, member.id]
        );

        if (blacklisted) {
            return interaction.reply({
                content: '❌ You are blacklisted from using the role request system. Please contact a server administrator.',
                flags: MessageFlags.Ephemeral
            });
        }        

        // 1. Fetch server configuration
        const config = await dbGet(
            `SELECT role_requests_channel_id, protected_role_id FROM config WHERE guild_id = $1`,
            [guild.id]
        );
        
        // 2. Validate configuration
        const approvalChannelId = config?.role_requests_channel_id;
        if (!approvalChannelId) {
            return interaction.reply({
                content: '❌ Setup incomplete. A dedicated Role Requests channel has not been configured by an administrator.',
                flags: MessageFlags.Ephemeral
            });
        }

        // 3. Extract and Validate Options (Declared ONLY ONCE here)
        const targetUser = options.getUser('user', true);
        const targetRole = options.getRole('role', true);
        const reason = options.getString('reason', true).trim();

        if (targetUser.bot) {
            return interaction.reply({ content: '❌ You cannot request roles for bots.', flags: MessageFlags.Ephemeral });
        }

        if (targetRole.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Administrator roles cannot be requested.', flags: MessageFlags.Ephemeral });
        }

        // 4. Duplicate Request Check
        const existing = await dbGet(
            `SELECT id FROM action_queue
            WHERE guild_id = $1 AND target_user_id = $2 AND role_id = $3 AND status = 'AWAITING_APPROVAL'`,
            [guild.id, targetUser.id, targetRole.id]
        );

        if (existing) {
            return interaction.reply({ content: '⚠️ This request is already pending approval.', flags: MessageFlags.Ephemeral });
        }

        // 5. Fetch Member and Hierarchy Checks
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            return interaction.reply({ content: '❌ Could not find that user in this server.', flags: MessageFlags.Ephemeral });
        }

        if (targetMember.roles.cache.has(targetRole.id)) {
            return interaction.reply({ content: `ℹ️ <@${targetUser.id}> already has the **${targetRole.name}** role.`, flags: MessageFlags.Ephemeral });
        }

        const botMember = await guild.members.fetchMe();
        if (targetRole.position >= botMember.roles.highest.position) {
            return interaction.reply({
                content: `❌ I cannot assign **${targetRole.name}** because it is higher than my highest role in the hierarchy.`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (config?.protected_role_id && targetRole.id === config.protected_role_id) {
            return interaction.reply({ content: `❌ **${targetRole.name}** is a protected role and cannot be requested.`, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Tracked outside the try block so the catch handler can reference it
        // even if the failure happens after the INSERT (the DB row already exists by then).
        let requestId;

        try {
            // 6. Insert into Database
            const result = await dbRun(
                `INSERT INTO action_queue
                    (guild_id, actor_id, target_user_id, role_id, action_type, reason, status)
                VALUES ($1, $2, $3, $4, 'ADD', $5, 'AWAITING_APPROVAL')
                RETURNING id`,
                [guild.id, member.id, targetUser.id, targetRole.id, reason]
            );

            requestId = result?.rows?.[0]?.id;
            if (!requestId) throw new Error('DB failed to return Request ID');

            // 7. Notify Target User (DM)
            const isSelfRequest = member.id === targetUser.id;
            const targetDmEmbed = new EmbedBuilder()
                .setColor(0xf1c40f)
                .setTitle('📩 Role Request')
                .setDescription(
                    isSelfRequest 
                        ? `You have requested the **${targetRole.name}** role for yourself.` 
                        : `<@${member.id}> has requested the **${targetRole.name}** role for you.`
                )
                .addFields({ name: 'Reason', value: reason });

            await targetUser.send({ embeds: [targetDmEmbed] }).catch(() => {
                logger.warn(`[Request #${requestId}] Could not DM user ${targetUser.id} about role request.`);
            });

            // 8. Send to Approval Channel
            const approvalChannel = await guild.channels.fetch(approvalChannelId).catch(() => null);
            if (!approvalChannel || !approvalChannel.isTextBased()) {
                logger.error(`[Request #${requestId}] Approval channel ${approvalChannelId} invalid or inaccessible.`);
                return interaction.editReply({ content: '❌ Configured approval channel is invalid or inaccessible.' });
            }

            const approvalEmbed = new EmbedBuilder()
                .setColor(0xF1C40F) 
                .setTitle('📋 Role Request Pending')
                .setDescription(`A new role assignment requires authorization.`)
                .addFields(
                    { name: 'Target User', value: `<@${targetUser.id}>`, inline: true },
                    { name: 'Requested Role', value: `${targetRole.name}`, inline: true },
                    { name: 'Requested By', value: `<@${member.id}>`, inline: false },
                    { name: 'Reason', value: `\`\`\`${reason}\`\`\`` }
                )
                .setTimestamp();

            const buttons = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`approve_${requestId}`)
                    .setLabel('Approve')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`deny_${requestId}`)
                    .setLabel('Deny')
                    .setStyle(ButtonStyle.Danger)
            );

            const approvalMessage = await approvalChannel.send({ embeds: [approvalEmbed], components: [buttons] });

            // 9. Update Job with Message ID for later reference
            await dbRun(
                `UPDATE action_queue SET approval_message_id = $1 WHERE id = $2`,
                [approvalMessage.id, requestId]
            );

            return interaction.editReply({ 
                content: `✅ Request successfully submitted. A moderator will review it.` 
            });

        } catch (err) {
            const context = requestId ? `Request #${requestId}` : 'pre-insert';
            logger.error(`Error in /requestrole [${context}]: ${err.message}`);
            return interaction.editReply({ content: '❌ An error occurred while processing your request.' });
        }
    }
};