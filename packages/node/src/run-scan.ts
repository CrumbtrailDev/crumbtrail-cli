import { resolve } from 'node:path';
import { scanDirectory } from './scan/scan';
import { formatReport } from './scan/report';

export async function runScan(rest: string[]): Promise<number> {
  const json = rest.includes('--json');
  const strict = rest.includes('--strict');
  const target = rest.find((arg) => !arg.startsWith('--')) ?? '.';
  const root = resolve(target);

  const report = await scanDirectory(root);

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(report) + '\n');
  }

  return strict && report.findings.length > 0 ? 1 : 0;
}
