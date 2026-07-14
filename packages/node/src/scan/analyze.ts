import * as ts from 'typescript';

export type Rule = 'missing-component-id' | 'swallowed-error';

export interface Finding {
  file: string;
  line: number; // 1-based
  column: number; // 1-based
  rule: Rule;
  message: string;
  /** Concrete, actionable suggested fix surfaced in both the human report and --json output. */
  fix: string;
}

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);
const HANDLER_ATTRS = new Set(['onClick', 'onChange', 'onSubmit', 'onInput', 'onKeyDown']);
const ID_ATTRS = new Set(['id', 'data-bug-id', 'data-testid', 'data-test']);
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function kebab(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Suggests a stable, human-meaningful id for an interactive element: prefer a kebab-cased slug
 * of the element's visible text, falling back to the tag name when there is no usable text.
 */
function suggestBugId(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, tag: string): string {
  let text = '';
  const parent = node.parent;
  if (ts.isJsxOpeningElement(node) && parent && ts.isJsxElement(parent)) {
    for (const child of parent.children) {
      if (ts.isJsxText(child)) text += ` ${child.text}`;
    }
  }
  return kebab(text) || kebab(tag) || 'element';
}

export function analyzeSource(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const findings: Finding[] = [];

  const positionOf = (node: ts.Node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: line + 1, column: character + 1 };
  };

  const attrName = (attr: ts.JsxAttributeLike): string | undefined => {
    if (!ts.isJsxAttribute(attr)) return undefined; // skip {...spread}
    if (ts.isIdentifier(attr.name)) return attr.name.text;
    if (ts.isJsxNamespacedName(attr.name)) return `${attr.name.namespace.text}:${attr.name.name.text}`;
    return undefined;
  };

  const checkJsx = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => {
    const tag = node.tagName.getText(sf);
    const names = new Set<string>();
    let hasHandler = false;
    for (const attr of node.attributes.properties) {
      const name = attrName(attr);
      if (!name) continue;
      names.add(name);
      if (HANDLER_ATTRS.has(name)) hasHandler = true;
    }
    // Exact match (no case-folding): JSX DOM intrinsics are lowercase. A capitalized
    // <Button>/<Input> is a user component whose internal id we can't see — folding case
    // would flag every component-library element as a false positive. Handlers still flag
    // any tag (including components), since an attached handler implies addressable intent.
    const isInteractive = INTERACTIVE_TAGS.has(tag) || hasHandler;
    if (!isInteractive) return;
    if ([...names].some((name) => ID_ATTRS.has(name))) return;
    const { line, column } = positionOf(node);
    findings.push({
      file, line, column, rule: 'missing-component-id',
      message: `<${tag}> is interactive but has no stable id (add data-bug-id / data-testid / id)`,
      fix: `add data-bug-id="${suggestBugId(node, tag)}"`,
    });
  };

  const logsOrRethrows = (block: ts.Block): boolean => {
    let found = false;
    // Known V1 limitation: this descends into nested function bodies, so a logger that is
    // defined-but-never-called inside the catch (e.g. `const f = () => console.error(e)`)
    // counts as "logs" and suppresses the finding. Acceptable for V1; revisit with scope tracking.
    const walk = (n: ts.Node) => {
      if (found) return;
      if (ts.isThrowStatement(n)) { found = true; return; }
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        LOG_METHODS.has(n.expression.name.text)
      ) { found = true; return; }
      ts.forEachChild(n, walk);
    };
    walk(block);
    return found;
  };

  const checkCatch = (node: ts.CatchClause) => {
    if (logsOrRethrows(node.block)) return;
    const { line, column } = positionOf(node);
    const reason = node.block.statements.length === 0 ? 'is empty' : 'neither logs nor rethrows';
    findings.push({
      file, line, column, rule: 'swallowed-error',
      message: `catch block ${reason} — the failure cause will be invisible to the AI`,
      fix: 'log the error (e.g. console.error(err)) or rethrow it inside the catch block',
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) checkJsx(node);
    if (ts.isCatchClause(node)) checkCatch(node);
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return findings;
}
