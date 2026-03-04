const GITHUB_RAW = 'https://raw.githubusercontent.com/jonathantubay06/system-status-monitor/main/dashboard';

function generateBadgeSvg(label, value, color) {
  const labelWidth = Math.max(label.length * 6.5 + 12, 40);
  const valueWidth = Math.max(value.length * 7.2 + 12, 40);
  const totalWidth = labelWidth + valueWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="13">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelWidth + valueWidth / 2}" y="13">${value}</text>
  </g>
</svg>`;
}

function svgHeaders() {
  return {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=300',
    'Access-Control-Allow-Origin': '*',
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const projectId = params.project;
  const badgeType = params.type || 'uptime';

  if (!projectId) {
    return {
      statusCode: 400,
      headers: svgHeaders(),
      body: generateBadgeSvg('error', 'missing ?project=', '#9f9f9f'),
    };
  }

  try {
    const [statusRes, histRes] = await Promise.all([
      fetch(GITHUB_RAW + '/status.json?t=' + Date.now()),
      fetch(GITHUB_RAW + '/history.json?t=' + Date.now()),
    ]);

    const statusData = await statusRes.json();
    const historyData = histRes.ok ? await histRes.json() : [];

    const project = (statusData.results || []).find(r => r.id === projectId);
    if (!project) {
      return {
        statusCode: 404,
        headers: svgHeaders(),
        body: generateBadgeSvg('status', 'not found', '#9f9f9f'),
      };
    }

    let label, value, color;

    if (badgeType === 'status') {
      label = project.name.length > 20 ? project.name.slice(0, 18) + '..' : project.name;
      value = project.status === 'operational' ? 'operational' : project.status;
      color = project.status === 'operational' ? '#22c55e' : project.status === 'degraded' ? '#eab308' : '#ef4444';
    } else {
      // Compute uptime from history
      const entries = historyData.flatMap(h =>
        (h.results || []).filter(r => r.id === projectId)
      );
      const pct = entries.length
        ? ((entries.filter(r => r.status === 'operational').length / entries.length) * 100).toFixed(1)
        : '--';
      label = 'uptime';
      value = pct + '%';
      const num = parseFloat(pct);
      color = isNaN(num) ? '#9f9f9f' : num >= 99 ? '#22c55e' : num >= 95 ? '#eab308' : '#ef4444';
    }

    return {
      statusCode: 200,
      headers: svgHeaders(),
      body: generateBadgeSvg(label, value, color),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: svgHeaders(),
      body: generateBadgeSvg('status', 'error', '#9f9f9f'),
    };
  }
};
