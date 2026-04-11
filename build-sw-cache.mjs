import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
const path = 'dist/client/sw.js';
const content = readFileSync(path, 'utf8');
writeFileSync(path, content.replace(/cmux-v[0-9a-z]+/, `cmux-${hash}`));
console.log(`  SW cache: cmux-${hash}`);
