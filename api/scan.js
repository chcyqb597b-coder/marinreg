export const config = { maxDuration: 120 };

async function searchGroup(groupSites, dateCtx, apiKey) {
  const siteList = groupSites.map(s => s.name).join(', ');
  const prompt = `Search the web for real maritime regulatory updates, circulars and guidance ${dateCtx} from these organizations: ${siteList}.

Find as many real items as possible. For each item:
- EXACT URL from search result
- EXACT title
- 1-2 sentence summary (no HTML)
- type: new/update/circular
- tags: max 3 terms
- date: DD/MM/YYYY
- source: exact org name from list above

Skip sources with nothing new. Do NOT invent items.

Return ONLY valid JSON with no markdown, no code blocks, no backticks:
{"items":[{"type":"new|update|circular","title":"...","summary":"...","tags":["TAG"],"date":"DD/MM/YYYY","source":"Org Name","url":"https://..."}]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('API ' + response.status + ': ' + err.substring(0, 100));
  }

  const data = await response.json();
  const blocks = data.content || [];

  const realUrls = {};
  blocks.forEach(b => {
    if (b.type === 'web_search_tool_result') {
      (b.content || []).forEach(r => {
        if (r && r.url && r.title) {
          realUrls[r.title.toLowerCase().substring(0, 60)] = r.url;
        }
      });
    }
  });

  let text = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text' && blocks[i].text) { text = blocks[i].text; break; }
  }

  // Strip markdown code blocks and cite tags
  text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  text = text.replace(/<cite[^>]*>[\s\S]*?<\/cite>/g, '').replace(/<\/?cite[^>]*>/g, '');

  // Extract JSON object
  let depth = 0, start = -1, found = '';
  for (let ci = 0; ci < text.length; ci++) {
    const ch = text[ci];
    if (ch === '{') { if (depth === 0) start = ci; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { found = text.slice(start, ci + 1); break; } }
  }

  if (!found) return [];
  let parsed;
  try { parsed = JSON.parse(found); } catch (e) { return []; }

  return (parsed.items || []).map(item => {
    const siteObj = groupSites.find(s => s.name === item.source) || groupSites[0];
    let url = item.url || '';
    const titleKey = (item.title || '').toLowerCase().substring(0, 60);
    if (realUrls[titleKey]) url = realUrls[titleKey];
    if (!url || !url.startsWith('http')) url = siteObj.url;
    return {
      type: item.type || 'update',
      title: item.title || '',
      summary: item.summary || '',
      tags: item.tags || [],
      date: item.date || new Date().toLocaleDateString('en-GB'),
      url,
      source: item.source || siteObj.name,
      icon: siteObj.icon,
      cat: siteObj.cat
    };
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sites, fromDate, toDate } = req.body;
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });

  const dateCtx = (fromDate || toDate)
    ? `published between ${fromDate || 'any'} and ${toDate || 'today'}`
    : 'from the last 30 days';

  const half = Math.ceil(sites.length / 2);
  const group1 = sites.slice(0, half);
  const group2 = sites.slice(half);

  const results = [];
  const [r1, r2] = await Promise.allSettled([
    searchGroup(group1, dateCtx, API_KEY),
    searchGroup(group2, dateCtx, API_KEY)
  ]);

  if (r1.status === 'fulfilled') results.push(...r1.value);
  if (r2.status === 'fulfilled') results.push(...r2.value);

  return res.json({ items: results });
}
