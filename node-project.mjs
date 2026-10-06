const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
const t0 = Date.now();
const r = await fetch(`${base}/tfs-requirment/requirements`, {
  method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projects: ['体检管理'], top: 20 }),
});
const j = await r.json();
console.log(`指定项目(体检管理) HTTP ${r.status} ${Date.now()-t0}ms ok=${j.ok} items=${j.items?.length} total=${j.total}`);
if (j.items) console.log('前3项:', j.items.slice(0,3).map(x=>`${x.id} ${x.title}`).join(' | '));
