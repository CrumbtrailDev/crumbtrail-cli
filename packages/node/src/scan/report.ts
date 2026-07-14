import type { ScanReport } from './scan';

export function formatReport(report: ScanReport): string {
  const lines: string[] = [`Scanned ${report.filesScanned} files under ${report.root}`];

  if (report.findings.length === 0) {
    lines.push('✓ No coverage gaps found.');
    return lines.join('\n');
  }

  for (const f of report.findings) {
    lines.push(`${f.file}:${f.line}:${f.column}  [${f.rule}]  ${f.message}`);
    lines.push(`    ↳ fix: ${f.fix}`);
  }

  lines.push('', `${report.findings.length} findings:`);
  for (const [rule, count] of Object.entries(report.countsByRule)) {
    lines.push(`${count}  ${rule}`);
  }
  return lines.join('\n');
}
