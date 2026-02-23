// netlify/functions/_airtable.js
// Shared Airtable API helper

const BASE_ID   = process.env.AIRTABLE_BASE_ID;
const API_TOKEN = process.env.AIRTABLE_TOKEN;
const TABLE     = 'Projects';
const BASE_URL  = `https://api.airtable.com/v0/${BASE_ID}/${TABLE}`;

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
  const res  = await fetch(`${BASE_URL}?view=Grid%20view`, { headers });
  if (!res.ok) throw new Error(`Airtable GET failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.records || []).map(mapRecord);
}

async function addProject({ name, type, url, intervalMins, alertEmail }) {
  const res = await fetch(BASE_URL, {
    method:  'POST',
    headers,
    body: JSON.stringify({
      records: [{
        fields: {
          'Project Name':        name,
          'Type':                type,
          'URL':                 url,
          'Check Interval (mins)': Number(intervalMins) || 15,
          'Alert Email':         alertEmail || '',
        },
      }],
    }),
  });
  if (!res.ok) throw new Error(`Airtable POST failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateProject({ airtableId, name, type, url, intervalMins, alertEmail }) {
  const res = await fetch(`${BASE_URL}/${airtableId}`, {
    method:  'PATCH',
    headers,
    body: JSON.stringify({
      fields: {
        'Project Name':          name,
        'Type':                  type,
        'URL':                   url,
        'Check Interval (mins)': Number(intervalMins) || 15,
        'Alert Email':           alertEmail || '',
      },
    }),
  });
  if (!res.ok) throw new Error(`Airtable PATCH failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteProject(airtableId) {
  const res = await fetch(`${BASE_URL}/${airtableId}`, { method: 'DELETE', headers });
  if (!res.ok) throw new Error(`Airtable DELETE failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { getProjects, addProject, updateProject, deleteProject };
