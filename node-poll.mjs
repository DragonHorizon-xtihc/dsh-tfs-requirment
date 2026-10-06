const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

async function getBoard() {
  const r = await fetch(`${base}/tfs-requirment/board`, { headers: { cookie } });
  return r.json();
}
async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  let j=null; try{ j=await r.json(); }catch{ j=await r.text(); }
  return { status: r.status, body: j };
}

const b0 = await getBoard();
console.log('tasks type:', Array.isArray(b0.tasks) ? 'array' : 'object', 'count:', b0.tasks.length);
const target = '2004154@WN_HIS#manual-通用工程师-20261004170928';

for (let i = 0; i < 20; i++) {
  const b = await getBoard();
  const t = b.tasks.find(x => x.taskId === target);
  if (!t) { console.log('not found'); break; }
  const last = t.attempts?.[t.attempts.length - 1];
  console.log(`[${i}] state=${t.state} exec=${t.execState} runId=${last?.runId ?? '-'} stop=${last?.stopReason ?? '-'} diag=${(last?.diagnostic ?? '').slice(0,120)}`);
  if (t.state !== 'in_progress' && t.execState !== 'running' && t.execState !== 'queued') {
    console.log('FINAL:', JSON.stringify({ state: t.state, execState: t.execState, output: last?.output, diagnostic: last?.diagnostic, stopReason: last.stopReason }, null, 2).slice(0, 1500));
    break;
  }
  await new Promise(r => setTimeout(r, 4000));
}

// Cleanup: cancel then delete
const t = (await getBoard()).tasks.find(x => x.taskId === target);
if (t && t.state !== 'deleted') {
  const cancel = await post('/tfs-requirment/task-cancel', { taskIds: [target] });
  console.log('cancel:', JSON.stringify(cancel.body).slice(0,160));
  const del = await post('/tfs-requirment/task-delete', { taskIds: [target] });
  console.log('delete:', JSON.stringify(del.body).slice(0,160));
}
