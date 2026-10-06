import { zstdDecompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const buf = readFileSync(process.argv[2]);
const targetSeq = parseInt(process.argv[3], 10);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const positions = []; let idx = 0;
while (true) { const p = buf.indexOf(magic, idx); if (p===-1) break; positions.push(p); idx=p+1; }
positions.push(buf.length);
let all='';
for (let i=0;i<positions.length-1;i++){ try{ all+=zstdDecompressSync(buf.subarray(positions[i],positions[i+1])).toString('utf8');}catch{} }
for (const line of all.split('\n').filter(Boolean)){
  let j; try{j=JSON.parse(line);}catch{continue;}
  if (j.seq===targetSeq){
    const c = j.data?.content;
    const texts = Array.isArray(c)? c.map(b=>b.text??JSON.stringify(b)).join('\n') : JSON.stringify(j.data);
    console.log(texts.slice(0, 2500));
  }
}
