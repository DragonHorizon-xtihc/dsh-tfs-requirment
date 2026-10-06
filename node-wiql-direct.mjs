const base = 'http://tfs2018-web.winning.com.cn:8080/tfs';
const coll = 'WN_HIS';
const pat = 'xpe2lzxoi63ga2x5ejdpcggysk36vhopnele5dq7evhzz2oknijq';
const auth = 'Basic ' + Buffer.from(':' + pat).toString('base64');

async function wiql(label, query) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 70000);
  try {
    const r = await fetch(`${base}/${coll}/_apis/wit/wiql?api-version=2.0`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    const ids = (j.workItems ?? []).map(x => x.id);
    console.log(`[${label}] HTTP ${r.status} ${Date.now()-t0}ms WIQL命中=${ids.length}`);
    return ids;
  } catch (e) {
    console.log(`[${label}] FAIL ${Date.now()-t0}ms ${e.message}`);
    return [];
  } finally { clearTimeout(to); }
}

// 1. 最小 WIQL：单 Id
const ids1 = await wiql('WIQL 单Id', `SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 2004154`);
// 2. 带项目过滤（体检管理）
const ids2 = await wiql('WIQL 项目=体检管理', `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '体检管理' ORDER BY [System.ChangedDate] DESC`);
