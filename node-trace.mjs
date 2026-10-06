const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
}

const MARK = '轨迹串隔离验证' + Date.now();
// 1. dispatch
const dr = await post('/tfs-requirment/dispatch', {
  targetWorkItem: '2004154@WN_HIS', collection: 'WN_HIS',
  draft: {
    roleName: '通用工程师',
    title: MARK,
    prompt: `这是轨迹串验证。唯一标记：${MARK}。请直接回复：收到`,
    frozenConfig: { mcp: [], skills: [] },
  },
});
const taskId = dr.body?.taskId;
console.log('taskId:', taskId, 'runId:', dr.body?.runId);

// 2. wait settle
for (let i = 0; i < 15; i++) {
  const b = await (await fetch(`${base}/tfs-requirment/board`, { headers: { cookie } })).json();
  const t = b.tasks.find(x => x.taskId === taskId);
  if (!t || (t.execState !== 'running' && t.execState !== 'queued')) {
    console.log('settled execState=', t?.execState, 'state=', t?.state);
    break;
  }
  await new Promise(r => setTimeout(r, 2000));
}

// 3. get trace
  const tr = await (await fetch(`${base}/tfs-requirment/task-trace?taskId=${encodeURIComponent(taskId)}`, {
    headers: { cookie },
  })).json();
  console.log('trace available:', tr.available, 'source:', tr.source, 'running:', tr.running);
  const allText = JSON.stringify(tr.entries ?? []);
  const markers = [
    ['runid探针', /runid探针/g],
    ['连通性测试', /连通性测试/g],
    ['本次标记', new RegExp(MARK, 'g')],
  ];
  for (const [name, re] of markers) {
    const m = allText.match(re);
    console.log(`  entries 中「${name}」出现次数:`, m ? m.length : 0);
  }
  console.log('  total entries:', tr.total, 'returned:', (tr.entries ?? []).length, 'stats:', JSON.stringify(tr.stats ?? {}).slice(0, 200));

// 4. cleanup
await post('/tfs-requirment/task-state', { taskId, action: 'cancel' });
await post('/tfs-requirment/task-delete', { taskIds: [taskId] });
console.log('cleaned up');
