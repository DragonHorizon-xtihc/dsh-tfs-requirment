import { readFileSync } from 'node:fs';

const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j ?? (await r.text()) };
}

function show(label, r) {
  const b = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  console.log(`${label}: HTTP ${r.status} :: ${b.slice(0, 240)}`);
}

const completed = '1997179@WN_HIS#analyze';

console.log('### 1) retry a COMPLETED task (design blocks)');
show('retry-completed', await post('/tfs-requirment/task-state', { taskId: completed, action: 'retry' }));
console.log('### 2) start a COMPLETED task');
show('start-completed', await post('/tfs-requirment/task-state', { taskId: completed, action: 'start' }));
console.log('### 3) optimistic lock: wrong revision');
show('wrong-rev', await post('/tfs-requirment/task-state', { taskId: completed, action: 'complete', expectedRevision: 999999 }));
console.log('### 4) nonexistent task');
show('no-task', await post('/tfs-requirment/task-state', { taskId: 'NOPE#1', action: 'start' }));
console.log('### 5) invalid action');
show('bad-action', await post('/tfs-requirment/task-state', { taskId: completed, action: 'explode' }));
console.log('### 6) collection switch to invalid');
show('bad-collection', await post('/tfs-requirment/collection', { collection: 'NO_SUCH_COLLECTION' }));
console.log('### 7) task-assign to nonexistent role');
show('bad-role', await post('/tfs-requirment/task-assign', { taskId: completed, roleName: 'NoSuchRole' }));
console.log('### 8) task-trace for completed task without runId');
{
  const r = await fetch(`${base}/tfs-requirment/task-trace?taskId=${encodeURIComponent(completed)}`, { headers: { cookie } });
  let j = null; try { j = await r.json(); } catch {}
  console.log(`task-trace: HTTP ${r.status} :: ${JSON.stringify(j).slice(0,240)}`);
}
