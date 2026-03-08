// netlify/functions/view-report.js
// Renders a mobile-friendly HTML report page from status/history data
const ch = () => ({
  'Content-Type': 'text/html',
  'Access-Control-Allow-Origin': '*',
});

exports.handler = async (event) => {
  try {
    const parts = (event.path || '').replace(/^\/\.netlify\/functions\/view-report\/?/, '').replace(/^report\/?/, '').split('/').filter(Boolean);
    const projectId = parts[0] || (event.queryStringParameters || {}).project || '';
    const from = (event.queryStringParameters || {}).from || '';
    const to = (event.queryStringParameters || {}).to || '';

    if (!projectId) {
      return { statusCode: 400, headers: ch(), body: errorPage('Missing project ID. Use /report/project-id') };
    }

    const repo = process.env.GITHUB_REPO || 'jonathantubay06/system-status-monitor';
    const branch = 'main';
    const rawBase = `https://raw.githubusercontent.com/${repo}/${branch}/dashboard`;

    const [statusRes, historyRes] = await Promise.all([
      fetch(`${rawBase}/status.json`),
      fetch(`${rawBase}/history.json`),
    ]);

    if (!statusRes.ok) return { statusCode: 500, headers: ch(), body: errorPage('Could not load status data') };

    const status = await statusRes.json();
    const history = historyRes.ok ? await historyRes.json() : [];

    const project = (status.results || []).find(r => r.id === projectId);
    if (!project) return { statusCode: 404, headers: ch(), body: errorPage(`Project "${projectId}" not found`) };

    // Filter history by date range
    let filtered = history;
    if (from) filtered = filtered.filter(h => new Date(h.timestamp) >= new Date(from + 'T00:00:00'));
    if (to) filtered = filtered.filter(h => new Date(h.timestamp) <= new Date(to + 'T23:59:59'));

    // Calculate stats
    let totalChecks = 0, okChecks = 0, responseTimes = [];
    filtered.forEach(h => {
      const r = (h.results || []).find(x => x.id === projectId);
      if (!r) return;
      totalChecks++;
      if (r.status === 'operational') okChecks++;
      if (r.responseMs) responseTimes.push(r.responseMs);
    });

    const uptimePct = totalChecks ? ((okChecks / totalChecks) * 100).toFixed(1) : '--';
    const avgMs = responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : 0;
    const minMs = responseTimes.length ? Math.min(...responseTimes) : 0;
    const maxMs = responseTimes.length ? Math.max(...responseTimes) : 0;
    const incidentCount = totalChecks - okChecks;

    // Components
    const components = (project.components || []).map(c => {
      let cTotal = 0, cOk = 0;
      filtered.forEach(h => {
        const r = (h.results || []).find(x => x.id === projectId);
        if (!r || !r.components) return;
        const comp = r.components.find(x => x.name === c.name);
        if (!comp) return;
        cTotal++;
        if (comp.status === 'operational') cOk++;
      });
      return { name: c.name, desc: c.description || '', pct: cTotal ? ((cOk / cTotal) * 100).toFixed(1) : '100.0' };
    });

    const dateLabel = from && to ? `${fmtDate(from)} — ${fmtDate(to)}` : from ? `From ${fmtDate(from)}` : to ? `Until ${fmtDate(to)}` : `All available data (${totalChecks} checks)`;

    const html = renderReport({ project, uptimePct, totalChecks, avgMs, minMs, maxMs, incidentCount, components, dateLabel, projectId });

    return { statusCode: 200, headers: ch(), body: html };
  } catch (e) {
    return { statusCode: 500, headers: ch(), body: errorPage(e.message) };
  }
};

function fmtDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Report Error</title><style>body{background:#09090b;color:#d4d4d8;font-family:Inter,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.err{text-align:center;max-width:400px;padding:2rem}.err h2{color:#ef4444;margin:0 0 0.5rem}.err p{color:#71717a;font-size:0.9rem}</style></head>
<body><div class="err"><h2>Error</h2><p>${msg}</p></div></body></html>`;
}

function renderReport({ project, uptimePct, totalChecks, avgMs, minMs, maxMs, incidentCount, components, dateLabel, projectId }) {
  const green = '#22c55e', yellow = '#eab308', red = '#ef4444', blue = '#60a5fa', accent = '#a78bfa';
  const uptimeNum = parseFloat(uptimePct) || 0;
  const uptimeColor = uptimeNum >= 99 ? green : uptimeNum >= 95 ? yellow : red;
  const avgSec = (avgMs / 1000).toFixed(1);

  const compHtml = components.length ? components.map(c => {
    const pct = parseFloat(c.pct);
    const color = pct >= 99 ? green : pct >= 90 ? yellow : red;
    return `<div class="comp-row"><div class="comp-name">${c.name}<span class="comp-desc">${c.desc}</span></div>
      <div class="comp-bar-wrap"><div class="comp-bar" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>
      <div class="comp-pct" style="color:${color}">${pct}%</div></div>`;
  }).join('') : '';

  const dashUrl = `https://projecthealthmonitoring.netlify.app/status/${projectId}`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Health Report: ${project.name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#09090b;color:#d4d4d8;font-family:'Inter',-apple-system,sans-serif;font-size:14px;line-height:1.5}
.wrap{max-width:600px;margin:0 auto;padding:1.5rem 1rem}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem}
.brand{font-size:1rem;font-weight:700;color:#C5D5F5}.brand span{color:#4C6BCD}
.badge{background:#4d65ff;color:#fff;font-size:0.62rem;font-weight:700;padding:3px 10px;border-radius:4px;text-transform:uppercase;letter-spacing:1.5px}
.banner{background:linear-gradient(135deg,#4C6BCD,#4d65ff);padding:1.5rem;border-radius:12px 12px 0 0}
.banner h1{font-size:1.25rem;font-weight:700;color:#fff;margin-bottom:0.25rem}
.banner .url{font-size:0.8rem;color:rgba(255,255,255,0.7)}
.banner .date{display:inline-block;background:rgba(255,255,255,0.15);color:#fff;font-size:0.78rem;padding:5px 12px;border-radius:6px;margin-top:0.75rem}
.card{background:#1e293b;border:1px solid #334155;border-top:none}
.stats{display:grid;grid-template-columns:repeat(3,1fr);text-align:center;padding:1.5rem 1rem;gap:0.5rem}
.stat-val{font-size:1.8rem;font-weight:800;line-height:1;letter-spacing:-0.5px}
.stat-label{font-size:0.65rem;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-top:0.4rem}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;padding:0 1rem 1.5rem}
.info-box{border-radius:10px;padding:1rem 0.85rem}
.info-box h4{font-size:0.78rem;font-weight:600;margin-bottom:0.25rem}
.info-box p{font-size:0.8rem;color:#f1f5f9;line-height:1.5}
.sla-wrap{padding:0 1rem 1.5rem}
.sla-label{font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:0.5rem}
.sla-track{background:#334155;border-radius:4px;height:10px;overflow:hidden}
.sla-fill{height:10px;border-radius:4px}
.sla-hint{font-size:0.72rem;color:#94a3b8;margin-top:0.35rem}
.section-title{font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;padding:0 1rem;margin-bottom:0.75rem}
.comp-row{display:flex;align-items:center;gap:0.5rem;padding:0.5rem 1rem}
.comp-name{flex:1;font-size:0.8rem;color:#f1f5f9;font-weight:500}
.comp-desc{display:block;font-size:0.68rem;color:#94a3b8;font-weight:400}
.comp-bar-wrap{width:100px;background:#334155;border-radius:4px;height:6px;overflow:hidden}
.comp-bar{height:6px;border-radius:4px}
.comp-pct{font-size:0.78rem;font-weight:600;width:48px;text-align:right}
.comps{padding-bottom:1.5rem}
.footer{background:#1e293b;border:1px solid #334155;border-top:none;border-radius:0 0 12px 12px;padding:1.25rem;text-align:center}
.footer p{font-size:0.72rem;color:#94a3b8}.footer a{color:#60a5fa;text-decoration:none}
@media(max-width:480px){.stats{grid-template-columns:1fr}.info-grid{grid-template-columns:1fr}.stat-val{font-size:2.2rem}}
</style></head><body>
<div class="wrap">
  <div class="header"><div class="brand"><span>&#x25CF;</span> SentryXP</div><div class="badge">Health Report</div></div>
  <div class="banner">
    <h1>${esc(project.name)}</h1>
    <div class="url">${esc(project.url || '')}</div>
    <div class="date">&#x1F4C5; ${dateLabel}</div>
  </div>
  <div class="card">
    <div class="stats">
      <div><div class="stat-val" style="color:${uptimeColor}">${uptimePct}%</div><div class="stat-label">Uptime</div></div>
      <div><div class="stat-val" style="color:#C5D5F5">${totalChecks}</div><div class="stat-label">Checks</div></div>
      <div><div class="stat-val" style="color:#C5D5F5">${avgSec}s</div><div class="stat-label">Avg Speed</div></div>
    </div>
    <div class="info-grid">
      <div class="info-box" style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.2)">
        <h4 style="color:${green}">&#x2705; Availability</h4><p>Online <strong style="color:${green}">${uptimePct}%</strong> of the time</p>
      </div>
      <div class="info-box" style="background:rgba(76,107,205,0.1);border:1px solid rgba(76,107,205,0.2)">
        <h4 style="color:#4C6BCD">&#x26A1; Response</h4><p>Avg <strong style="color:#4C6BCD">${avgSec}s</strong> (${(minMs/1000).toFixed(1)}s–${(maxMs/1000).toFixed(1)}s)</p>
      </div>
      <div class="info-box" style="background:rgba(197,213,245,0.08);border:1px solid rgba(197,213,245,0.15)">
        <h4 style="color:#C5D5F5">&#x1F4CA; Monitoring</h4><p><strong style="color:#C5D5F5">${totalChecks}</strong> health checks run</p>
      </div>
      <div class="info-box" style="background:${incidentCount===0?'rgba(34,197,94,0.1)':'rgba(234,179,8,0.1)'};border:1px solid ${incidentCount===0?'rgba(34,197,94,0.2)':'rgba(234,179,8,0.2)'}">
        <h4 style="color:${incidentCount===0?green:yellow}">${incidentCount===0?'&#x2705; No Issues':'&#x26A0; Incidents'}</h4>
        <p><strong style="color:${incidentCount===0?green:yellow}">${incidentCount}</strong> incident${incidentCount!==1?'s':''}</p>
      </div>
    </div>
    <div class="sla-wrap">
      <div class="sla-label">Monthly SLA</div>
      <div class="sla-track"><div class="sla-fill" style="width:${Math.min(uptimeNum,100)}%;background:${uptimeColor}"></div></div>
      <div class="sla-hint">Target: 99.5% · ${uptimeNum>=99.5?'&#x2705; Meeting SLA':'&#x274C; Below SLA target'}</div>
    </div>
    ${compHtml?'<div class="section-title">Component Health</div><div class="comps">'+compHtml+'</div>':''}
  </div>
  <div class="footer">
    <p>Generated by <strong style="color:#C5D5F5">SentryXP Status Monitor</strong></p>
    <p style="margin-top:0.35rem"><a href="${dashUrl}">View live status &#x2192;</a></p>
  </div>
</div></body></html>`;
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
