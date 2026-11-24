import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import ts from 'typescript';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = projectRoot;
const outRoot = await mkdtemp(path.join(os.tmpdir(), 'nativetype-ts-tests-'));
const importPattern = /\bfrom\s+['"](\.[^'"]+|@nativetype\/contracts)['"]/g;
const dynamicImportPattern = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const emitted = new Map();

function resolveImport(fromFile, spec) {
  if (spec === '@nativetype/contracts') return path.join(workspaceRoot, 'packages/contracts/src/index.ts');
  const base = path.resolve(path.dirname(fromFile), spec);
  return base.endsWith('.ts') ? base : `${base}.ts`;
}

function outputPath(tsPath) {
  return path.join(outRoot, path.relative(workspaceRoot, tsPath).replace(/\.ts$/, '.js'));
}

function rewriteSpecifier(fromFile, spec) {
  let relative = path.relative(path.dirname(outputPath(fromFile)), outputPath(resolveImport(fromFile, spec))).replaceAll('\\', '/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

async function emit(tsPath) {
  if (emitted.has(tsPath)) return emitted.get(tsPath);
  const pending = (async () => {
    const source = await readFile(tsPath, 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      fileName: tsPath,
    }).outputText.replaceAll('import.meta.env', '(globalThis.__nativetypeTestEnv ?? { MODE: "test" })');
    const specs = [...js.matchAll(importPattern), ...js.matchAll(dynamicImportPattern)].map(match => match[1]);
    for (const spec of specs) await emit(resolveImport(tsPath, spec));
    importPattern.lastIndex = 0;
    dynamicImportPattern.lastIndex = 0;
    const rewritten = js
      .replace(importPattern, (_, spec) => `from '${rewriteSpecifier(tsPath, spec)}'`)
      .replace(dynamicImportPattern, (_, spec) => `import('${rewriteSpecifier(tsPath, spec)}')`);
    const out = outputPath(tsPath);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, rewritten);
  })();
  emitted.set(tsPath, pending);
  return pending;
}

export async function loadTs(relativePath) {
  const entry = path.join(projectRoot, relativePath);
  await emit(entry);
  return import(pathToFileURL(outputPath(entry)).href);
}
