import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = process.argv[process.argv.indexOf('--from') + 1];
if (!process.argv.includes('--from') || !source) throw new Error('Use --from <main repository packages/copy/locales/en/data-witness.json>');
const values = JSON.parse(readFileSync(source, 'utf8'));
if (!Object.keys(values).length || Object.entries(values).some(([key,value]) => !key.startsWith('WITNESS_') || typeof value !== 'string' || !value.trim())) throw new Error('Invalid witness copy source');
writeFileSync(fileURLToPath(new URL('../packages/cli/src/witness/copy.json', import.meta.url)), `${JSON.stringify(values, null, 2)}\n`);
