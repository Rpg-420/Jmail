import { registerHooks } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// The worker is TypeScript with bundler-style extensionless imports, and
// Cloudflare's workerd runs it through its own transpiler. Node cannot parse
// that directly, so these hooks do the two jobs wrangler normally does:
// resolve './types' to './types.ts', and transpile TypeScript to ESM.
// This keeps the test suite dependency-free — no separate build, no vitest.
const require = createRequire(import.meta.url);
const ts = require('typescript');

function firstExisting(candidates) {
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

let cache = new Map();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('.') || /\.(ts|mjs|cjs|js|json)$/.test(specifier)) {
      return nextResolve(specifier, context);
    }
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    const hit = firstExisting([`${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`]);
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    const cached = cache.get(url);
    if (cached) return { format: 'module', source: cached, shortCircuit: true };

    const source = readFileSync(fileURLToPath(url), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: fileURLToPath(url),
    }).outputText;
    cache.set(url, compiled);
    return { format: 'module', source: compiled, shortCircuit: true };
  },
});
