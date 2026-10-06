const base = 'http://tfs2018-web.winning.com.cn:8080/tfs';
const coll = 'WN_HIS';
const pat = 'xpe2lzxoi63ga2x5ejdpcggysk36vhopnele5dq7evhzz2oknijq';
const auth = 'Basic ' + Buffer.from(':' + pat).toString('base64');
const FIELDS = ['System.Id','System.Title','System.WorkItemType','System.State','System.AssignedTo','System.ChangedDate','System.TeamProject'].join(',');

// 1. WIQL 拿全部 id
const t0 = Date.now();
let r = await fetch(`${base}/${coll}/_apis/wit/wiql?api-version=2.0`, {
  method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '体检管理' ORDER BY [System.ChangedDate] DESC` }),
});
const all = (await r.json()).workItems.map(x => x.id);
const wiqlMs = Date.now() - t0;
console.log(`WIQL: ${wiqlMs}ms 命中=${all.length}`);

// 2. 只取前 20 个 id（模拟修复后的分页）
const t1 = Date.now();
const topIds = all.slice(0, 20);
const url = `${base}/${coll}/_apis/wit/workitems?ids=${topIds.join(',')}&fields=${encodeURIComponent(FIELDS)}&api-version=2.0`;
const r2 = await fetch(url, { headers: { Authorization: auth } });
const j2 = await r2.json();
const fetchMs = Date.now() - t1;
console.log(`只取前20: HTTP ${r2.status} ${fetchMs}ms 取到=${(j2.count ?? j2.value?.length)}`);
console.log(`修复路径总耗时: ${wiqlMs + fetchMs}ms`);
console.log('前3:', j2.value?.slice(0,3).map(x=>`${x.id} ${x.fields['System.Title']?.slice(0,20)}`).join(' | '));
