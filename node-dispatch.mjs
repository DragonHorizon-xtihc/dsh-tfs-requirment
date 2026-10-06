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
  try { j = await r.json(); } catch { j = await r.text(); }
  return { status: r.status, body: j };
}
async function getBoard() {
  const r = await fetch(`${base}/tfs-requirment/board`, { headers: { cookie } });
  return r.json();
}

const createdTaskIds = [];
try {
  console.log('### Real dispatch: minimal no-tool task');
  const dispatchBody = {
    targetWorkItem: '2004154@WN_HIS',
    collection: 'WN_HIS',
    draft: {
      roleName: '通用工程师',
      title: '审计派发探针',
      description: '端到端探针，请勿修改任何文件',
      prompt: '这是一个连通性测试。请不要调用任何工具、不要读取或修改任何文件，直接用一句话回复：探针成功',
      frozenConfig: {
        mcp: [],
        skills: [],
        model: 'deepseek-v4-flash',
        maxTokens: 80,
      },
      maxTokens: 80,
    },
  };
  const t0 = Date.now();
  const dr = await post('/tfs-requirment/dispatch', dispatchBody);
  console.log(`dispatch returned HTTP ${dr.status} in ${Date.now()-t0}ms:`, JSON.stringify(dr.body).slice(0, 500));

  let taskId = dr.body?.task?.taskId || dr.body?.taskId;
  if (taskId) createdTaskIds.push(taskId);

  // Poll board for the task outcome
  if (taskId) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const b = await getBoard();
      const t = b.tasks[taskId];
      if (!t) { console.log('task not found on board'); break; }
      const last = t.attempts?.[t.attempts.length - 1];
      console.log(`[${i}] state=${t.state} exec=${t.execState} runId=${last?.runId ?? '-'} stop=${last?.stopReason ?? '-'}`);
      if (t.state === 'completed' || t.state === 'deleted' || (t.execState !== 'running' && t.execState !== 'queued' && t.state !== 'in_progress')) {
        console.log('FINAL task:', JSON.stringify({
          state: t.state, execState: t.execState,
          output: last?.output, diagnostic: last?.diagnostic, stopReason: last?.stopReason,
          runId: last?.runId,
        }, null, 2).slice(0, 1200));
        break;
      }
    }
  }
} finally {
  // cleanup: delete any created probe tasks
  for (const id of createdTaskIds) {
    const r = await post('/tfs-requirment/task-delete', { taskIds: [id] });
    console.log(`cleanup ${id}:`, JSON.stringify(r.body).slice(0, 160));
  }
}
