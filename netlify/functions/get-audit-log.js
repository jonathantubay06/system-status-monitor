// netlify/functions/get-audit-log.js
const { getAuditLog } = require('./_audit');

const ch = () => ({
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: ch(), body: '' };

  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (token !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers: ch(), body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const entries = await getAuditLog();
    return { statusCode: 200, headers: ch(), body: JSON.stringify({ entries }) };
  } catch (e) {
    return { statusCode: 500, headers: ch(), body: JSON.stringify({ error: e.message }) };
  }
};
