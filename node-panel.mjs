import { readFileSync, writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

const r = await fetch(`${base}/tfs-requirment/panel-data`, { headers: { cookie } });
const j = await r.json();
writeFileSync('D:/ClaudeCode/deepseek-harness/plugins/dsh-tfs-requirment/audit-panel-snapshot.json', JSON.stringify(j, null, 2));
console.log('top-level keys:', Object.keys(j).join(', '));
console.log('\n===== orchestration =====');
console.log(JSON.stringify(j.orchestration, null, 2));
console.log('\n===== catalog (capabilities) summary =====');
for (const k of Object.keys(j.catalog || {})) {
  const v = j.catalog[k];
  if (Array.isArray(v)) console.log(`  ${k}: ${v.length} items`, v.length <= 8 ? JSON.stringify(v).slice(0,200) : '');
  else console.log(`  ${k}:`, JSON.stringify(v).slice(0,200));
}
console.log('\n===== health =====');
console.log(JSON.stringify(j.health, null, 2)?.slice(0, 600));
