// netlify/functions/send-report.js
// Generates a styled HTML health report email and sends via SendGrid
const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';

const ch = () => ({
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: ch(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (token !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers: ch(), body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { recipientEmail, ccEmails, bodyMessage, projectName, projectType, projectUrl, dateRange, stats, components, incidents } = body;

    if (!recipientEmail || !projectName) {
      return { statusCode: 400, headers: ch(), body: JSON.stringify({ error: 'recipientEmail and projectName required' }) };
    }

    const html = generateReportHtml({ bodyMessage, projectName, projectType, projectUrl, dateRange, stats, components, incidents });
    const subject = `Health Report: ${projectName} — ${dateRange.from} to ${dateRange.to}`;

    /* Support multiple recipients (string or array) */
    const toList = Array.isArray(recipientEmail)
      ? recipientEmail.map(e => ({ email: e.trim() }))
      : [{ email: recipientEmail.trim() }];

    /* Build personalizations with optional CC */
    const personalization = { to: toList };
    if (ccEmails && ccEmails.length) {
      personalization.cc = ccEmails.map(e => ({ email: e.trim() }));
    }

    const sgRes = await fetch(SENDGRID_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [personalization],
        from: { email: process.env.ALERT_FROM_EMAIL, name: 'SentryXP Status Monitor' },
        subject,
        content: [{ type: 'text/html', value: html }],
      }),
    });

    if (!sgRes.ok) {
      const errText = await sgRes.text();
      throw new Error(`SendGrid error: ${sgRes.status} ${errText}`);
    }

    return { statusCode: 200, headers: ch(), body: JSON.stringify({ success: true }) };
  } catch (e) {
    return { statusCode: 500, headers: ch(), body: JSON.stringify({ error: e.message }) };
  }
};

