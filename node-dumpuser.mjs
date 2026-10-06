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

// show distribution of types
const types = {};
for (const line of lines){ let j; try{j=JSON.parse(line);}catch{continue;} types[j.type]=(types[j.type]||0)+1; }
console.log('types:', JSON.stringify(types));

// dump first 3 user lines fully
let n=0;
for (const line of lines){
  let j; try{j=JSON.parse(line);}catch{continue;}
  if (j.type==='user' && n<3){
    n++;
    const texts = Array.isArray(j.content)? j.content.map(b=>b.type==='text'?b.text:`[${b.type}]`).join(' | ') : JSON.stringify(j.content);
    console.log(`\n=== USER #${n} seq=${j.seq} ===`);
    console.log(texts.slice(0, 600));
  }
}
