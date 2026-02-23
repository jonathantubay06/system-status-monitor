// netlify/functions/_airtable.js
const BASE_ID   = process.env.AIRTABLE_BASE_ID;
const API_TOKEN = process.env.AIRTABLE_TOKEN;
const TABLE     = 'Projects';
const BASE_URL  = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`;

const headers = {
  Authorization: `Bearer ${API_TOKEN}`,
  'Content-Type': 'application/json',
};

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function mapRecord(record) {
  const f = record.fields;
  return {
    airtableId:   record.id,
    name:         f['Project Name'] || '',
    type:         (f['Type'] || 'shopify').toLowerCase(),
    url:          f['URL'] || '',
    intervalMins: f['Check Interval (mins)'] || 15,
    alertEmail:   f['Alert Email'] || '',
    id:           slugify(f['Project Name']),
  };
}

async function getProjects() {
  const url = `${BASE_URL}?view=Grid%20view`;
  console.log('Fetching:', url);
  const res  = await fetch(url, { headers });
  const text = await res.text();
  console.log('Response:', res.status, text.substring(0, 300));
  if (!res.ok) throw new Error(`Airtable GET failed: ${res.status} ${text}`);
  const data = JSON.parse(text);
  return (data.records || []).map(mapRecord);
}

async function addProject({ name, type, url, intervalMins, alertEmail }) {
  const res = await fetch(BASE_URL, {
    method: 'POST', headers,
    body: JSON.stringify({
      records: [{ fields: {
        'Project Name': name, 'Type': type, 'URL': url,
        'Check Interval (mins)': Number(intervalMins) || 15,
        'Alert Email': alertEmail || '',
      }}],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable POST failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

async function updateProject({ airtableId, name, type, url, intervalMins, alertEmail }) {
  const res = await fetch(`${BASE_URL}/${airtableId}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ fields: {
      'Project Name': name, 'Type': type, 'URL': url,
      'Check Interval (mins)': Number(intervalMins) || 15,
      'Alert Email': alertEmail || '',
    }}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable PATCH failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

async function deleteProject(airtableId) {
  const res = await fetch(`${BASE_URL}/${airtableId}`, { method: 'DELETE', headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable DELETE failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

module.exports = { getProjects, addProject, updateProject, deleteProject };
