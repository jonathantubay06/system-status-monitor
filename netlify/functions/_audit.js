// netlify/functions/_audit.js
// Shared helper for logging admin actions (add/edit/delete project, send report)
// to a small rolling activity log, stored via Netlify Blobs. Never throws —
// if Blobs isn't available/configured, logging silently no-ops so it never
// breaks the primary action (adding a project, sending a report, etc).
const MAX_ENTRIES = 200;
const STORE_NAME = 'audit-log';
const KEY = 'entries';

async function logAudit(action, details) {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore(STORE_NAME);
    const existing = (await store.get(KEY, { type: 'json' })) || [];
    const entry = { at: new Date().toISOString(), action, ...details };
    const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
    await store.setJSON(KEY, updated);
  } catch (e) {
    console.error('Audit log write failed (non-fatal):', e.message);
  }
}

async function getAuditLog() {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore(STORE_NAME);
    return (await store.get(KEY, { type: 'json' })) || [];
  } catch (e) {
    console.error('Audit log read failed:', e.message);
    return [];
  }
}

module.exports = { logAudit, getAuditLog };
