import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export interface BoundaryViolation {
  file: string;
  line: number;
  specifier: string;
}

// ADR-0006: specifiers the framework-free core may never import, by any form.
const FRAMEWORK = /^(h3|nitropack|nuxt|#imports)(\/.*)?$/;

/**
 * Scans every .ts file under rootDir for imports, re-exports, type imports and dynamic imports of a
 * framework module. Independent of ESLint, so the boundary still holds if the lint config drifts.
 */
export async function findCoreBoundaryViolations(rootDir: string): Promise<BoundaryViolation[]> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const violations: BoundaryViolation[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, 'utf8');
    const { importedFiles } = ts.preProcessFile(text, true, true);

    for (const { fileName, pos } of importedFiles) {
      if (!FRAMEWORK.test(fileName)) continue;
      violations.push({
        file: relative(rootDir, path).split(sep).join('/'),
        line: text.slice(0, pos).split('\n').length,
        specifier: fileName,
      });
    }
  }

  return violations;
}
