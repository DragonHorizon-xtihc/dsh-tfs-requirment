const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
res = await fetch(`${base}/`, { headers: { cookie } });
const html = await res.text();
console.log('HTML length:', html.length);
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
const links = [...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map(m => m[1]);
console.log('scripts:', scripts);
console.log('links:', links);

// Fetch main JS bundle and grep for API path strings
for (const s of scripts) {
  const url = s.startsWith('http') ? s : `${base}${s.startsWith('/') ? '' : '/'}${s}`;
  const jr = await fetch(url, { headers: { cookie } });
  const js = await jr.text();
  console.log(`\n=== bundle ${s} length=${js.length} ===`);
  // find path-like strings with api/session/chat/agent
  const paths = new Set();
  for (const m of js.matchAll(/["'``](\/[a-z0-9][a-z0-9_\-\/\.{}:]{2,60})["'``]/g)) {
    const p = m[1];
    if (/session|chat|agent|api|conversation|message|run|task/i.test(p)) paths.add(p);
  }
  console.log([...paths].sort().join('\n'));
}
