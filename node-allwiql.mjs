const base = 'http://tfs2018-web.winning.com.cn:8080/tfs';
const coll = 'WN_HIS';
const pat = 'xpe2lzxoi63ga2x5ejdpcggysk36vhopnele5dq7evhzz2oknijq';
const auth = 'Basic ' + Buffer.from(':' + pat).toString('base64');
const t0 = Date.now();
const ctrl = new AbortController();
const to = setTimeout(() => ctrl.abort(), 70000);
try {
  const r = await fetch(`${base}/${coll}/_apis/wit/wiql?api-version=2.0`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `SELECT [System.Id] FROM WorkItems ORDER BY [System.ChangedDate] DESC` }),
    signal: ctrl.signal,
  });
  const j = await r.json();
  console.log(`全集合 WIQL HTTP ${r.status} ${Date.now()-t0}ms 命中=${(j.workItems??[]).length}`);
} catch (e) {
  console.log(`全集合 WIQL FAIL ${Date.now()-t0}ms ${e.message}`);
} finally { clearTimeout(to); }
