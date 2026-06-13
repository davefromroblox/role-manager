const ERROR_CODES = {
    // Configuration Errors (1000-1999)
    CONFIG_MISSING_CHANNEL:   { code: 1001, message: 'Approval channel not configured.' },
    CONFIG_INVALID_PERMS:     { code: 1002, message: 'Bot missing required channel permissions.' },
    
    // Permission/Role Errors (2000-2999)
    ERR_HIERARCHY_TOO_HIGH:   { code: 2001, message: 'Role is higher than bot/actor hierarchy.' },
    ERR_PROTECTED_ROLE:       { code: 2002, message: 'Action on a protected role is forbidden.' },
    ERR_INSUFFICIENT_PERMS:   { code: 2003, message: 'Insufficient user permissions.' },
    
    // Process/Queue Errors (3000-3999)
    ERR_TARGET_NOT_FOUND:     { code: 3001, message: 'Target user no longer in server.' },
    ERR_RETRY_EXCEEDED:       { code: 3002, message: 'Maximum retries exceeded.' },
    ERR_UNKNOWN_CONTEXT:      { code: 3003, message: 'Context (guild/member) missing.' }
};

module.exports = ERROR_CODES;