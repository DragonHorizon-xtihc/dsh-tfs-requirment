import { zstdDecompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const buf = readFileSync(file);
const out = zstdDecompressSync(buf);
const text = out.toString('utf8');
console.log('decompressed bytes:', out.length);
console.log('newline count:', (text.match(/\n/g) || []).length);
console.log('=== first 1500 chars ===');
console.log(text.slice(0, 1500));
