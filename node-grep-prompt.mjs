import { zstdDecompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const buf = readFileSync(process.argv[2]);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const positions = []; let idx = 0;
while (true) { const p = buf.indexOf(magic, idx); if (p===-1) break; positions.push(p); idx=p+1; }
positions.push(buf.length);
let all='';
for (let i=0;i<positions.length-1;i++){ try{ all+=zstdDecompressSync(buf.subarray(positions[i],positions[i+1])).toString('utf8');}catch{} }
const lines = all.split('\n').filter(Boolean);
for (const line of lines){
  let j; try{j=JSON.parse(line);}catch{continue;}
  if (j.type==='user/message'){
    const c = j.data?.content;
    const texts = Array.isArray(c)? c.map(b=>b.text??'').join(' ') : '';
    const m = texts.match(/连通性测试第?\d*次?|runid探针\d|派发探针|请直接回复[：:]\s*\d/g);
    if (m) console.log(`seq=${j.seq} time=${j.data?.time ?? j.time} :: ${m.join(' | ')}`);
  }
}
