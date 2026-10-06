const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
const getR = await fetch(`${base}/tfs-requirment/requirements`, { method: 'GET', headers: { cookie } });
const body = await getR.text();
console.log('GET /requirements =>', getR.status, '| allow:', getR.headers.get('allow'), '| body:', body.slice(0, 90));
