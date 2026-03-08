// netlify/functions/save-incident-note.js
// Saves incident notes to dashboard/incident-notes.json via GitHub Contents API
const ch = () => ({
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: ch(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: ch(), body: 'Method not allowed' };

  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (token !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers: ch(), body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { projectId, incidentStart, note } = JSON.parse(event.body || '{}');
    if (!projectId || !incidentStart || !note) {
      return { statusCode: 400, headers: ch(), body: JSON.stringify({ error: 'projectId, incidentStart, and note required' }) };
    }

    const ghToken = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO || 'jonathantubay06/system-status-monitor';
    const path = 'dashboard/incident-notes.json';
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;

    // Get current file
    const getRes = await fetch(apiUrl, { headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github.v3+json' } });
    let notes = [];
    let sha = '';
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
      notes = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    }

    // Add new note
    notes.push({ projectId, incidentStart, note, addedAt: new Date().toISOString() });

    // Write back
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Add incident note for ${projectId}`,
        content: Buffer.from(JSON.stringify(notes, null, 2) + '\n').toString('base64'),
        sha,
      }),
    });

    if (!putRes.ok) {
      const err = await putRes.text();
      throw new Error(`GitHub API error: ${putRes.status} ${err}`);
    }

    return { statusCode: 200, headers: ch(), body: JSON.stringify({ success: true, notes }) };
  } catch (e) {
    return { statusCode: 500, headers: ch(), body: JSON.stringify({ error: e.message }) };
  }
};
