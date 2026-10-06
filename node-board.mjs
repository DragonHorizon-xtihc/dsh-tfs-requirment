import { readFileSync, writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

async function get(path) {
  const r = await fetch(`${base}${path}`, { headers: { cookie } });
  return r.json();
}

const board = await get('/tfs-requirment/board');
writeFileSync('D:/ClaudeCode/deepseek-harness/plugins/dsh-tfs-requirment/audit-board-snapshot.json', JSON.stringify(board, null, 2));
console.log('version', board.version, 'updatedAt', board.updatedAt);
const reqs = Object.values(board.requirements || {});
const tasks = Object.values(board.tasks || {});
console.log('requirements:', reqs.length, 'tasks:', tasks.length);
for (const r of reqs) {
  console.log(`REQ [${r.id}] state=${r.state} exec=${r.execState ?? ''} title=${(r.title||'').slice(0,40)}`);
}
const stateCount = {};
for (const t of tasks) {
  stateCount[t.state] = (stateCount[t.state] || 0) + 1;
}
console.log('task states:', JSON.stringify(stateCount));
// print a few tasks
for (const t of tasks.slice(0, 12)) {
  console.log(`TASK [${t.taskId}] state=${t.state} role=${t.roleAgent} rev=${t.revision} runId=${t.runId ?? '-'} title=${(t.title||'').slice(0,30)}`);
}
