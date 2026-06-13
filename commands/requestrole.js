const { 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} = require('discord.js');
const { dbGet, dbRun } = require('../lib/db');
const logger = require('../lib/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('requestrole')
        .setDescription('Submit a role request for approval')
        .addUserOption(o => o.setName('user').setDescription('The user who needs the role').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('The role being requested').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Justification for this request').setRequired(true)),

    async execute(interaction) {
        const { guild, member, options } = interaction;

        // Fetch server configuration
        const config = await dbGet(
            `SELECT log_channel_id, protected_role_id FROM config WHERE guild_id = $1`,
            [guild.id]
        );

        // Fallback to interaction channel if no explicit administration log channel is configured
        const approvalChannelId = config?.log_channel_id;
        if (!approvalChannelId) {
            return interaction.reply({
                content: '❌ Setup incomplete. An administrative log/approval channel has not been configured for this server.',
                ephemeral: true
            });
        }

        const targetUser = options.getUser('user', true);
        const targetRole = options.getRole('role', true);
        const reason = options.getString('reason', true).trim();

        // 1. Fetch target member and validate current state
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            return interaction.reply({ content: '❌ Could not find that user in this server.', ephemeral: true });
        }

        if (targetMember.roles.cache.has(targetRole.id)) {
            return interaction.reply({
                content: `ℹ️ <@${targetUser.id}> already has the **${targetRole.name}** role.`,
                ephemeral: true
            });
        }

        // 2. Protected role baseline guardrail
        if (config?.protected_role_id && targetRole.id === config.protected_role_id) {
            return interaction.reply({
                content: `❌ **${targetRole.name}** is a highly protected role and cannot be requested via this system.`,
                ephemeral: true
            });
        }

        // Defer reply since we are hitting external webhooks/channels
        await interaction.deferReply({ ephemeral: true });

        try {
            // 3. Generate a tracking ID by inserting the initial record as 'AWAITING_APPROVAL'
            const result = await dbRun(
                `INSERT INTO action_queue
                    (guild_id, actor_id, target_user_id, role_id, action_type, reason, status)
                 VALUES ($1, $2, $3, $4, 'ADD', $5, 'AWAITING_APPROVAL')
                 RETURNING id`,
                [guild.id, member.id, targetUser.id, targetRole.id, reason]
            );
            
            // Note: Adjust depending on your wrapper framework. 
            // If dbRun returns the row array directly via pg client, extract the id:
            const requestId = result.rows?.[0]?.id || result.insertId; 

            // 4. Build the Interactive Approval Card Layout
            const approvalChannel = await guild.channels.fetch(approvalChannelId).catch(() => null);
            if (!approvalChannel || !approvalChannel.isTextBased()) {
                return interaction.editReply({ content: '❌ Configured approval channel is invalid or inaccessible.' });
            }

            const embed = new EmbedBuilder()
                .setColor(0xF1C40F) // Amber / Warning tone
                .setTitle('📋 Role Request Pending')
                .setDescription(`A new role assignment requires authorization.`)
                .addFields(
                    { name: 'Target User', value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
                    { name: 'Requested Role', value: `${targetRole} (\`${targetRole.id}\`)`, inline: true },
                    { name: 'Requested By', value: `<@${member.id}>`, inline: false },
                    { name: 'Reason', value: `\`\`\`${reason}\`\`\`` }
                )
                .setFooter({ text: `Request ID: # ${requestId}` })
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

            const approvalMessage = await approvalChannel.send({ embeds: [embed], components: [buttons] });

            // 5. Update queue record with the message context for tracking/cleanup later
            await dbRun(
                `UPDATE action_queue SET approval_message_id = $1 WHERE id = $2`,
                [approvalMessage.id, requestId]
            );

            return interaction.editReply({ 
                content: `✅ Request **#${requestId}** has been sent to the administration channel for review.` 
            });

        } catch (err) {
            logger.error(`Database/API error in /requestrole: ${err.message}`);
            return interaction.editReply({ content: '❌ An error occurred while routing your request.' });
        }
    }
};