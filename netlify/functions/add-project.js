// netlify/functions/add-project.js
const BASE_ID   = process.env.AIRTABLE_BASE_ID;
const API_TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_URL  = `https://api.airtable.com/v0/${BASE_ID}/Projects`;

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
    if (body.__dryRun) return { statusCode:200, headers:ch(), body:JSON.stringify({ ok:true }) };

    const { name, type, url, alertEmail, checkPage, loginEmail, loginPassword, group, alertThreshold, alertChannel } = body;
    if (!name||!type||!url) return { statusCode:400, headers:ch(), body:JSON.stringify({ error:'name, type and url required' }) };

    /* Build fields object — omit empty optional fields so Airtable doesn't
       try to write them to columns that may not exist in user's schema */
    const fields = {
      'Project Name': name,
      'Type': type,
      'URL': url,
      'Alert Threshold (min)': parseInt(alertThreshold) || 0,
      'Alert Channel': alertChannel || 'email',
    };
    if (alertEmail)    fields['Alert Email']    = alertEmail;
    if (checkPage)     fields['Check Page']     = checkPage;
    if (loginEmail)    fields['Login Email']    = loginEmail;
    if (loginPassword) fields['Login Password'] = loginPassword;
    if (group)         fields['Client']         = group;

    /* POST with auto-retry: if Airtable returns 422 UNKNOWN_FIELD_NAME, strip
       that field from the request and retry. This makes the function resilient
       to schema differences (e.g. user hasn't added a "Client" column yet). */
    let lastErr = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { Authorization:`Bearer ${API_TOKEN}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ records:[{ fields }] }),
      });
      const text = await res.text();
      if (res.ok) return { statusCode:200, headers:ch(), body:JSON.stringify({ success:true }) };
      lastErr = `Airtable POST failed: ${res.status} ${text}`;
      // If unknown field name, remove it from fields and retry
      // Airtable returns escaped quotes: "Unknown field name: \"Client\""
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