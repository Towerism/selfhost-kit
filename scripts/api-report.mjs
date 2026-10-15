// The API-surface report (ADR-0005): every export of the package's entry points and the reusable workflows'
// interface, written to api/*.api.md and committed, so a changed export shows up in the PR diff. CI runs
// `--check`, which fails when the committed reports don't match the build.
//
// Built on the repo's own TypeScript: api-extractor 7.59 (TS 5.9) crashes on this package's .d.ts files
// ("Unable to follow symbol for Buffer").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from 'yaml';

/** Where each report comes from. The order is the order of `buildReports`. */
export const REPORTS = [
  { file: 'core.api.md', kind: 'entry', source: 'dist/core/index.d.ts', title: '@towerism/selfhost-kit' },
  {
    file: 'nitro.api.md',
    kind: 'entry',
    source: 'dist/nitro/index.d.ts',
    title: '@towerism/selfhost-kit/nitro',
  },
  {
    file: 'testing.api.md',
    kind: 'entry',
    source: 'dist/testing/index.d.ts',
    title: '@towerism/selfhost-kit/testing',
  },
  {
    file: 'release-config.api.md',
    kind: 'entry',
    source: 'release-config/index.d.ts',
    title: '@towerism/selfhost-kit/release-config',
  },
  { file: 'workflows.api.md', kind: 'workflows', source: '.github/workflows', title: 'Reusable workflows' },
];

const WORKFLOWS = ['app-image.yml', 'app-release.yml'];
const FIX = 'Run: pnpm build && pnpm api:report, then commit api/';

class ApiReportError extends Error {}

const byName = (/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b, 'en');
const posix = (/** @type {string} */ path) => path.split(sep).join('/');
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/**
 * One declaration as a single line: comments removed, whitespace collapsed, and the `export`, `default`
 * and `declare` modifiers dropped (how a declaration is exported isn't part of what it is).
 * @param {ts.Declaration} node
 */
function declarationText(node) {
  const source = node.getSourceFile();
  const printed = ts.isVariableDeclaration(node)
    ? `const ${printer.printNode(ts.EmitHint.Unspecified, node, source)};`
    : printer.printNode(ts.EmitHint.Unspecified, node, source);
  return printed
    .replace(/\s+/g, ' ')
    .replace(/^(export )?(default )?(declare )?/, '')
    .trim();
}

/** @param {ts.Declaration} node */
function kindOf(node) {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  return 'const';
}

/** @param {string} name @param {string} kind @param {readonly ts.Declaration[]} declarations @param {string} level */
function entry(name, kind, declarations, level) {
  const body = declarations.map(declarationText).join('\n');
  return `${level} \`${name}\` (${kind})\n\n\`\`\`ts\n${body}\n\`\`\`\n`;
}

/**
 * The report for one entry point's `.d.ts`.
 * @param {{ root: string; dts: string; title: string }} opts `dts` is relative to `root`.
 * @returns {string}
 */
export function entryReport({ root, dts, title }) {
  const path = join(root, dts);
  if (!existsSync(path)) throw new ApiReportError(`${dts} not found`);
  const program = ts.createProgram([path], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });
  const source = /** @type {ts.SourceFile} */ (program.getSourceFile(path));
  const [syntax] = program.getSyntacticDiagnostics(source);
  if (syntax) {
    throw new ApiReportError(
      `${dts} has a syntax error: ${ts.flattenDiagnosticMessageText(syntax.messageText, '\n')}`,
    );
  }
  const checker = program.getTypeChecker();
  const resolve = (/** @type {ts.Symbol} */ symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  // Kit-declared means: not in a dependency (TypeScript's own lib files live in node_modules too). A core
  // type that /nitro reaches counts, so a change to it shows in /nitro's report as well.
  const isKit = (/** @type {ts.Declaration} */ node) =>
    !node.getSourceFile().fileName.includes('/node_modules/');

  const moduleSymbol = /** @type {ts.Symbol} */ (checker.getSymbolAtLocation(source));
  const exported = checker.getExportsOfModule(moduleSymbol).map((symbol) => {
    const declarations = resolve(symbol).declarations;
    if (!declarations?.length) {
      throw new ApiReportError(`no declaration found for export "${symbol.name}" in ${dts}`);
    }
    return { name: symbol.name, symbol: resolve(symbol), declarations };
  });
  exported.sort((a, b) => byName(a.name, b.name));

  // Kit types reached from an export's declaration (through type references and heritage clauses) that
  // this entry point doesn't export by name: a change to them is still a change to the API.
  const exportedSymbols = new Set(exported.map((e) => e.symbol));
  /** @type {Map<ts.Symbol, readonly ts.Declaration[]>} */
  const referenced = new Map();
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const at = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
      const found = checker.getSymbolAtLocation(at);
      const symbol = found && resolve(found);
      const declarations = symbol?.declarations?.filter(isKit) ?? [];
      if (
        symbol &&
        declarations.length &&
        !(symbol.flags & ts.SymbolFlags.TypeParameter) &&
        !exportedSymbols.has(symbol) &&
        !referenced.has(symbol)
      ) {
        referenced.set(symbol, declarations);
        declarations.forEach(visit);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const e of exported) e.declarations.forEach(visit);

  const parts = [
    `<!-- Generated by pnpm api:report from ${posix(dts)}. Do not edit. -->\n`,
    `# ${title}\n`,
    ...exported.map((e) =>
      entry(
        e.name,
        e.name === 'default' ? 'default' : kindOf(/** @type {ts.Declaration} */ (e.declarations[0])),
        e.declarations,
        '##',
      ),
    ),
  ];
  if (referenced.size) {
    parts.push('## Referenced, not exported\n');
    const sorted = [...referenced].sort(([a], [b]) => byName(a.name, b.name));
    for (const [symbol, declarations] of sorted) {
      parts.push(
        entry(symbol.name, kindOf(/** @type {ts.Declaration} */ (declarations[0])), declarations, '###'),
      );
    }
  }
  return parts.join('\n');
}

