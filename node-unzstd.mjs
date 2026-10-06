import { zstdDecompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const buf = readFileSync(file);
let text = '';
try {
  text = zstdDecompressSync(buf).toString('utf8');
} catch (e) {
  // multi-frame: decompress frame by frame
  let off = 0;
  const chunks = [];
  while (off < buf.length) {
    // find next frame magic 28 b5 2f fd
    if (buf[off] !== 0x28 || buf[off+1] !== 0xb5 || buf[off+2] !== 0x2f || buf[off+3] !== 0xfd) {
      off++; continue;
    }
    // try decompress from off, growing content buffer via sync on whole slice is hard;
    // decompress frame by framing using zstd streaming not available sync -> break
    break;
  }
  // fallback: use streaming decompressor
  const { zstdDecompress } = await import('node:zlib');
  const { promisify } = await import('node:util');
  const dec = promisify(zstdDecompress);
  text = (await dec(buf)).toString('utf8');
}

const lines = text.split('\n').filter(Boolean);
console.log('total lines:', lines.length);
let n = 0;
for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  const s = JSON.stringify(j);
  // extract user messages / prompts
  if (s.includes('探针') || s.includes('连通性测试') || s.includes('派发') || j.type === 'user') {
    const txt = (j.content ?? j.text ?? j.message ?? s);
    const flat = typeof txt === 'string' ? txt : JSON.stringify(txt);
    if (flat.includes('探针') || flat.includes('连通性')) {
      n++;
      const id = j.id ?? j.sessionId ?? j.seq ?? '';
      console.log(`--- [${n}] seq=${j.seq ?? ''} type=${j.type ?? ''} ---`);
      console.log(flat.slice(0, 200).replace(/\s+/g, ' '));
    }
  }
}
console.log('\nmatching prompts found:', n);
