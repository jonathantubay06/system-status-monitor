// netlify/functions/add-project.js
const { addProject } = require('./_airtable');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  // Auth
  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (token !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers: corsHeaders(), body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // Dry run check (used by login verification)
    if (body.__dryRun) {
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true }) };
    }

    const { name, type, url, intervalMins, alertEmail } = body;
    if (!name || !type || !url) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'name, type and url are required' }) };
    }

    const result = await addProject({ name, type, url, intervalMins, alertEmail });
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ success: true, record: result.records?.[0] }),
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: e.message }) };
  }
};

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}
function cors() { return { statusCode: 200, headers: corsHeaders(), body: '' }; }
