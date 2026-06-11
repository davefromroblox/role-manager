require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const app = express();

// Safe Production Path mapping for local development or Docker / Cloud Volumes
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/rolemanager_v2.db` 
  : './rolemanager_v2.db';

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) console.error(`❌ Dashboard failed to connect to database at ${dbPath}:`, err.message);
});

// Promise wrappers
const get = (q, p = []) =>
  new Promise((res, rej) =>
    db.get(q, p, (e, r) => (e ? rej(e) : res(r)))
  );

const all = (q, p = []) =>
  new Promise((res, rej) =>
    db.all(q, p, (e, r) => (e ? rej(e) : res(r)))
  );

app.get('/', async (req, res) => {
  let status = {
    label: 'Operational',
    color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    dot: 'bg-emerald-500'
  };

  const metrics = {
    pending: 0,
    active: 0,
    success: 0,
    failed: 0
  };

  let config = [];
  let queue = [];
  let logs = [];
  let lastError = 'None recorded';

  try {
    // 1. Calculate Queue Volume Summaries
    const counts = await all(
      `SELECT status, COUNT(*) as count FROM action_queue GROUP BY status`
    );
    
    counts.forEach(row => {
      if (row.status === 'PENDING') metrics.pending = row.count;
      if (row.status === 'SUCCESS') metrics.success = row.count;
      if (row.status === 'EXPIRED') metrics.active += row.count; // Active temporary items
    });

    // 2. Fetch recent exceptions or edge case drops
    const failedJobs = await all(`SELECT COUNT(*) as count FROM action_queue WHERE attempt_count > 0 AND status = 'PENDING'`);
    metrics.failed = failedJobs[0]?.count || 0;

    const errorRow = await get(
      `SELECT last_error FROM action_queue WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1`
    );
    if (errorRow?.last_error) {
      lastError = errorRow.last_error;
      status = {
        label: 'Degraded Performance',
        color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        dot: 'bg-amber-500'
      };
    }

    // 3. Collect Data Tables
    config = await all(`SELECT * FROM config LIMIT 10`);
    queue = await all(`SELECT * FROM action_queue ORDER BY id DESC LIMIT 10`);
    logs = await all(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 15`);

  } catch (err) {
    status = {
      label: 'Database Connection Lost',
      color: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
      dot: 'bg-rose-500'
    };
    lastError = `CRITICAL_SYS_ERR: ${err.message}`;
  }

  // Render upgraded view engine directly using inline styling parameters
  res.send(`
<!DOCTYPE html>
<html lang="en" class="h-full bg-slate-950 text-slate-100">
<head>
  <meta charset="UTF-8">
  <title>Shield System Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
</head>
<body class="p-8 space-y-6 max-w-7xl mx-auto font-sans">

  <header class="flex justify-between items-center border-b border-slate-800 pb-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">🛡️ System Automation Gateway</h1>
      <p class="text-xs text-slate-400">Core Role Engine Cluster Management Status</p>
    </div>
    <div class="flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${status.color}">
      <span class="h-2 w-2 rounded-full ${status.dot} animate-pulse"></span>
      ${status.label}
    </div>
  </header>

  <section class="grid grid-cols-2 md:grid-cols-4 gap-4">
    <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
      <div class="text-xs text-slate-400 font-medium uppercase">Pending Jobs</div>
      <div class="text-2xl font-bold text-amber-400 mt-1">${metrics.pending}</div>
    </div>
    <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
      <div class="text-xs text-slate-400 font-medium uppercase">Active Lifespans</div>
      <div class="text-2xl font-bold text-sky-400 mt-1">${metrics.active}</div>
    </div>
    <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
      <div class="text-xs text-slate-400 font-medium uppercase">Processed Total</div>
      <div class="text-2xl font-bold text-emerald-400 mt-1">${metrics.success}</div>
    </div>
    <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
      <div class="text-xs text-slate-400 font-medium uppercase">Stalled Pipeline</div>
      <div class="text-2xl font-bold text-rose-400 mt-1">${metrics.failed}</div>
    </div>
  </section>

  <section class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
    <h2 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Driver Trace / Last Exception Message</h2>
    <pre class="text-xs bg-slate-950 p-3 rounded border border-slate-800 font-mono text-rose-400 overflow-x-auto whitespace-pre-wrap">${lastError}</pre>
  </section>

  <section class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    
    <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl lg:col-span-1 space-y-3">
      <h2 class="text-xs font-bold text-slate-400 uppercase tracking-wider">Active Configurations</h2>
      <div class="space-y-2 overflow-y-auto max-h-96 pr-1">
        ${config.length ? config.map(c => `
          <div class="text-xs bg-slate-950 border border-slate-800 rounded p-3 space-y-1 font-mono">
            <div class="text-slate-400 font-bold border-b border-slate-900 pb-1 mb-1">ID: ${c.guild_id}</div>
            <div>Log Channel: <span class="text-sky-400">${c.log_channel_id || 'Not Set'}</span></div>
            <div>Manager Role: <span class="text-purple-400">${c.manager_role_id || 'Not Set'}</span></div>
            <div>Reason Required: <span class="${c.reason_required ? 'text-emerald-400' : 'text-slate-500'}">${c.reason_required ? 'YES' : 'NO'}</span></div>
          </div>
        `).join('') : '<div class="text-xs text-slate-500 italic p-2">No active server records found in disk storage.</div>'}
      </div>
    </div>

    <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl lg:col-span-2 space-y-3">
      <h2 class="text-xs font-bold text-slate-400 uppercase tracking-wider">Execution Queue Queue Tail (Last 10 Actions)</h2>
      <div class="space-y-2 overflow-y-auto max-h-96 pr-1">
        ${queue.length ? queue.map(q => `
          <div class="text-xs flex justify-between items-center bg-slate-950 border border-slate-800 rounded p-2.5 font-mono">
            <div class="space-y-1">
              <div>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${q.action_type === 'ADD' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}">${q.action_type}</span>
                <span class="text-slate-300 ml-1">Target Account: ${q.target_user_id}</span>
              </div>
              <div class="text-[11px] text-slate-500">Reason: ${q.reason || 'None provided'}</div>
            </div>
            <div class="text-right">
              <span class="px-2 py-0.5 rounded text-[10px] font-medium border ${q.status === 'SUCCESS' ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400' : q.status === 'EXPIRED' ? 'border-sky-500/20 bg-sky-500/5 text-sky-400' : 'border-amber-500/20 bg-amber-500/5 text-amber-400'}">${q.status}</span>
              <div class="text-[9px] text-slate-600 mt-1">Attempts: ${q.attempt_count}</div>
            </div>
          </div>
        `).join('') : '<div class="text-xs text-slate-500 italic p-2">Queue stack is currently vacant.</div>'}
      </div>
    </div>

  </section>

</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 System Monitor Dashboard spinning up on port ${PORT}`);
});