# Discord Bot — Developer Guide

A reference for building, extending, and maintaining this codebase.

---

## Project Structure

```
bot.js                  Entry point — run with: node bot.js
deploy-commands.js      Register slash commands with Discord API
/commands               One file per slash command
/events                 One file per Discord gateway event
/lib
  db.js                 Database pool, query helpers, schema init
  helpers.js            Shared logic: permissions, audit, logging
  logger.js             Structured console logger
  queue.js              Action queue: enqueue + processQueue worker
```

---

## Running the Bot

```bash
node bot.js             Start the bot
node deploy-commands.js Register / update slash commands with Discord
```

> **Important:** Any time you add, remove, or change a command's structure (name, subcommands, options), you must re-run `deploy-commands.js`. Discord caches command definitions — the bot will misbehave or error until they are redeployed. This includes switching between subcommands and string options.

---

## Environment Variables

Stored in a `.env` file in the project root. Required:

| Variable         | Description                                      |
|------------------|--------------------------------------------------|
| `DISCORD_TOKEN`  | Bot token from the Discord Developer Portal      |
| `CLIENT_ID`      | Application ID from the Discord Developer Portal |
| `DATABASE_URL`   | PostgreSQL connection string                     |
| `PORT`           | Port for the Express health server (default 3000)|
| `DEBUG`          | Set to any value to enable debug logging         |

---

## Adding a New Command

1. Create `/commands/your-command.js`
2. Export `data` (SlashCommandBuilder) and `execute(interaction)`
3. Run `node deploy-commands.js`

That's it. `bot.js` auto-loads all files in `/commands` on startup.

### Minimal command template

```js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('your-command')
        .setDescription('What it does'),

    async execute(interaction) {
        return interaction.reply({ content: 'Hello!', ephemeral: true });
    }
};
```

### Command with database access

```js
const { SlashCommandBuilder } = require('discord.js');
const { dbGet, dbRun, dbAll } = require('../lib/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('your-command')
        .setDescription('What it does'),

    async execute(interaction) {
        const row = await dbGet(
            `SELECT * FROM config WHERE guild_id = $1`,
            [interaction.guild.id]
        );
        return interaction.reply({ content: row ? 'Found' : 'Not found', ephemeral: true });
    }
};
```

### Command with subcommands

```js
data: new SlashCommandBuilder()
    .setName('your-command')
    .setDescription('Top-level description')
    .addSubcommand(sub => sub
        .setName('action')
        .setDescription('Does something')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)))
```

Then in `execute`:
```js
const sub = interaction.options.getSubcommand();
if (sub === 'action') { ... }
```

---

## Adding a New Event

Create `/events/your-event.js` — `bot.js` auto-loads all files in `/events`.

```js
module.exports = {
    name: 'guildMemberAdd',   // Discord.js event name
    once: false,              // true = fires once only (e.g. 'ready')
    async execute(member) {
        console.log(`${member.user.tag} joined`);
    }
};
```

Common events and their payloads:

| Event              | Payload              | Use case                        |
|--------------------|----------------------|---------------------------------|
| `ready`            | `client`             | Bot startup, set presence       |
| `interactionCreate`| `interaction`        | Handle slash commands / buttons |
| `guildMemberAdd`   | `member`             | Welcome, role restore on rejoin |
| `guildMemberRemove`| `member`             | Cleanup, logging                |
| `messageCreate`    | `message`            | DM handling, message triggers   |

> **Note:** Some events require additional Gateway Intents declared in `bot.js`. See the Intents section below.

---

## Gateway Intents

Declared in `bot.js` when creating the Discord `Client`. Currently active:

```js
intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
]
```

Add intents here when a new feature needs them. Common ones:

| Intent                        | Required for                                      | Privileged? |
|-------------------------------|---------------------------------------------------|-------------|
| `Guilds`                      | Guild/channel/role data                           | No          |
| `GuildMembers`                | Member join/leave events, member fetching         | **Yes**     |
| `GuildMessages`               | Reading messages in servers                       | No          |
| `MessageContent`              | Reading message body text                         | **Yes**     |
| `DirectMessages`              | Receiving DMs sent to the bot                     | No          |
| `GuildMessageReactions`       | Reaction add/remove events                        | No          |

**Privileged intents** (`GuildMembers`, `MessageContent`) must also be enabled in the Discord Developer Portal under your application → Bot → Privileged Gateway Intents. Bots in 100+ servers require Discord verification to use them.

---

## Database

### Query helpers (from `lib/db.js`)

```js
const { dbGet, dbRun, dbAll } = require('../lib/db');

await dbGet(query, params)   // Returns first row or null
await dbRun(query, params)   // Returns pg result (use for INSERT/UPDATE/DELETE)
await dbAll(query, params)   // Returns all rows as array
```

All queries use parameterised placeholders (`$1`, `$2`, ...) — never interpolate user input directly into SQL.

### Adding a new table

Add a `CREATE TABLE IF NOT EXISTS` block inside `initDatabase()` in `lib/db.js`. It runs on every boot, so it's safe to append to:

```js
await client.query(`
    CREATE TABLE IF NOT EXISTS your_table (
        id         SERIAL PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        some_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);
