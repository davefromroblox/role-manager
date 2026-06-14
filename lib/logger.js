const fs = require('fs');
const path = require('path');
const { createStream } = require('rotating-file-stream');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Rotates when the file hits 10MB, keeps up to 5 old copies, gzips rotated files.
const debugStream = createStream('debug.log', {
    path: logDir,
    size: '10M',
    maxFiles: 5,
    compress: 'gzip'
});

debugStream.on('error', (err) => {
    // Avoid crashing the bot if the log file becomes unwritable;
    // fall back to stderr so the error is still visible.
    console.error(`[ERROR] ${new Date().toISOString()} Debug log stream error: ${err.message}`);
});

const logger = {
    info:  (msg) => console.log(`[INFO]  ${new Date().toISOString()} ${msg}`),
    warn:  (msg) => console.warn(`[WARN]  ${new Date().toISOString()} ${msg}`),
    error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`),
    debug: (msg) => {
        if (process.env.DEBUG) {
            debugStream.write(`[DEBUG] ${new Date().toISOString()} ${msg}\n`);
        }
    }
};

module.exports = logger;