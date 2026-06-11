require('dotenv').config();
const { 
    initDatabase, 
    handleInteraction, 
    processQueue, 
    logAction, 
    parseDuration,
    db 
} = require('./bot');
const { SlashCommandBuilder } = require('discord.js');

// Helper wrapper to easily query DB states inside our assertions
const dbGet = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (q, p = []) => new Promise((res, rej) => db.run(q, p, (e) => e ? rej(e) : res()));

beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    // Suppress console spam from test executions
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await initDatabase();
});

// Avoid test cross-contamination by scrubbing tables before each test block runs
afterEach(async () => {
    await dbRun('DELETE FROM config');
    await dbRun('DELETE FROM action_queue');
    await dbRun('DELETE FROM audit_log');
});

afterAll(async () => {
    await new Promise((resolve) => db.close(() => resolve()));
});

/* =========================================================
   1. DATABASE TESTS
========================================================= */
describe('Database Tests', () => {
    describe('Database Initialization', () => {
        test('creates required tables', async () => {
            db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) => {
                const tables = rows.map(r => r.name);
                expect(tables).toEqual(expect.arrayContaining(['config', 'action_queue', 'audit_log']));
            });
        });
    });

    describe('Database Persistence', () => {
        test('inserts and retrieves config configuration data', async () => {
            await dbRun("INSERT INTO config (guild_id, manager_role_id) VALUES (?, ?)", ['guild_123', 'role_manager_abc']);
            const row = await dbGet("SELECT manager_role_id FROM config WHERE guild_id=?", ['guild_123']);
            expect(row.manager_role_id).toBe('role_manager_abc');
        });
    });
});

/* =========================================================
   2. UTILITY FUNCTION TESTS
========================================================= */
describe('Utility Function Tests', () => {
    describe('parseDuration', () => {
        test('parses minutes correctly', () => {
            expect(parseDuration('10m')).toBe(600000);
        });

        test('parses hours correctly', () => {
            expect(parseDuration('2h')).toBe(7200000);
        });

        test('returns null for invalid input', () => {
            expect(parseDuration('xyz')).toBeNull();
        });
    });
});

/* =========================================================
   3. INTERACTION HANDLING TESTS
========================================================= */
describe('Interaction Handling Tests', () => {
    let mockInteraction;

    beforeEach(() => {
        mockInteraction = {
            commandName: 'role',
            isChatInputCommand: () => true,
            reply: jest.fn(),
            guild: { 
                id: 'guild_123',
                ownerId: 'user_owner'
            },
            user: { id: 'user_executor' },
            member: {
                id: 'user_executor',
                guild: { ownerId: 'user_owner' },
                roles: { 
                    highest: { position: 10 },
                    cache: { has: () => false } 
                },
                permissions: { has: () => false }
            },
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => 'add',
                getUser: () => ({ id: 'target_user', username: 'target_username' }),
                getRole: () => ({ id: 'role_target', name: 'Target Role', position: 1 }),
                getString: () => 'Test Reason'
            }
        };
    });

    test('responds with entry tracking confirmation upon executing role command', async () => {
        await dbRun("INSERT INTO config (guild_id, manager_role_id) VALUES (?, ?)", ['guild_123', 'role_manager_abc']);
        mockInteraction.member.roles.cache.has = (id) => id === 'role_manager_abc';

        await handleInteraction(mockInteraction);
        expect(mockInteraction.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Queued permanent addition'),
            ephemeral: true
        }));
    });

    test('handles invalid command gracefully', async () => {
        await dbRun("INSERT INTO config (guild_id, manager_role_id) VALUES (?, ?)", ['guild_123', 'role_manager_abc']);
        mockInteraction.member.roles.cache.has = (id) => id === 'role_manager_abc';
        
        mockInteraction.commandName = 'unknown-command';
        await handleInteraction(mockInteraction);
        expect(mockInteraction.reply).toHaveBeenCalledWith('Unknown command');
    });
});