```

Add indexes for any column you'll query frequently:

```js
await client.query(`
    CREATE INDEX IF NOT EXISTS idx_your_table_guild
    ON your_table(guild_id)
`);
```

### Schema overview

| Table          | Purpose                                               |
|----------------|-------------------------------------------------------|
| `config`       | Per-guild settings (log channel, manager role, etc.)  |
| `action_queue` | Pending/in-progress/completed role actions            |
| `audit_log`    | Immutable record of all role actions with metadata    |

---

## The Action Queue

Role changes are not applied immediately — they are written to `action_queue` and processed by a worker that runs every 5 seconds. This handles Discord rate limits, retries on failure, and prevents race conditions.

### Enqueuing a job

```js
const { enqueue } = require('../lib/queue');

await enqueue({
    guildId:  interaction.guild.id,
    actorId:  interaction.member.id,
    targetId: targetUser.id,
    roleId:   targetRole.id,
    type:     'ADD',       // or 'REMOVE'
    reason:   'Reason text',
    expiresAt: null        // optional: Date for temp roles
});
```

### Job statuses

| Status                      | Meaning                                            |
|-----------------------------|----------------------------------------------------|
| `PENDING`                   | Waiting to be processed                            |
| `IN_PROGRESS`               | Currently being executed                           |
| `SUCCESS`                   | Completed successfully                             |
| `FAILED_MISSING_CONTEXT`    | Guild, member, or role could not be found          |
| `FAILED_INSUFFICIENT_PERMS` | Bot lacks hierarchy or permissions                 |
| `FAILED_RETRIES_EXCEEDED`   | Hit the retry limit (default: 5 attempts)          |

---

## Permission Checks

Two helper functions in `lib/helpers.js` cover the two most common checks:

```js
const { canManage, botCanManage } = require('../lib/helpers');

// Can this member use the bot? (owner / admin / manager role)
if (!canManage(member, config, targetRole)) { ... }

// Can the bot itself manage this role? (hierarchy check)
if (!botCanManage(guild, role)) { ... }
```

Standard pattern for a command that requires manager access:

```js
const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
const isOwner = guild.ownerId === member.id;
const isManager = config?.manager_role_id && member.roles.cache.has(config.manager_role_id);

if (!isAdmin && !isOwner && !isManager) {
    return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
}
```

---

## Audit Logging

Write to the audit log whenever a role action is taken:

```js
const { audit } = require('../lib/helpers');

await audit({
    guildId:  guild.id,
    actorId:  member.id,
    targetId: targetUser.id,
    roleId:   role.id,
    action:   'ADD',         // or 'REMOVE'
    reason:   'Some reason',
    meta:     {}             // optional: any extra JSON
});
```

The audit log is append-only — never delete from it. It is the source of truth for all role history.

---

## Sending a Log Embed

To post an action to the configured log channel:

```js
const { logAction } = require('../lib/helpers');

await logAction(guild, executorUser, targetMember, role, 'ADD', reason);
```

This is a no-op if no log channel is configured for the guild, so it's safe to call unconditionally.

---

## Express HTTP Server

The bot runs a lightweight Express server alongside the Discord client.

| Endpoint         | Method | Description                              |
|------------------|--------|------------------------------------------|
| `/health`        | GET    | Returns `{ status: 'ok' }` — for uptime monitoring |
| `/process-queue` | POST   | Manually trigger the queue worker        |
| `/stats`         | GET    | Returns queue counts and bot status      |

These are unauthenticated. If your bot is publicly hosted, consider adding a shared secret check to `/process-queue`.

---

## Logger

```js
const logger = require('../lib/logger');

logger.info('Something happened');
logger.warn('Something unexpected');
logger.error('Something broke');
logger.debug('Verbose detail');   // only outputs when DEBUG env var is set
```

Format: `[LEVEL] 2025-01-01T00:00:00.000Z Message`

---

## Common Pitfalls

**Forgot to redeploy after changing command structure**
Any change to command names, subcommands, or options requires `node deploy-commands.js`. The old structure will persist in Discord's cache otherwise.

**Calling a method without parentheses**
`channel.isTextBased` is always truthy (it's a function reference). Always call it: `channel.isTextBased()`.

**Querying a Collection like an array**
Discord.js Collections are Maps, not arrays. Use `.size` not `.length`, `.first(n)` not `.slice(0, n)`, and iterate with `for (const [id, item] of collection)`.

**Not deferring long-running interactions**
Discord requires a response within 3 seconds. For anything involving DB queries or API calls, call `await interaction.deferReply({ ephemeral: true })` first, then `interaction.editReply(...)` when done.

**Direct SQL interpolation**
Never do `WHERE guild_id = '${guild.id}'`. Always use `WHERE guild_id = $1` with a params array. This prevents SQL injection.

**Embed character limits**
Discord enforces a 4096 character limit per embed description and a maximum of 10 embeds per message. If output may be long, chunk it — see `diagnostics.js` for the pattern.

---

## Deployment Checklist

When deploying a new version:

- [ ] `.env` is configured with all required variables
- [ ] `node deploy-commands.js` has been run if any commands changed
- [ ] New DB tables are added to `initDatabase()` in `lib/db.js`
- [ ] New privileged intents are enabled in the Discord Developer Portal
- [ ] Bot role is positioned above all roles it needs to manage in the server hierarchy