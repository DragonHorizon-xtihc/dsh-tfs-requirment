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
let n=0;
for (const line of lines){
  let j; try{j=JSON.parse(line);}catch{continue;}
  if (j.type==='user/message'){
    n++;
    const c = j.content ?? j.message ?? j;
    const texts = Array.isArray(c)? c.map(b=>b && b.type==='text'?b.text:`[${b&&b.type}]`).join(' ') : JSON.stringify(c);
    console.log(`[${n}] seq=${j.seq} :: ${texts.slice(0,110).replace(/\s+/g,' ')}`);
  }
}
