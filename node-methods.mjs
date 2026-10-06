const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

// GET /requirements (no body)
const getR = await fetch(`${base}/tfs-requirment/requirements`, {
  method: 'GET', headers: { cookie },
});
console.log('GET  /requirements =>', getR.status, getR.headers.get('allow') ?? '', (await getR.text()).slice(0, 80));

// POST /requirements with default filter
const postR = await fetch(`${base}/tfs-requirment/requirements`, {
  method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ top: 5 }),
});
console.log('POST /requirements =>', postR.status);
const j = await postR.json().catch(() => null);
if (j) console.log('  keys:', Object.keys(j), 'items:', j.items?.length ?? j.requirements?.length ?? 'n/a');

// no cookie -> 401
const noAuth = await fetch(`${base}/tfs-requirment/requirements`, { method: 'POST' });
console.log('POST /requirements (no cookie) =>', noAuth.status);
