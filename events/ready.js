const logger = require('../lib/logger');

module.exports = {
    name: 'ready',
    once: true,
    execute(client) {
        logger.info(`Logged in as ${client.user.tag}`);
        client.user.setPresence({
            activities: [{ name: 'with your roles', type: 0 }], // 0 = PLAYING
            status: 'online'
        });
    }
};
