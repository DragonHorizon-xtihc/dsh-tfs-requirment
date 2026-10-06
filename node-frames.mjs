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
console.log('file size:', buf.length);
console.log('frame count:', positions.length);
console.log('first 30 positions:', positions.slice(0, 30));
// also skippable frames magic 0x184d2a5?
