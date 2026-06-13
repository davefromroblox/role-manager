const { EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { dbGet, dbRun } = require('../lib/db');
const { audit } = require('../lib/helpers');
const logger = require('../lib/logger');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction) {
        const { guild, member, user } = interaction;

        // Basic safety: ignore interactions outside of guilds
        if (!guild || !member) {
            if (interaction.isRepliable()) {
                return interaction.reply({ content: '❌ This bot can only be used in servers.', ephemeral: true });
            }
            return;
        }

        /* =========================================================
           BRANCH 1: SLASH COMMANDS
        ========================================================= */
        if (interaction.isChatInputCommand()) {
            // BLACKLIST CHECK: Prevents blacklisted users from running any commands
            const blacklisted = await dbGet(
                `SELECT 1 FROM request_blacklist WHERE guild_id = $1 AND user_id = $2`,
                [guild.id, user.id]
            );

            if (blacklisted && interaction.commandName === 'requestrole') {
                return interaction.reply({
                    content: '❌ You are blacklisted from using the role request system.',
                    ephemeral: true
                });
            }

            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) return;

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
           BRANCH 2: BUTTON INTERACTIONS (Approval/Denial)
        ========================================================= */
        if (interaction.isButton()) {
            const { customId } = interaction;
            if (!customId.startsWith('approve_') && !customId.startsWith('deny_')) return;

            const [action, requestId] = customId.split('_');

            try {
                // 1. AUTHORIZATION CHECK (Must be fast to prevent "Interaction Failed")
                const config = await dbGet(
                    `SELECT manager_role_id FROM config WHERE guild_id = $1`,
                    [guild.id]
                );

                const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
                const isOwner = guild.ownerId === member.id;
                const isManager = config?.manager_role_id && member.roles.cache.has(config.manager_role_id);

                if (!isAdmin && !isOwner && !isManager) {
                    return interaction.reply({
                        content: '❌ Access Denied. You do not have permission to review role requests.',
                        ephemeral: true
                    });
                }

                // 2. STATUS CHECK: Verify job is still awaiting approval
                const job = await dbGet(
                    `SELECT status FROM action_queue WHERE id = $1`,
                    [requestId]
                );

                if (!job || job.status !== 'AWAITING_APPROVAL') {
                    return interaction.reply({
                        content: '❌ This request has already been processed or no longer exists.',
                        ephemeral: true
                    });
                }

                // 3. SHOW MODAL
                const modal = new ModalBuilder()
                    .setCustomId(`reviewmodal_${action}_${requestId}`)
                    .setTitle(`Review Request #${requestId}`);

                const reasonInput = new TextInputBuilder()
                    .setCustomId('review_reason')
                    .setLabel(`${action === 'approve' ? 'Approval' : 'Denial'} Note`)
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Provide a reason for the users...')
                    .setRequired(true)
                    .setMaxLength(500);

                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                return interaction.showModal(modal);

            } catch (err) {
                logger.error(`Button Interaction Error: ${err.message}`);
                return interaction.reply({ content: '❌ Error processing interaction.', ephemeral: true }).catch(() => {});
            }
        }

        /* =========================================================
           BRANCH 3: MODAL SUBMISSIONS
        ========================================================= */
        if (interaction.isModalSubmit()) {
            const { customId } = interaction;
            if (!customId.startsWith('reviewmodal_')) return;

            const [_, action, requestId] = customId.split('_');
            const staffReason = interaction.fields.getTextInputValue('review_reason').trim();

            try {
                // Defer update immediately to stop the "thinking" state on the modal
                await interaction.deferUpdate();

                const job = await dbGet(`SELECT * FROM action_queue WHERE id = $1`, [requestId]);
                if (!job || job.status !== 'AWAITING_APPROVAL') {
                    return interaction.followUp({ content: '❌ This request was already processed.', ephemeral: true });
                }

                const requester = await guild.members.fetch(job.actor_id).catch(() => null);
                const targetMember = await guild.members.fetch(job.target_user_id).catch(() => null);
                const role = await guild.roles.fetch(job.role_id).catch(() => null);
                const roleName = role?.name || 'Unknown Role';
                const isSelfRequest = job.actor_id === job.target_user_id;

                if (action === 'approve') {
                    await dbRun(
                        `UPDATE action_queue 
                        SET status = 'PENDING', 
                            approver_id = $1, 
                            last_error = $2, 
                            updated_at = CURRENT_TIMESTAMP 
                        WHERE id = $3`,
                        [member.id, `Approved: ${staffReason}`, requestId] // Storing note in last_error (or a dedicated col)
                    );

                    // Notify users
                    const approveColor = 0x2ecc71;
                    if (targetMember) {
                        const embed = new EmbedBuilder()
                            .setColor(approveColor)
                            .setTitle('✅ Request Approved')
                            .setDescription(isSelfRequest ? `Your request for **${roleName}** was accepted.` : `<@${job.actor_id}>'s request for you was accepted.`)
                            .addFields({ name: 'Staff Note', value: staffReason });
                        await targetMember.send({ embeds: [embed] }).catch(() => {});
                    }
                    if (requester && !isSelfRequest) {
                        const embed = new EmbedBuilder()
                            .setColor(approveColor)
                            .setTitle('✅ Request Approved')
                            .setDescription(`Your request for <@${job.target_user_id}> to receive **${roleName}** was accepted.`)
                            .addFields({ name: 'Staff Note', value: staffReason });
                        await requester.send({ embeds: [embed] }).catch(() => {});
                    }
                } else {
                    await dbRun(`UPDATE action_queue SET status = 'DENIED' WHERE id = $1`, [requestId]);

                    // Manual Audit for Denial
                    await audit({
                        guildId: guild.id, actorId: member.id, targetId: job.target_user_id,
                        roleId: job.role_id, action: 'DENIED', reason: `Staff Note: ${staffReason}`
                    });

                    // Notify users
                    const denyColor = 0xe74c3c;
                    if (targetMember) {
                        const embed = new EmbedBuilder()
                            .setColor(denyColor)
                            .setTitle('❌ Request Denied')
                            .setDescription(isSelfRequest ? `Your request for **${roleName}** was denied.` : `<@${job.actor_id}>'s request for you was denied.`)
                            .addFields({ name: 'Reason', value: staffReason });
                        await targetMember.send({ embeds: [embed] }).catch(() => {});
                    }
                    if (requester && !isSelfRequest) {
                        const embed = new EmbedBuilder()
                            .setColor(denyColor)
                            .setTitle('❌ Request Denied')
                            .setDescription(`Your request for <@${job.target_user_id}> to receive **${roleName}** was denied.`)
                            .addFields({ name: 'Reason', value: staffReason });
                        await requester.send({ embeds: [embed] }).catch(() => {});
                    }
                }

                // Update the moderator's log message
                const finalEmbed = new EmbedBuilder()
                    .setColor(action === 'approve' ? 0x2ecc71 : 0xe74c3c)
                    .setTitle(action === 'approve' ? '✅ Request Approved' : '❌ Request Denied')
                    .addFields(
                        { name: 'Target User', value: `<@${job.target_user_id}>`, inline: true },
                        { name: 'Role', value: roleName, inline: true },
                        { name: 'Requested By', value: `<@${job.actor_id}>`, inline: true },
                        { name: 'Original Reason', value: job.reason || 'None' },
                        { name: 'Staff Note', value: staffReason },
                        { name: 'Processed By', value: `<@${member.id}>`, inline: true }
                    )
                    .setFooter({ text: `ID: #${requestId}` })
                    .setTimestamp();

                await interaction.message.edit({ embeds: [finalEmbed], components: [] });

            } catch (err) {
                logger.error(`Modal Submission Error: ${err.message}`);
            }
        }
    }
};