/** @param {unknown} value */
const cell = (value) => (value === undefined ? '—' : `\`${JSON.stringify(value)}\``);

/**
 * The reusable workflows' interface: job ids and permissions, inputs and outputs. Descriptions are left
 * out, because rewording one isn't an API change.
 * @param {readonly { name: string; text: string }[]} workflows
 * @returns {string}
 */
export function workflowsReport(workflows) {
  const names = workflows.map((w) => w.name).join(' and ');
  const parts = [
    `<!-- Generated by pnpm api:report from .github/workflows/${names}. Do not edit. -->\n`,
    '# Reusable workflows\n',
  ];
  for (const { name, text } of workflows) {
    /** @type {{ on?: { workflow_call?: { inputs?: Record<string, { type: string; required?: boolean; default?: unknown }>; outputs?: Record<string, unknown> } }; jobs?: Record<string, { permissions?: Record<string, string> }> }} */
    const doc = parse(text);
    const call = doc.on?.workflow_call;
    if (!call) throw new ApiReportError(`${name} has no on.workflow_call`);
    const jobs = Object.entries(doc.jobs ?? {}).sort(([a], [b]) => byName(a, b));
    const inputs = Object.entries(call.inputs ?? {}).sort(([a], [b]) => byName(a, b));
    const outputs = Object.keys(call.outputs ?? {}).sort(byName);

    parts.push(`## ${name}\n`, '### Jobs\n');
    const jobRows = jobs.map(([id, job]) => {
      const permissions = Object.entries(job.permissions ?? {})
        .sort(([a], [b]) => byName(a, b))
        .map(([scope, level]) => `${scope}: ${level}`)
        .join(', ');
      return `| \`${id}\` | ${permissions || 'inherited'} |`;
    });
    parts.push(['| Job | Permissions |', '| --- | ----------- |', ...jobRows].join('\n') + '\n');
    parts.push('### Inputs\n');
    const inputRows = inputs.map(
      ([input, spec]) =>
        `| \`${input}\` | ${spec.type} | ${spec.required ? 'yes' : 'no'} | ${cell(spec.default)} |`,
    );
    parts.push(
      ['| Input | Type | Required | Default |', '| ----- | ---- | -------- | ------- |', ...inputRows].join(
        '\n',
      ) + '\n',
    );
    if (outputs.length) {
      parts.push('### Outputs\n');
      parts.push(['| Output |', '| ------ |', ...outputs.map((o) => `| \`${o}\` |`)].join('\n') + '\n');
    } else {
      parts.push('Outputs: none\n');
    }
  }
  return parts.join('\n');
}

/**
 * Every report, in memory. Throws (and so writes nothing) if any one of them can't be built.
 * @param {string} root the kit checkout
 * @returns {{ file: string; content: string }[]}
 */
export function buildReports(root) {
  if (!existsSync(join(root, 'dist'))) throw new ApiReportError('dist/ not found: run pnpm build first');
  return REPORTS.map((report) => ({
    file: report.file,
    content:
      report.kind === 'entry'
        ? entryReport({ root, dts: report.source, title: report.title })
        : workflowsReport(
            WORKFLOWS.map((name) => ({ name, text: readFileSync(join(root, report.source, name), 'utf8') })),
          ),
  }));
}

/**
 * `api-report.mjs [--check] [--root <dir>]`: writes api/*.api.md, or with `--check` compares them.
 * @param {readonly string[]} args
 * @param {{ root: string; stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } }} io
 * @returns {0 | 1}
 */
export function main(args, { root, stdout, stderr }) {
  let reports;
  try {
    reports = buildReports(root);
  } catch (error) {
    if (!(error instanceof ApiReportError)) throw error;
    stderr.write(`${error.message}\n`);
    return 1;
  }
  const dir = join(root, 'api');
  if (args.includes('--check')) {
    const stale = reports.filter(({ file, content }) => {
      const path = join(dir, file);
      return !existsSync(path) || readFileSync(path, 'utf8') !== content;
    });
    for (const { file } of stale) stderr.write(`api/${file} is out of date\n`);
    if (stale.length) {
      stderr.write(`${FIX}\n`);
      return 1;
    }
    stdout.write('api/ is current\n');
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  for (const { file, content } of reports) writeFileSync(join(dir, file), content);
  stdout.write(`wrote ${reports.length} reports to api/\n`);
  return 0;
}

// Covered by the test that runs this file as a script; coverage only sees in-process code.
/* v8 ignore next 6 */
if (argv[1] === fileURLToPath(import.meta.url)) {
  const args = argv.slice(2);
  const at = args.indexOf('--root');
  const root =
    at === -1 ? fileURLToPath(new URL('..', import.meta.url)) : /** @type {string} */ (args[at + 1]);
  process.exitCode = main(args, { root, stdout: process.stdout, stderr: process.stderr });
}
