const base = 'http://tfs2018-web.winning.com.cn:8080/tfs';
const coll = 'WN_HIS';
const pat = 'xpe2lzxoi63ga2x5ejdpcggysk36vhopnele5dq7evhzz2oknijq';
const auth = 'Basic ' + Buffer.from(':' + pat).toString('base64');

async function timed(label, url) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { Authorization: auth }, signal: ctrl.signal });
    const text = await r.text();
    console.log(`[${label}] HTTP ${r.status} ${Date.now()-t0}ms bytes=${text.length}`);
  } catch (e) {
    console.log(`[${label}] FAIL ${Date.now()-t0}ms ${e.message}`);
  } finally { clearTimeout(to); }
}

// 1. 单个工作项（轻量）
await timed('单个工作项 2004154', `${base}/${coll}/_apis/wit/workitems/2004154?$fields=System.Id,System.Title`);
