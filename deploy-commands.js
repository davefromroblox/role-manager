require('dotenv').config();

const fs      = require('fs');
const path    = require('path');
const { REST, Routes } = require('discord.js');

// 1. Determine deployment scope from command line arguments
// Usage: node deploy.js --global   OR   node deploy.js --guild
const isGlobal = process.argv.includes('--global');
const isGuild  = process.argv.includes('--guild');

// Default behavior if you forget to pass a flag
if (!isGlobal && !isGuild) {
    console.error('❌ Please specify a deployment target: use --global or --guild');
    console.log('👉 Example: node deploy.js --guild');
    process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
    const command = require(path.join(commandsPath, file));
    if (command.data) {
        commands.push(command.data.toJSON());
        console.log(`Loaded for deploy: ${command.data.name}`);
    }
}

const rest     = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
const clientId = process.env.CLIENT_ID;
const guildId  = process.env.GUILD_ID; // Make sure this is in your .env if using --guild

(async () => {
    try {
        // 2. Dynamically set the route based on the flag
        let route;
        if (isGlobal) {
            console.log('🌎 Scope: GLOBAL');
            route = Routes.applicationCommands(clientId);
        } else {
            if (!guildId) {
                throw new Error('GUILD_ID is missing from your .env file.');
            }
            console.log(`🏰 Scope: GUILD (${guildId})`);
            route = Routes.applicationGuildCommands(clientId, guildId);
        }

        console.log('🧹 Clearing existing commands...');
        await rest.put(route, { body: [] });

        console.log('🚀 Deploying commands...');
        await rest.put(route, { body: commands });

        console.log('✅ Deployment complete.');
    } catch (err) {
        console.error('❌ Deployment failed:', err.message || err);
    }
})();