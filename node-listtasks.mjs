import { readFileSync } from 'node:fs';
const b = JSON.parse(readFileSync('D:\\ClaudeCode\\deepseek-harness\\plugins\\dsh-tfs-requirment\\.tfs-requirment-data\\board.json', 'utf8'));
const tasks = b.tasks ?? {};
for (const k of Object.keys(tasks)) {
  const t = tasks[k];
  console.log(`  ${k} | state=${t.state} exec=${t.execState} title=${t.title}`);
}
