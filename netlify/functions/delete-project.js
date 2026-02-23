// netlify/functions/delete-project.js
const { deleteProject } = require('./_airtable');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (token !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers: corsHeaders(), body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { airtableId } = JSON.parse(event.body || '{}');
    if (!airtableId) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'airtableId required' }) };
    }
    await deleteProject(airtableId);
    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ success: true }) };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: e.message }) };
  }
};

function corsHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
}
function cors() { return { statusCode: 200, headers: corsHeaders(), body: '' }; }
