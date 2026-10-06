import { zstdDecompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const buf = readFileSync(process.argv[2]);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const positions = [];
let idx = 0;
while (true) {
  const p = buf.indexOf(magic, idx);
  if (p === -1) break;
  positions.push(p);
  idx = p + 1;
}
positions.push(buf.length);

let all = '';
for (let i = 0; i < positions.length - 1; i++) {
  const frame = buf.subarray(positions[i], positions[i+1]);
  try {
    all += zstdDecompressSync(frame).toString('utf8');
  } catch (e) {
    // some markers may be inside payload; skip bad frame
  }
}
const lines = all.split('\n').filter(Boolean);
console.log('total jsonl lines:', lines.length);

let n = 0;
for (const line of lines) {
  let j; try { j = JSON.parse(line); } catch { continue; }
  const texts = Array.isArray(j.content)
    ? j.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    : (typeof j.content === 'string' ? j.content : '');
  if (j.type === 'user' && (texts.includes('探针') || texts.includes('连通性'))) {
    n++;
    console.log(`[${n}] seq=${j.seq ?? ''} :: ${texts.slice(0, 100).replace(/\s+/g,' ')}`);
  }
}
console.log('\nuser prompts in this ONE child session:', n);
