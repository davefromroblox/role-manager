// ADDED THIS IMPORT AT THE TOP
const { EmbedBuilder } = require('discord.js'); 
const { dbGet, dbRun, dbAll } = require('./db');
const { audit, logAction } = require('./helpers');
const logger = require('./logger');

const MAX_RETRIES = 5;
const BATCH_SIZE  = 20;

async function enqueue(job) {
    try {
        return dbRun(
            `INSERT INTO action_queue
                (guild_id, actor_id, target_user_id, role_id, action_type, reason, expires_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')`,
            [
                job.guildId,
                job.actorId,
                job.targetId,
                job.roleId,
                job.type,
                job.reason || null,
                job.expiresAt ? new Date(job.expiresAt) : null
            ]
        );
    } catch (err) {
        logger.error(`Enqueue failed: ${err.message}`);
        throw err;
    }
}

async function processQueue(client) {
    try {
        const jobs = await dbAll(
            `SELECT * FROM action_queue
             WHERE status = 'PENDING' AND attempt_count < $1
             ORDER BY created_at ASC
             LIMIT $2`,
            [MAX_RETRIES, BATCH_SIZE]
        );

        for (const job of jobs) {
            try {
                await dbRun(
                    `UPDATE action_queue
                     SET status='IN_PROGRESS', updated_at=CURRENT_TIMESTAMP
                     WHERE id=$1 AND status='PENDING'`,
                    [job.id]
                );

                const guild = await client.guilds.fetch(job.guild_id).catch(() => null);
                if (!guild) {
                    await dbRun(`UPDATE action_queue SET status='FAILED_MISSING_CONTEXT' WHERE id=$1`, [job.id]);
                    continue;
                }

                const member = await guild.members.fetch(job.target_user_id, { force: true }).catch(() => null);
                const role   = await guild.roles.fetch(job.role_id).catch(() => null);

                if (!member || !role) {
                    await dbRun(`UPDATE action_queue SET status='FAILED_MISSING_CONTEXT' WHERE id=$1`, [job.id]);
                    continue;
                }

                const botMember = await guild.members.fetchMe().catch(() => null);
                if (!botMember || role.position >= botMember.roles.highest.position) {
                    await dbRun(`UPDATE action_queue SET status='FAILED_INSUFFICIENT_PERMS' WHERE id=$1`, [job.id]);
                    continue;
                }

                const hasRole = member.roles.cache.has(role.id);

                if (job.action_type === 'ADD') {
                    if (!hasRole) {
                        await member.roles.add(role, job.reason || undefined);
                        
                        // Final Success DM to the target user
                        const successDm = new EmbedBuilder()
                            .setColor(0x2ecc71)
                            .setTitle('✨ Role Added')
                            .setDescription(`The **${role.name}** role has been successfully given.`)
                            .setTimestamp();
                            
                        await member.send({ embeds: [successDm] }).catch(() => {});
                    }
                } else if (job.action_type === 'REMOVE') {
                    if (hasRole) await member.roles.remove(role, job.reason || undefined);
                }

                const finalActorId = job.approver_id || job.actor_id;

                await audit({
                    guildId:  guild.id,
                    actorId:  finalActorId, // Correctly credits the moderator for approved roles
                    targetId: job.target_user_id,
                    roleId:   job.role_id,
                    action:   job.action_type,
                    reason:   job.last_error?.startsWith('Approved:') ? job.last_error : job.reason
                });

                await dbRun(
                    `UPDATE action_queue SET status='SUCCESS', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
                    [job.id]
                );

                let executorUser = await client.users.fetch(job.actor_id).catch(() => ({ id: job.actor_id, username: 'Unknown' }));
                await logAction(guild, executorUser, member, role, job.action_type, job.reason);

                await new Promise(r => setTimeout(r, 250));

            } catch (e) {
                await dbRun(
                    `UPDATE action_queue
                     SET attempt_count = attempt_count + 1,
                         last_error    = $1,
                         status        = CASE WHEN attempt_count + 1 >= $2 THEN 'FAILED_RETRIES_EXCEEDED' ELSE 'PENDING' END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $3`,
                    [e.message, MAX_RETRIES, job.id]
                );
                logger.error(`Queue error [Job ${job.id}]: ${e.message}`);
            }
        }
    } catch (err) {
        logger.error(`Queue processing failed: ${err.message}`);
    }
}

module.exports = { enqueue, processQueue };