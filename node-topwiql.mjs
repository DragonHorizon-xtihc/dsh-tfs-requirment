const base = 'http://tfs2018-web.winning.com.cn:8080/tfs';
const coll = 'WN_HIS';
const pat = 'xpe2lzxoi63ga2x5ejdpcggysk36vhopnele5dq7evhzz2oknijq';
const auth = 'Basic ' + Buffer.from(':' + pat).toString('base64');

async function wiql(label, query) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/${coll}/_apis/wit/wiql?api-version=2.0`, {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await r.text();
    let n = 'n/a'; try { n = (JSON.parse(text).workItems ?? []).length; } catch {}
    console.log(`[${label}] HTTP ${r.status} ${Date.now()-t0}ms 命中=${n}`);
    if (r.status !== 200) console.log('  ', text.slice(0, 200));
  } catch (e) { console.log(`[${label}] FAIL ${e.message}`); }
}

await wiql('SELECT TOP 20', `SELECT TOP 20 [System.Id] FROM WorkItems ORDER BY [System.ChangedDate] DESC`);
