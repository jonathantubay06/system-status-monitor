// netlify/functions/send-report.js
// Generates a styled HTML health report email and sends via Resend (preferred) or SendGrid (fallback)
const RESEND_URL = 'https://api.resend.com/emails';
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
    const { recipientEmail, ccEmails, greeting, bodyMessage, projectId, projectName, projectType, projectUrl, dateRange, stats, components, incidents, clientReports, htmlContent } = body;

    if (!recipientEmail || !projectName) {
      return { statusCode: 400, headers: ch(), body: JSON.stringify({ error: 'recipientEmail and projectName required' }) };
    }

    /* HTML always comes pre-built from the dashboard's previewReport() — the
       single source of truth for the email template. */
    if (!htmlContent || htmlContent.length < 100) {
      return { statusCode: 400, headers: ch(), body: JSON.stringify({ error: 'htmlContent missing — open the report preview first' }) };
    }
    const html = htmlContent;
    const subject = `Health Report: ${projectName} — ${dateRange.from} to ${dateRange.to}`;

    /* Normalize recipients to arrays of email strings */
    const toEmails = Array.isArray(recipientEmail)
      ? recipientEmail.map(e => e.trim()).filter(Boolean)
      : [recipientEmail.trim()];
    const ccList = (ccEmails && ccEmails.length) ? ccEmails.map(e => e.trim()).filter(Boolean) : [];

    /* Choose provider: Resend (preferred), falls back to SendGrid */
    const provider = process.env.RESEND_API_KEY ? 'resend' : 'sendgrid';

    if (provider === 'resend') {
      /* ─── Resend ─── */
      const fromEmail = process.env.RESEND_FROM_EMAIL || process.env.ALERT_FROM_EMAIL;
      if (!fromEmail) throw new Error('RESEND_FROM_EMAIL (or ALERT_FROM_EMAIL) not set in env');
      const payload = {
        from: `SentryXP Status Monitor <${fromEmail}>`,
        to: toEmails,
        subject,
        html,
      };
      if (ccList.length) payload.cc = ccList;

      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Resend error: ${res.status} ${errText}`);
      }
      const data = await res.json().catch(() => ({}));
      return { statusCode: 200, headers: ch(), body: JSON.stringify({ success: true, provider: 'resend', id: data.id }) };
    } else {
      /* ─── SendGrid (fallback) ─── */
      const personalization = { to: toEmails.map(e => ({ email: e })) };
      if (ccList.length) personalization.cc = ccList.map(e => ({ email: e }));

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
      return { statusCode: 200, headers: ch(), body: JSON.stringify({ success: true, provider: 'sendgrid' }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: ch(), body: JSON.stringify({ error: e.message }) };
  }
};
