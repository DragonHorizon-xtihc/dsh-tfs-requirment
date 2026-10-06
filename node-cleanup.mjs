const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
const ids = [
  '2004154@WN_HIS#manual-通用工程师-20261004170928',
  '2004154@WN_HIS#manual-通用工程师-20261004171235',
];
for (const id of ids) {
  const c = await fetch(`${base}/tfs-requirment/task-state`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ taskId: id, action: 'cancel' }),
  });
  console.log('cancel', id.slice(-15), c.status);
  const d = await fetch(`${base}/tfs-requirment/task-delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ taskIds: [id] }),
  });
  console.log('delete', id.slice(-15), d.status, (await d.text()).slice(0, 80));
}
