import { readFileSync } from 'node:fs';

const dataDir = 'D:/ClaudeCode/deepseek-harness/plugins/dsh-tfs-requirment/.tfs-requirment-data';
const raw = JSON.parse(readFileSync(`${dataDir}/profiles.json`, 'utf8'));
const cfg = Array.isArray(raw) ? raw[0] : (raw.profiles?.[0] ?? raw);
const pat = cfg.pat;
const base = cfg.url.replace(/\/+$/, '');
const coll = cfg.collection;
const auth = 'Basic ' + Buffer.from(':' + pat, 'utf8').toString('base64');
console.log('pat length =', pat.length, 'base =', base, 'coll =', coll);

async function timed(label, fn) {
  const t = Date.now();
  try {
    const r = await fn();
    const text = await r.text();
    console.log(`${label}: ${r.status} in ${Date.now()-t}ms len=${text.length}`);
    return text;
  } catch (e) {
    console.log(`${label}: FAIL in ${Date.now()-t}ms :: ${e.message}`);
  }
}

// server-level connection data
await timed('connectiondata(server)', () =>
  fetch(`${base}/_apis/connectiondata`, { headers: { Authorization: auth } }));

// collection-level WIQL
const wiql = JSON.stringify({ query: 'SELECT [System.Id] FROM WorkItems ORDER BY [System.ChangedDate] DESC' });
const w = await timed('WIQL(collection)', () =>
  fetch(`${base}/${coll}/_apis/wit/wiql?api-version=2.0`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: wiql,
  }));
if (w) console.log(w.slice(0, 300));
