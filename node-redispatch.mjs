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
async function getBoard() {
  const r = await fetch(`${base}/tfs-requirment/board`, { headers: { cookie } });
  return r.json();
}

// 1. Cleanup the previous failed task
const oldTarget = '2004154@WN_HIS#manual-通用工程师-20261004170928';
let t = (await getBoard()).tasks.find(x => x.taskId === oldTarget);
if (t) {
  console.log('old task state:', t.state, t.execState);
  console.log('cancel:', JSON.stringify((await post('/tfs-requirment/task-cancel', { taskIds: [oldTarget] })).body).slice(0, 200));
  console.log('delete:', JSON.stringify((await post('/tfs-requirment/task-delete', { taskIds: [oldTarget] })).body).slice(0, 200));
}

// 2. Dispatch using the role's DEFAULT model (arkcode / doubao-seed-2.1-turbo): no model override,
//    clear mcp/skills so it's a pure connectivity probe.
console.log('\n### Dispatch with role default arkcode model');
const dr = await post('/tfs-requirment/dispatch', {
  targetWorkItem: '2004154@WN_HIS',
  collection: 'WN_HIS',
  draft: {
    roleName: '通用工程师',
    title: '审计派发探针2',
    description: '连通性探针',
    prompt: '这是连通性测试。请不要调用任何工具、不要读写任何文件，直接回复四个字：探针成功',
    frozenConfig: { mcp: [], skills: [] },
  },
});
console.log('dispatch result:', JSON.stringify(dr.body).slice(0, 400));
const newId = dr.body?.taskId;

if (newId) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const b = await getBoard();
    const tk = b.tasks.find(x => x.taskId === newId);
    if (!tk) { console.log('task gone'); break; }
    const last = tk.attempts?.[tk.attempts.length - 1];
    console.log(`[${i}] state=${tk.state} exec=${tk.execState} stop=${last?.stopReason ?? '-'} out=${(last?.output ?? '').slice(0,60)} diag=${(last?.diagnostic ?? '').slice(0,100)}`);
    if (tk.execState !== 'running' && tk.execState !== 'queued') {
      console.log('FINAL:', JSON.stringify({ state: tk.state, execState: tk.execState, output: last?.output, stopReason: last?.stopReason, diagnostic: last?.diagnostic }).slice(0, 800));
      break;
    }
  }
  // cleanup
  const tk = (await getBoard()).tasks.find(x => x.taskId === newId);
  if (tk && tk.state !== 'deleted') {
    await post('/tfs-requirment/task-cancel', { taskIds: [newId] });
    console.log('final delete:', JSON.stringify((await post('/tfs-requirment/task-delete', { taskIds: [newId] })).body).slice(0, 160));
  }
}
