require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
const clientId = process.env.CLIENT_ID;
const guildId  = process.env.GUILD_ID;

(async () => {
    try {
        console.log('🧹 Purging Guild Commands...');
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
        
        console.log('🌎 Purging Global Commands...');
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        
        console.log('✨ Clean slate achieved! Restart Discord.');
    } catch (err) {
        console.error(err);
    }
})();