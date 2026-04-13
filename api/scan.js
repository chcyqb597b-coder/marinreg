export const config = { maxDuration: 120 };

async function searchCategory(catName, catSites, dateCtx, apiKey) {
  const siteList = catSites.map(s => s.name).join(', ');
  const prompt = `Search the web for real maritime regulatory updates, circulars and guidance ${dateCtx} from these organizations: ${siteList}.

For each real item found:
- Use the EXACT URL from your search result
- Use the EXACT title from the search result
- Write 1-2 factual sentences as summary (no HTML tags)
- type: new = new regulation/requirement, update = amendment to existing rule, circular = guidance/advisory
- tags: max 3 relevant terms (CII, GHG, PSC, MARPOL, Cybersecurity, Ammonia, etc.)
- date: DD/MM/YYYY actual publication date
- source: exact organization name from the list above

If nothing found for a source in this period, skip it. Do NOT invent items.

Return ONLY valid JSON, nothing else:
{"items":[{"type":"new|update|circular","title":"exact title","summary":"1-2 sentences","tags":["TAG1","TAG2"],"date":"DD/MM/YYYY","source":"Org Name","url":"https://exact-url-from-search"}]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) throw new Error('API ' + response.status);
  const data = await response.json();
  const blocks = data.content || [];

  // Collect real URLs from search result blocks
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

  // Get last text block
  let text = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text' && blocks[i].text) { text = blocks[i].text; break; }
  }

  // Strip cite tags and extract JSON
  text = text.replace(/<cite[^>]*>[\s\S]*?<\/cite>/g, '').replace(/<\/?cite[^>]*>/g, '');
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
    const siteObj = catSites.find(s => s.name === item.source) || catSites[0];
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

  // Group sites by category
  const catMap = {};
  sites.forEach(s => {
    if (!catMap[s.cat]) catMap[s.cat] = [];
    catMap[s.cat].push(s);
  });
  const cats = Object.keys(catMap);

  // Search each category in parallel
  const results = [];
  const promises = cats.map(cat => 
    searchCategory(cat, catMap[cat], dateCtx, API_KEY)
      .then(items => { results.push(...items); })
      .catch(e => console.error('Cat failed:', cat, e.message))
  );

  await Promise.all(promises);

  return res.json({ items: results });
}
