import { readFileSync } from 'node:fs';

const base = 'http://127.0.0.1:3101';
const token = 'MYX-GI-A8yfFcZTDIxICshj9J3R25C1H466qRgpU3QY';

// 1) establish auth cookie via token
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const setCookie = res.headers.get('set-cookie');
const cookie = setCookie ? setCookie.split(';')[0] : '';
console.log('cookie:', cookie ? cookie.split('=')[0] + '=<set>' : 'none');

async function post(path, filter) {
  const t = Date.now();
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(filter),
  });
  const text = await r.text();
  console.log(`${path} -> ${r.status} in ${Date.now()-t}ms len=${text.length}`);
  let j;
  try { j = JSON.parse(text); } catch { console.log(text.slice(0,200)); return; }
  if (j.ok) {
    console.log(`  total=${j.total}, items=${j.items.length}`);
    for (const it of j.items) {
      console.log(`   - [${it.id}] ${it.type} | ${it.state} | ${it.title} | ${it.assignedTo}`);
    }
  } else {
    console.log(`  reason=${j.reason}`);
  }
}

console.log('===== A) realistic filter (project+type+state+assignee) =====');
await post('/tfs-requirment/requirements', {
  collection: 'WN_HIS',
  projects: ['体检管理'],
  types: ['Bug','需求','任务'],
  states: ['已分析','活动','已建议'],
  assignedTo: ['zhangbo3'],
  top: 20, skip: 0,
});

console.log('===== B) empty filter skipped to save time =====');
