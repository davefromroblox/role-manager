require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const isGlobal = process.argv.includes('--global');
const isGuild = process.argv.includes('--guild');

const onlyFlagIndex = process.argv.indexOf('--only');
const onlyCommands =
    onlyFlagIndex !== -1
        ? process.argv[onlyFlagIndex + 1].split(',').map(s => s.trim())
        : null;

if (!isGlobal && !isGuild) {
    console.error('❌ Use --global or --guild');
    process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

const commandsPath = path.join(__dirname, 'commands');

(async () => {
    try {
        let route;

        if (isGlobal) {
            console.log('🌎 GLOBAL deployment');
            route = Routes.applicationCommands(clientId);
        } else {
            if (!guildId) throw new Error('Missing GUILD_ID');
            console.log(`🏰 GUILD deployment (${guildId})`);
            route = Routes.applicationGuildCommands(clientId, guildId);
        }

        // 1. Load all local commands
        const localCommands = [];
        const loadedNames = [];

        for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
            const cmd = require(path.join(commandsPath, file));
            if (!cmd.data) continue;

            const name = cmd.data.name;

            if (onlyCommands && !onlyCommands.includes(name)) {
                continue;
            }

            localCommands.push(cmd.data.toJSON());
            loadedNames.push(name);
        }

        console.log(`📦 Local commands loaded: ${loadedNames.join(', ')}`);

        // 2. Fetch existing commands from Discord
        const existing = await rest.get(route);

        // 3. Filter out commands being replaced
        const filteredExisting = existing.filter(cmd => {
            if (!onlyCommands) return false; // full redeploy replaces all
            return !onlyCommands.includes(cmd.name);
        });

        // 4. Merge: keep untouched + replace updated ones
        const finalCommands = [...filteredExisting, ...localCommands];

        console.log(`🧹 Deploying ${finalCommands.length} total commands...`);

        await rest.put(route, { body: finalCommands });

        console.log('✅ Deployment complete.');
    } catch (err) {
        console.error('❌ Deployment failed:', err);
    }
})();