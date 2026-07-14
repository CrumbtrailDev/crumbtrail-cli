import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { analyzeSource, type Finding } from './analyze';

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);
const SKIP_FILE = /(\.d\.ts|\.test\.|\.spec\.)/;

export interface ScanReport {
  root: string;
  filesScanned: number;
  findings: Finding[];
  countsByRule: Record<string, number>;
}

export async function scanDirectory(root: string): Promise<ScanReport> {
  const findings: Finding[] = [];
  let filesScanned = 0;

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (SCAN_EXT.has(extname(entry.name)) && !SKIP_FILE.test(entry.name)) {
        let source: string;
        try {
          source = readFileSync(full, 'utf8');
        } catch {
          // Unreadable (permissions) or invalid-UTF-8 file — skip it rather than aborting the whole scan.
          continue;
        }
        findings.push(...analyzeSource(relative(root, full), source));
        filesScanned++;
      }
    }
  };

  await walk(root);

  // Stable, platform-independent ordering — readdir order varies by filesystem, so sort
  // before returning to keep --json/report output reproducible across machines and CI.
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule),
  );

  const countsByRule: Record<string, number> = {};
  for (const finding of findings) {
    countsByRule[finding.rule] = (countsByRule[finding.rule] ?? 0) + 1;
  }
  return { root, filesScanned, findings, countsByRule };
}
