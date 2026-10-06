import { createZstdDecompress } from 'node:zlib';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const buf = readFileSync(file);

const dec = createZstdDecompress();
const chunks = [];
dec.on('data', c => chunks.push(c));
const done = new Promise((res, rej) => { dec.on('end', res); dec.on('error', rej); });
dec.end(buf);
await done;
const text = Buffer.concat(chunks).toString('utf8');
const lines = text.split('\n').filter(Boolean);
console.log('total frames lines:', lines.length);

let promptCount = 0;
for (const line of lines) {
  let j; try { j = JSON.parse(line); } catch { continue; }
  const s = JSON.stringify(j);
  if (s.includes('探针') || s.includes('连通性测试')) {
    const flat = typeof j.content === 'string' ? j.content : JSON.stringify(j.content ?? j.text ?? '');
    if (flat.includes('探针') || flat.includes('连通性')) {
      promptCount++;
      // extract text blocks
      const texts = Array.isArray(j.content)
        ? j.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
        : flat;
      console.log(`[${promptCount}] type=${j.type} seq=${j.seq ?? ''} :: ${texts.slice(0, 90).replace(/\s+/g, ' ')}`);
    }
  }
}
console.log('\nprompts in this one child session:', promptCount);
