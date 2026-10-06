const base = 'http://127.0.0.1:3103';
const token = 'eneOX5nj8bBElZeyHsQAwk77wtS2gO0OKqXjW07Gy_M';
let res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
const r = await fetch(`${base}/tfs-requirment/dispatch`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({
    targetWorkItem: '2004154@WN_HIS', collection: 'WN_HIS',
    draft: { roleName: '通用工程师', title: '无会话探针', prompt: '连通性测试', frozenConfig: { mcp: [], skills: [] } },
  }),
});
console.log('无会话派发 HTTP', r.status);
console.log('body:', (await r.text()).slice(0, 300));
