const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

async function timed(label, body) {
  const t0 = Date.now();
  const r = await fetch(`${base}/tfs-requirment/requirements`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  const ms = Date.now() - t0;
  let j; try { j = JSON.parse(text); } catch { j = text; }
  console.log(`[${label}] HTTP ${r.status} ${ms}ms ok=${j?.ok} items=${j?.items?.length ?? 'n/a'} total=${j?.total ?? 'n/a'}`);
  if (j?.reason) console.log('   reason:', j.reason.slice(0, 200));
}

// 1. 空 filter（全集合 WIQL）
await timed('空filter {}', {});
// 2. 带项目过滤（对照，真实项目名）
await timed('指定项目(体检管理)', { projects: ['体检管理'], top: 20 });
