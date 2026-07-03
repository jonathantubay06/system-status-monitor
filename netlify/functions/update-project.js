// netlify/functions/update-project.js
const BASE_ID   = process.env.AIRTABLE_BASE_ID;
const API_TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_URL  = `https://api.airtable.com/v0/${BASE_ID}/Projects`;
const { logAudit } = require('./_audit');

const ch = () => ({ 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization,Content-Type' });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:ch(), body:'' };
  if (event.httpMethod !== 'POST') return { statusCode:405, body:'Method not allowed' };

  const token = (event.headers['authorization']||'').replace('Bearer ','');
  if (token !== process.env.ADMIN_PASSWORD) {
    return { statusCode:401, headers:ch(), body:JSON.stringify({ error:'Unauthorized' }) };
  }

  try {
    const body = JSON.parse(event.body||'{}');
    const { airtableId, name, type, url, alertEmail, checkPage, loginEmail, loginPassword, group, alertThreshold, alertChannel } = body;
    if (!airtableId) return { statusCode:400, headers:ch(), body:JSON.stringify({ error:'airtableId required' }) };
    if (!name||!type||!url) return { statusCode:400, headers:ch(), body:JSON.stringify({ error:'name, type and url required' }) };

    const fields = {
      'Project Name': name,
      'Type': type,
      'URL': url,
      'Alert Threshold (min)': parseInt(alertThreshold) || 0,
      'Alert Channel': alertChannel || 'email',
    };
    /* For PATCH, send empty strings for unfilled fields so Airtable clears them
       (different from POST where empty optional fields are omitted) */
    fields['Alert Email']    = alertEmail || '';
    fields['Check Page']     = checkPage || '';
    fields['Login Email']    = loginEmail || '';
    fields['Login Password'] = loginPassword || '';
    if (group !== undefined) fields['Client'] = group;

    let lastErr = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`${BASE_URL}/${airtableId}`, {
        method: 'PATCH',
        headers: { Authorization:`Bearer ${API_TOKEN}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ fields }),
      });
      const text = await res.text();
      if (res.ok) {
        await logAudit('update_project', { name, type, url });
        return { statusCode:200, headers:ch(), body:JSON.stringify({ success:true }) };
      }
      lastErr = `Airtable PATCH failed: ${res.status} ${text}`;
      const m = text.match(/Unknown field name:\s*\\"([^"\\]+)\\"/);
      if (m && fields[m[1]] !== undefined) {
        console.log(`Stripping unknown Airtable field "${m[1]}" and retrying`);
        delete fields[m[1]];
        continue;
      }
      break;
    }
    throw new Error(lastErr);
  } catch(e) {
    return { statusCode:500, headers:ch(), body:JSON.stringify({ error:e.message }) };
  }
};
