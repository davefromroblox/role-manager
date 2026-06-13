const { EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { dbGet, dbRun } = require('../lib/db');
const logger = require('../lib/logger');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction) {

        /* =========================================================
           BRANCH 1: SLASH COMMANDS
        ========================================================= */
        if (interaction.isChatInputCommand()) {
            const { guild, member } = interaction;

            if (!guild || !member) {
                return interaction.reply({
                    content: '❌ This command can only be used in a server.',
                    ephemeral: true
                });
            }

            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                logger.warn(`Unknown command: ${interaction.commandName}`);
                return;
            }

            try {
                await command.execute(interaction);
            } catch (err) {
                logger.error(`Error in /${interaction.commandName}: ${err.message}`);
                const reply = { content: '❌ An unexpected error occurred.', ephemeral: true };
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(reply).catch(() => {});
                } else {
                    await interaction.reply(reply).catch(() => {});
                }
            }

            return;
        }

        /* =========================================================
           BRANCH 2: BUTTON INTERACTIONS
        ========================================================= */
        if (interaction.isButton()) {
            const { customId, guild, member } = interaction;

            if (!customId.startsWith('approve_') && !customId.startsWith('deny_')) return;

            const [action, requestId] = customId.split('_');

            // Authorization
            const config = await dbGet(
                `SELECT manager_role_id FROM config WHERE guild_id = $1`,
                [guild.id]
            );

            const isAdmin   = member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner   = guild.ownerId === member.id;
            const isManager = config?.manager_role_id && member.roles.cache.has(config.manager_role_id);

            if (!isAdmin && !isOwner && !isManager) {
                return interaction.reply({
                    content: '❌ Access Denied. You must be an administrator or hold the configured manager role.',
                    ephemeral: true
                });
            }

            // Verify job is still awaiting approval
            const job = await dbGet(
                `SELECT status FROM action_queue WHERE id = $1`,
                [requestId]
            );

            if (!job || job.status !== 'AWAITING_APPROVAL') {
                return interaction.reply({
                    content: '❌ This request has already been processed or does not exist.',
                    ephemeral: true
                });
            }

            // Show reason modal to the staff member
            const modal = new ModalBuilder()
                .setCustomId(`reviewmodal_${action}_${requestId}`)
                .setTitle(`Review Request #${requestId}`);

            const reasonInput = new TextInputBuilder()
                .setCustomId('review_reason')
                .setLabel(`${action === 'approve' ? 'Approval' : 'Denial'} Reason`)
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Enter your reason here...')
                .setRequired(true)
                .setMaxLength(500);

            modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

            return interaction.showModal(modal);
        }

        /* =========================================================
           BRANCH 3: MODAL SUBMISSIONS
        ========================================================= */
        if (interaction.isModalSubmit()) {
            const { customId, guild, member } = interaction;

            if (!customId.startsWith('reviewmodal_')) return;

            // customId format: reviewmodal_approve_123 or reviewmodal_deny_123
            const parts     = customId.split('_');
            const action    = parts[1];
            const requestId = parts[2];

            const staffReason = interaction.fields.getTextInputValue('review_reason').trim();

            await interaction.deferUpdate();

            // Re-check job status — another mod may have acted while the modal was open
            const job = await dbGet(
                `SELECT * FROM action_queue WHERE id = $1`,
                [requestId]
            );

            if (!job || job.status !== 'AWAITING_APPROVAL') {
                return interaction.followUp({
                    content: '❌ This request was modified by another administrator while you were typing.',
                    ephemeral: true
                });
            }

            const embed = EmbedBuilder.from(interaction.message.embeds[0]);

            if (action === 'approve') {
                await dbRun(
                    `UPDATE action_queue
                     SET status = 'PENDING', approver_id = $1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [member.id, requestId]
                );

                embed
                    .setColor(0x2ecc71)
                    .setTitle('✅ Role Request Approved')
                    .addFields(
                        { name: 'Approved By', value: `<@${member.id}>`, inline: true },
                        { name: 'Reason', value: `\`\`\`${staffReason}\`\`\`` }
                    );

                logger.info(`[${guild.id}] Request #${requestId} APPROVED by ${member.id}`);

            } else {
                await dbRun(
                    `UPDATE action_queue
                     SET status = 'DENIED', approver_id = $1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [member.id, requestId]
                );

                embed
                    .setColor(0xe74c3c)
                    .setTitle('❌ Role Request Denied')
                    .addFields(
                        { name: 'Denied By', value: `<@${member.id}>`, inline: true },
                        { name: 'Reason', value: `\`\`\`${staffReason}\`\`\`` }
                    );

                logger.info(`[${guild.id}] Request #${requestId} DENIED by ${member.id}`);
            }

            // Remove buttons so the embed can't be actioned again
            await interaction.message.edit({ embeds: [embed], components: [] });
        }
    }
};