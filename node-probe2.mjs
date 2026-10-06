import { readFileSync } from 'node:fs';

const dataDir = 'D:/ClaudeCode/deepseek-harness/plugins/dsh-tfs-requirment/.tfs-requirment-data';
const raw = JSON.parse(readFileSync(`${dataDir}/profiles.json`, 'utf8'));
const cfg = Array.isArray(raw) ? raw[0] : raw;
const pat = cfg.pat;
const base = cfg.url.replace(/\/+$/, '');
const coll = cfg.collection;
const auth = 'Basic ' + Buffer.from(':' + pat).toString('base64');
const ui = JSON.parse(readFileSync(`${dataDir}/ui-state.json`, 'utf8'))[coll].poolFilters;

const esc = v => v.replace(/'/g, "''");
const proj = ui.projects.map(p => `[System.TeamProject]='${esc(p)}'`).join(' OR ');
const typ = ui.types.map(t => `[System.WorkItemType]='${esc(t)}'`).join(' OR ');
const sta = ui.states.map(s => `[System.State]='${esc(s)}'`).join(' OR ');
const ass = ui.assignedTo.map(a => `[System.AssignedTo] CONTAINS '${esc(a)}'`).join(' OR ');
const query = `SELECT [System.Id] FROM WorkItems WHERE (${proj}) AND (${typ}) AND (${sta}) AND (${ass}) ORDER BY [System.ChangedDate] DESC`;
console.log(query);

const TIMEOUT = 20000;
function withTimeout(ms, p) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('ABORTED after ' + ms + 'ms')), ms)),
  ]);
}

// Step 1: WIQL
const t1 = Date.now();
try {
  const r = await withTimeout(TIMEOUT, fetch(`${base}/${coll}/_apis/wit/wiql?api-version=4.1`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  }));
  const j = await r.json();
  const ids = (j.workItems ?? []).map(w => w.id);
  console.log(`WIQL: ${r.status} in ${Date.now()-t1}ms -> ${ids.length} ids`);

  // Step 2: getWorkItems (batch 200), like adapter
  const fields = ['System.Id','System.Title','System.WorkItemType','System.State','System.AssignedTo','System.ChangedDate','System.AreaPath','System.IterationPath','System.Tags','System.TeamProject','Microsoft.VSTS.Common.Priority','System.Description','Winning.Demand.Analysis','Winning.Data.Design','Winning.Demand.Config'];
  const t2 = Date.now();
  const all = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const q = new URLSearchParams();
    batch.forEach(id => q.append('ids', id));
    fields.forEach(f => q.append('fields', f));
    const rr = await withTimeout(TIMEOUT, fetch(`${base}/${coll}/_apis/wit/workitems?${q}`, { headers: { Authorization: auth } }));
    const jj = await rr.json();
    all.push(...(jj.value ?? []));
  }
  console.log(`getWorkItems: in ${Date.now()-t2}ms -> ${all.length} items`);
} catch (e) {
  console.log(`STEP FAILED in ${Date.now()-t1}ms :: ${e.message}`);
}
