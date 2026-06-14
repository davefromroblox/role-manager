const { EmbedBuilder } = require('discord.js'); 
const { dbGet, dbRun, dbAll } = require('./db');
const { audit, logAction } = require('./helpers');
const logger = require('./logger');

const MAX_RETRIES = 5;
const BATCH_SIZE  = 20;

let isProcessing = false; // The Lock

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
    if (isProcessing) return; // Exit if already running

    try {
        // 1. Fetch first WITHOUT throwing the lock yet. 
        // This is perfectly safe since JS is single-threaded up to the first await.
        const jobs = await dbAll(
            `SELECT * FROM action_queue
             WHERE status = 'PENDING' AND COALESCE(attempt_count, 0) < $1
             ORDER BY created_at ASC
             LIMIT $2`,
            [MAX_RETRIES, BATCH_SIZE]
        );

        if (jobs.length === 0) return; // Safe early exit here!

        isProcessing = true; // 🔐 Lock it now that we officially have work to do
        //logger.info(`Processing ${jobs.length} queued jobs...`);

        for (const job of jobs) {
            try {
                await dbRun(
                    `UPDATE action_queue
                     SET status='IN_PROGRESS', updated_at=CURRENT_TIMESTAMP
                     WHERE id=$1 AND status='PENDING'`,
                    [job.id]
                );

                const guild = await client.guilds.fetch(job.guild_id).catch((e) => {
                    logger.warn(`[Job ${job.id}] guilds.fetch(${job.guild_id}) failed: ${e.message}`);
                    return null;
                });
                if (!guild) {
                    await dbRun(`UPDATE action_queue SET status='FAILED_MISSING_CONTEXT' WHERE id=$1`, [job.id]);
                    continue;
                }

                const member = await guild.members.fetch({ user: job.target_user_id, force: true }).catch((e) => {
                    logger.warn(`[Job ${job.id}] members.fetch(${job.target_user_id}) failed: ${e.message}`);
                    return null;
                });
                const role = await guild.roles.fetch(job.role_id).catch((e) => {
                    logger.warn(`[Job ${job.id}] roles.fetch(${job.role_id}) failed: ${e.message}`);
                    return null;
                });

                if (!member || !role) {
                    await dbRun(`UPDATE action_queue SET status='FAILED_MISSING_CONTEXT' WHERE id=$1`, [job.id]);
                    continue;
                }

                const botMember = await guild.members.fetchMe().catch((e) => {
                    logger.warn(`[Job ${job.id}] members.fetchMe() failed: ${e.message}`);
                    return null;
                });
                if (!botMember || role.position >= botMember.roles.highest.position) {
                    if (botMember) {
                        logger.warn(`[Job ${job.id}] Insufficient perms: role position ${role.position} >= bot highest position ${botMember.roles.highest.position}`);
                    }
                    await dbRun(`UPDATE action_queue SET status='FAILED_INSUFFICIENT_PERMS' WHERE id=$1`, [job.id]);
                    continue;
                }

                const hasRole = member.roles.cache.has(role.id);

                if (job.action_type === 'ADD') {
                    if (!hasRole) {
                        await member.roles.add(role, job.reason || undefined);

                        const successDm = new EmbedBuilder()
                            .setColor(0x2ecc71)
                            .setTitle('✨ Role Added')
                            .setDescription(`The **${role.name}** role has been successfully given.`)
                            .setTimestamp();

                        await member.send({ embeds: [successDm] }).catch((e) => {
                            logger.warn(`[Job ${job.id}] Could not DM ${member.id} about role add: ${e.message}`);
                        });
                    }
                } else if (job.action_type === 'REMOVE') {
                    if (hasRole) await member.roles.remove(role, job.reason || undefined);
                }

                const finalActorId = job.approver_id || job.actor_id;

                await audit({
                    guildId: guild.id,
                    actorId: finalActorId,
                    targetId: job.target_user_id,
                    roleId: job.role_id,
                    action: job.action_type,
                    reason: job.reason
                });

                await dbRun(
                    `UPDATE action_queue SET status='SUCCESS', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
                    [job.id]
                );

                let executorUser = await client.users.fetch(job.actor_id).catch((e) => {
                    logger.warn(`[Job ${job.id}] users.fetch(${job.actor_id}) failed: ${e.message}`);
                    return { id: job.actor_id, username: 'Unknown' };
                });

                await logAction(guild, executorUser, member, role, job.action_type, job.reason);

                await new Promise(r => setTimeout(r, 250));

            } catch (e) {
                // FIX: Calculate target status in JS to avoid SQL simultaneous mutation anomalies
                const nextAttemptCount = (job.attempt_count || 0) + 1;
                const nextStatus = nextAttemptCount >= MAX_RETRIES ? 'FAILED_RETRIES_EXCEEDED' : 'PENDING';

                await dbRun(
                    `UPDATE action_queue
                     SET attempt_count = $1,
                         last_error    = $2,
                         status        = $3,
                         updated_at    = CURRENT_TIMESTAMP
                     WHERE id = $4`,
                    [nextAttemptCount, e.message, nextStatus, job.id]
                );

                logger.error(`Queue error [Job ${job.id}]: ${e.message}`);
            }
        }
    } catch (err) {
        logger.error(`Queue processing failed: ${err.message}`);
    } finally {
        isProcessing = false; // Always releases the lock safely
    }
}

module.exports = { enqueue, processQueue };