/* ── HTML Email Generator ── */
function generateReportHtml({ bodyMessage, projectName, projectType, projectUrl, dateRange, stats, components, incidents }) {
  const blue = '#4C6BCD';
  const darkBlue = '#4d65ff';
  const lightBlue = '#C5D5F5';
  const bg = '#111827';
  const cardBg = '#1e293b';
  const borderClr = '#334155';
  const textMain = '#f1f5f9';
  const textDim = '#94a3b8';
  const green = '#22c55e';
  const yellow = '#eab308';
  const red = '#ef4444';

  const uptimeNum = parseFloat(stats.uptimePercent) || 0;
  const uptimeColor = uptimeNum >= 99 ? green : uptimeNum >= 95 ? yellow : red;
  const avgSec = ((stats.avgResponseMs || 0) / 1000).toFixed(1);
  const minSec = ((stats.minResponseMs || 0) / 1000).toFixed(1);
  const maxSec = ((stats.maxResponseMs || 0) / 1000).toFixed(1);
  const incidentCount = stats.incidentCount || 0;
  const totalChecks = stats.totalChecks || 0;

  const typeBadge = projectType
    ? `<span style="display:inline-block;background:${blue};color:#ffffff;font-size:11px;font-weight:600;padding:2px 10px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px;vertical-align:middle;margin-left:8px">${projectType}</span>`
    : '';

  /* Component health bars */
  let compRows = '';
  if (components && components.length) {
    compRows = components.map((c) => {
      const pct = parseFloat(c.operationalPercent) || 0;
      const barColor = pct >= 99 ? green : pct >= 90 ? yellow : red;
      return `
        <tr>
          <td style="padding:8px 12px;font-size:14px;color:${textMain};border-bottom:1px solid ${borderClr}">${c.name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid ${borderClr}">
            <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
              <td style="width:100%;padding:0">
                <div style="background:${borderClr};border-radius:4px;height:8px;overflow:hidden">
                  <div style="background:${barColor};width:${Math.min(pct, 100)}%;height:8px;border-radius:4px"></div>
                </div>
              </td>
              <td style="padding:0 0 0 10px;white-space:nowrap;font-size:13px;font-weight:600;color:${barColor}">${pct.toFixed(1)}%</td>
            </tr></table>
          </td>
        </tr>`;
    }).join('');
  }

  /* Incident rows */
  let incidentSection = '';
  if (incidents && incidents.length) {
    const rows = incidents.slice(0, 10).map((inc) => {
      const statusColor = inc.status === 'down' ? red : yellow;
      const statusLabel = inc.status === 'down' ? 'Down' : 'Degraded';
      return `
        <tr>
          <td style="padding:8px 12px;font-size:13px;color:${textDim};border-bottom:1px solid ${borderClr};white-space:nowrap">${inc.timestamp}</td>
          <td style="padding:8px 12px;font-size:13px;color:${statusColor};font-weight:600;border-bottom:1px solid ${borderClr}">${statusLabel}</td>
          <td style="padding:8px 12px;font-size:13px;color:${textMain};border-bottom:1px solid ${borderClr}">${inc.error || 'Issue detected'}</td>
        </tr>`;
    }).join('');

    incidentSection = `
      <tr><td style="padding:32px 40px 12px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${textDim};padding-bottom:12px">
            &#x26A0; Incidents (${incidents.length})
          </td></tr>
          <tr><td>
            <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${borderClr};border-radius:8px;overflow:hidden">
              <tr style="background:${borderClr}">
                <th style="padding:8px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:${textDim};text-align:left">Time</th>
                <th style="padding:8px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:${textDim};text-align:left">Status</th>
                <th style="padding:8px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:${textDim};text-align:left">Details</th>
              </tr>
              ${rows}
            </table>
          </td></tr>
        </table>
      </td></tr>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:${bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${bg}">
<tr><td align="center" style="padding:32px 16px">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%">

  <!-- Header -->
  <tr><td style="padding:0 0 24px">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="font-size:18px;font-weight:700;color:${lightBlue};letter-spacing:-0.3px">
        <span style="color:${blue}">&#x25CF;</span> SentryXP
      </td>
      <td align="right">
        <span style="display:inline-block;background:${darkBlue};color:#ffffff;font-size:10px;font-weight:700;padding:4px 12px;border-radius:4px;text-transform:uppercase;letter-spacing:1.5px">Health Report</span>
      </td>
    </tr></table>
  </td></tr>

  <!-- Project banner -->
  <tr><td style="background:linear-gradient(135deg,${blue},${darkBlue});padding:28px 40px;border-radius:12px 12px 0 0">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td>
        <div style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;margin-bottom:4px">${projectName}${typeBadge}</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.75);margin-top:6px">${projectUrl || ''}</div>
      </td>
    </tr><tr>
      <td style="padding-top:16px">
        <span style="display:inline-block;background:rgba(255,255,255,0.15);color:#ffffff;font-size:13px;padding:6px 14px;border-radius:6px;font-weight:500">
          &#x1F4C5; ${dateRange.from} &mdash; ${dateRange.to}
        </span>
      </td>
    </tr></table>
  </td></tr>

  <!-- Body message -->
  ${bodyMessage ? `
  <tr><td style="background:${cardBg};padding:28px 40px 0;border-left:1px solid ${borderClr};border-right:1px solid ${borderClr}">
    <div style="font-size:15px;color:${textMain};line-height:1.7;white-space:pre-line">${bodyMessage.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    <hr style="border:none;border-top:1px solid ${borderClr};margin:24px 0 0"/>
  </td></tr>` : ''}

  <!-- Big stat numbers -->
  <tr><td style="background:${cardBg};padding:32px 40px;border-left:1px solid ${borderClr};border-right:1px solid ${borderClr}">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td align="center" width="33%" style="padding:8px 0">
        <div style="font-size:42px;font-weight:800;color:${uptimeColor};line-height:1;letter-spacing:-1px">${stats.uptimePercent}%</div>
        <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${textDim};margin-top:8px">Uptime</div>
      </td>
      <td align="center" width="33%" style="padding:8px 0;border-left:1px solid ${borderClr};border-right:1px solid ${borderClr}">
        <div style="font-size:42px;font-weight:800;color:${lightBlue};line-height:1;letter-spacing:-1px">${totalChecks}</div>
        <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${textDim};margin-top:8px">Checks</div>
      </td>
      <td align="center" width="33%" style="padding:8px 0">
        <div style="font-size:42px;font-weight:800;color:${lightBlue};line-height:1;letter-spacing:-1px">${avgSec}s</div>
        <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${textDim};margin-top:8px">Avg Speed</div>
      </td>
    </tr></table>
  </td></tr>

  <!-- Info cards (2x2 grid) -->
  <tr><td style="background:${cardBg};padding:0 40px 32px;border-left:1px solid ${borderClr};border-right:1px solid ${borderClr}">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="50%" style="padding:6px 6px 6px 0">
          <div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.2);border-radius:10px;padding:18px 16px">
            <div style="font-size:13px;color:${green};font-weight:600;margin-bottom:4px">&#x2705; Availability</div>
            <div style="font-size:14px;color:${textMain};line-height:1.5">Your site was online <strong style="color:${green}">${stats.uptimePercent}%</strong> of the time</div>
          </div>
        </td>
        <td width="50%" style="padding:6px 0 6px 6px">
          <div style="background:rgba(76,107,205,0.1);border:1px solid rgba(76,107,205,0.2);border-radius:10px;padding:18px 16px">
            <div style="font-size:13px;color:${blue};font-weight:600;margin-bottom:4px">&#x26A1; Response Time</div>
            <div style="font-size:14px;color:${textMain};line-height:1.5">Average speed: <strong style="color:${blue}">${avgSec}s</strong> (${minSec}s – ${maxSec}s)</div>
          </div>
        </td>
      </tr>
      <tr>
        <td width="50%" style="padding:6px 6px 6px 0">
          <div style="background:rgba(197,213,245,0.08);border:1px solid rgba(197,213,245,0.15);border-radius:10px;padding:18px 16px">
            <div style="font-size:13px;color:${lightBlue};font-weight:600;margin-bottom:4px">&#x1F4CA; Monitoring</div>
            <div style="font-size:14px;color:${textMain};line-height:1.5"><strong style="color:${lightBlue}">${totalChecks}</strong> health checks completed</div>
          </div>
        </td>
        <td width="50%" style="padding:6px 0 6px 6px">
          <div style="background:${incidentCount === 0 ? 'rgba(34,197,94,0.1)' : 'rgba(234,179,8,0.1)'};border:1px solid ${incidentCount === 0 ? 'rgba(34,197,94,0.2)' : 'rgba(234,179,8,0.2)'};border-radius:10px;padding:18px 16px">
            <div style="font-size:13px;color:${incidentCount === 0 ? green : yellow};font-weight:600;margin-bottom:4px">${incidentCount === 0 ? '&#x2705; No Issues' : '&#x26A0; Incidents'}</div>
            <div style="font-size:14px;color:${textMain};line-height:1.5"><strong style="color:${incidentCount === 0 ? green : yellow}">${incidentCount}</strong> incident${incidentCount !== 1 ? 's' : ''} ${incidentCount === 0 ? 'this period' : 'detected'}</div>
          </div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Component health bars -->
  ${components && components.length ? `
  <tr><td style="background:${cardBg};padding:0 40px 32px;border-left:1px solid ${borderClr};border-right:1px solid ${borderClr}">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${textDim};padding-bottom:12px">
        Component Health
      </td></tr>
      <tr><td>
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${borderClr};border-radius:8px;overflow:hidden">
          ${compRows}
        </table>
      </td></tr>
    </table>
  </td></tr>` : ''}

  <!-- Incidents -->
  ${incidentSection}

  <!-- Footer -->
  <tr><td style="background:${cardBg};padding:24px 40px;border-top:1px solid ${borderClr};border-left:1px solid ${borderClr};border-right:1px solid ${borderClr};border-bottom:1px solid ${borderClr};border-radius:0 0 12px 12px">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="font-size:12px;color:${textDim};line-height:1.6">
        Generated by <strong style="color:${lightBlue}">SentryXP Status Monitor</strong><br/>
        ${new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}
      </td>
      <td align="right" style="font-size:12px;color:${textDim}">
        <span style="color:${blue}">&#x25CF;</span> sentryxp.com
      </td>
    </tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}
