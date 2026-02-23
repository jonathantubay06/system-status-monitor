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

    const { name, type, url, intervalMins, alertEmail, checkPage } = body;
    if (!name||!type||!url) return { statusCode:400, headers:ch(), body:JSON.stringify({ error:'name, type and url required' }) };

    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: { Authorization:`Bearer ${API_TOKEN}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ records:[{ fields:{
        'Project Name': name, 'Type': type, 'URL': url,
        'Check Interval (mins)': Number(intervalMins)||15,
        'Alert Email': alertEmail||'',
        'Check Page': checkPage||'',
      }}]}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Airtable POST failed: ${res.status} ${text}`);
    return { statusCode:200, headers:ch(), body:JSON.stringify({ success:true }) };
  } catch(e) {
    return { statusCode:500, headers:ch(), body:JSON.stringify({ error:e.message }) };
  }
};