/* =========================================================
   4. QUEUE PROCESSING TESTS
========================================================= */
describe('Queue Processing Tests', () => {
    test('executes scheduled actions in order and updates task status', async () => {
        const mockSend = jest.fn();
        const mockMember = { 
            roles: { 
                add: jest.fn().mockResolvedValue({}), 
                cache: { has: () => false } 
            } 
        };
        
        const mockGuild = {
            id: 'guild_123',
            roles: { fetch: jest.fn().mockResolvedValue({ id: 'role_target', position: 5 }) },
            channels: { cache: { get: () => ({ send: mockSend }) } },
            members: {
                me: { roles: { highest: { position: 10 } } },
                fetch: jest.fn().mockResolvedValue(mockMember)
            }
        };

        const mockClient = {
            guilds: { fetch: jest.fn().mockResolvedValue(mockGuild) },
            users: { fetch: jest.fn().mockResolvedValue({ username: 'Executor', tag: 'Executor#1337' }) }
        };

        await dbRun("INSERT INTO config (guild_id, log_channel_id) VALUES (?, ?)", ['guild_123', 'chan_logs']);

        await dbRun(
            `INSERT INTO action_queue (guild_id, actor_id, target_user_id, role_id, action_type, status, attempt_count) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ['guild_123', 'user_executor', 'target_user', 'role_target', 'ADD', 'PENDING', 0]
        );

        await processQueue(mockClient);

        const job = await dbGet("SELECT status FROM action_queue WHERE guild_id=?", ['guild_123']);
        expect(job.status).toBe('SUCCESS');
        expect(mockMember.roles.add).toHaveBeenCalled();
    });
});

/* =========================================================
   5. LOGGING TESTS
========================================================= */
describe('Logging Tests', () => {
    test('logs actions into active channel embeds instead of standard standard-out streams', async () => {
        const mockSend = jest.fn();
        const mockGuild = {
            id: 'guild_123',
            channels: { cache: { get: () => ({ send: mockSend }) } }
        };

        await dbRun("INSERT INTO config (guild_id, log_channel_id) VALUES (?, ?)", ['guild_123', 'chan_logs']);

        await logAction(
            mockGuild, 
            { id: 'user_executor', username: 'Executor' }, 
            { id: 'target_user', username: 'Target' }, 
            { id: 'role_target', name: 'Admin' }, 
            'ADD', 
            'Test Reason'
        );

        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
            embeds: expect.any(Array)
        }));
    });
});

/* =========================================================
   6. ERROR HANDLING TESTS
========================================================= */
describe('Error Handling Tests', () => {
    test('catches operational database errors gracefully when utilizing wrappers', async () => {
        const triggerInvalidQuery = () => new Promise((res, rej) => {
            db.run("SELECT * FROM non_existent_table_xyz", (err) => {
                if (err) return rej(err);
                res();
            });
        });

        await expect(triggerInvalidQuery()).rejects.toThrow();
    });
});

/* =========================================================
   7. INTEGRATION TESTS
========================================================= */
describe('Integration Tests', () => {
    describe('Integration - Role Assignment', () => {
        test('assigns role components cleanly through standard transaction flows', async () => {
            const mockInteraction = {
                commandName: 'role',
                isChatInputCommand: () => true,
                reply: jest.fn(),
                guild: { 
                    id: 'guild_123',
                    ownerId: 'user_owner'
                },
                user: { id: 'user_executor' },
                member: {
                    id: 'user_executor',
                    guild: { ownerId: 'user_owner' },
                    roles: { 
                        highest: { position: 10 },
                        cache: { has: () => false } 
                    },
                    permissions: { has: () => false }
                },
                options: {
                    getSubcommandGroup: () => null,
                    getSubcommand: () => 'add',
                    getUser: () => ({ id: 'target_user', username: 'target_username' }),
                    getRole: () => ({ id: 'role_target', name: 'Target Role', position: 1 }),
                    getString: () => 'Integration Reason'
                }
            };

            await dbRun("INSERT INTO config (guild_id, manager_role_id) VALUES (?, ?)", ['guild_123', 'role_manager_abc']);
            mockInteraction.member.roles.cache.has = (id) => id === 'role_manager_abc';

            await handleInteraction(mockInteraction);
            expect(mockInteraction.reply).toHaveBeenCalled();

            const job = await dbGet("SELECT target_user_id, action_type FROM action_queue WHERE guild_id=?", ['guild_123']);
            expect(job).toBeDefined();
            expect(job.target_user_id).toBe('target_user');
            expect(job.action_type).toBe('ADD');
        });
    });
});