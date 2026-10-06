import { readFileSync } from 'node:fs';
const paths = [
  'D:\\ClaudeCode\\deepseek-harness\\plugins\\dsh-tfs-requirment\\.tfs-requirment-data\\query-options.json',
];
for (const p of paths) {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    console.log('file:', p);
    // projects / types / states
    const keys = Object.keys(j);
    console.log('top keys:', keys);
    for (const k of keys) {
      const v = j[k];
      if (v && typeof v === 'object') {
        console.log(`  ${k}:`, JSON.stringify(v).slice(0, 400));
      }
    }
  } catch (e) {
    console.log('skip', p, e.message);
  }
}
