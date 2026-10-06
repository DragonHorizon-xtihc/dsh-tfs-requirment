const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
}
async function settle(id) {
  // wait until not running
  for (let i=0;i<15;i++){
    const r = await fetch(`${base}/tfs-requirment/board`, { headers: { cookie } });
    const b = await r.json();
    const t = b.tasks.find(x=>x.taskId===id);
    if (!t) return;
    if (t.execState !== 'running' && t.execState !== 'queued') break;
    await new Promise(r=>setTimeout(r,2000));
  }
  console.log('  cancel:', JSON.stringify((await post('/tfs-requirment/task-state', { taskId:id, action:'cancel' })).body).slice(0,150));
  console.log('  delete:', JSON.stringify((await post('/tfs-requirment/task-delete', { taskIds:[id] })).body).slice(0,150));
}

const runIds = [];
for (let n=1; n<=3; n++) {
  const dr = await post('/tfs-requirment/dispatch', {
    targetWorkItem: '2004154@WN_HIS', collection: 'WN_HIS',
    draft: {
      roleName: '通用工程师',
      title: `runid探针${n}`,
      prompt: `连通性测试第${n}次，请直接回复：${n}`,
      frozenConfig: { mcp: [], skills: [] },
    },
  });
  console.log(`#${n} taskId=${dr.body?.taskId} runId=${dr.body?.runId}`);
  runIds.push(dr.body?.runId);
  if (dr.body?.taskId) await settle(dr.body.taskId);
}
console.log('\nrunIds:', runIds);
console.log('all identical?', runIds.every(x=>x===runIds[0]));
