// netlify/functions/get-projects.js
const BASE_ID   = process.env.AIRTABLE_BASE_ID;
const API_TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_URL  = `https://api.airtable.com/v0/${BASE_ID}/Projects`;

function slugify(str) {
  return (str||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}

exports.handler = async () => {
  try {
    const res  = await fetch(`${BASE_URL}?view=Grid%20view`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Airtable error: ${res.status} ${text}`);
    const data = JSON.parse(text);
    const projects = (data.records||[]).map(r => ({
      airtableId:   r.id,
      name:         r.fields['Project Name'] || '',
      type:         (r.fields['Type']||'shopify').toLowerCase(),
      url:          r.fields['URL'] || '',
      intervalMins: r.fields['Check Interval (mins)'] || 15,
      alertEmail:   r.fields['Alert Email'] || '',
      id:           slugify(r.fields['Project Name']),
    }));
    return {
      statusCode: 200,
      headers: { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' },
      body: JSON.stringify({ projects }),
    };
  } catch(e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
