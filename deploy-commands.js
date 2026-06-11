require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
    // 1. Operational Command: Role Management
    // We leave this WITHOUT setDefaultMemberPermissions so you can control
    // visibility/access via Server Settings > Integrations > [Your Bot]
    new SlashCommandBuilder()
        .setName('role')
        .setDescription('Advanced role management system')
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a permanent role to a user')
            .addUserOption(o => o.setName('user').setDescription('The user').setRequired(true))
            .addRoleOption(o => o.setName('role').setDescription('The role to add').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for this action')))
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a permanent role from a user')
            .addUserOption(o => o.setName('user').setDescription('The user').setRequired(true))
            .addRoleOption(o => o.setName('role').setDescription('The role to remove').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for this action'))),

    // 2. Administrative Command: Configuration
    // This is strictly limited to Administrators at the API level.
    new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configure the role manager settings')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub => sub
            .setName('log-channel')
            .setDescription('Set the channel where role actions are logged')
            .addChannelOption(o => o.setName('channel')
                .setDescription('The log channel') // Add this
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('manager-role')
            .setDescription('Set a role that grants access to this bot')
            .addRoleOption(o => o.setName('role')
                .setDescription('The manager role') // Add this
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('protected-role')
            .setDescription('Protect a role from being modified')
            .addRoleOption(o => o.setName('role')
                .setDescription('The protected role') // Add this
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('reason-required')
            .setDescription('Require a reason for actions')
            .addBooleanOption(o => o.setName('enabled')
                .setDescription('Enable or disable the requirement') // Add this
                .setRequired(true))),
        
    new SlashCommandBuilder()
        .setName('diagnostics')
        .setDescription('Run system health checks (admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    const clientId = process.env.CLIENT_ID;
    const guildId = process.env.GUILD_ID;

    try {
        console.log('🧹 Clearing global cache...');
        await rest.put(Routes.applicationCommands(clientId), { body: [] });

        if (guildId) {
            await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
            console.log('✅ Deployed split commands to guild.');
        } else {
            await rest.put(Routes.applicationCommands(clientId), { body: commands });
            console.log('✅ Deployed split commands globally.');
        }
    } catch (error) {
        console.error('❌ Deployment failed:', error);
    }
})();