import { readFileSync } from 'node:fs';
const b = JSON.parse(readFileSync('D:\\ClaudeCode\\deepseek-harness\\plugins\\dsh-tfs-requirment\\.tfs-requirment-data\\board.json', 'utf8'));
const reqs = b.requirements ?? {};
for (const k of Object.keys(reqs)) {
  const o = reqs[k].orchestration;
  if (o) {
    console.log('需求', k);
    console.log('  mode:', o.mode);
    console.log('  orchestratorSessionId:', o.orchestratorSessionId);
    console.log('  parentSessionId:', o.parentSessionId);
    console.log('  taskSessions:', JSON.stringify(o.taskSessions));
  }
}
console.log('任务总数:', Object.keys(b.tasks ?? {}).length);
