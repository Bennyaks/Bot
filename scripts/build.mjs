/**
 * Production build that avoids the hung esbuild native service.
 * Transpiles TSX with TypeScript, bundles app code with Rollup
 * (react stack loaded from esm.sh via import map).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { rollup } from 'rollup';
import { compile } from 'tailwindcss';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist');
const assetsDir = path.join(outDir, 'assets');

const EXTERNALS = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-router-dom',
  'framer-motion',
  'lucide-react',
]);

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function extractClasses(sourceFiles) {
  const classes = new Set();
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/className=\{`([\s\S]*?)`\}/g)) {
      const cleaned = m[1].replace(/\$\{[^}]+\}/g, ' ');
      for (const token of cleaned.split(/[\s\n]+/)) {
        const t = token.trim();
        if (t && /^[a-zA-Z0-9_:\-/\[\]%.]+$/.test(t)) classes.add(t);
      }
    }
    for (const m of text.matchAll(/className="([^"]+)"/g)) {
      for (const token of m[1].split(/\s+/)) if (token) classes.add(token);
    }
    for (const m of text.matchAll(/className='([^']+)'/g)) {
      for (const token of m[1].split(/\s+/)) if (token) classes.add(token);
    }
    // String literals that look like utility stacks in cn-less code
    for (const m of text.matchAll(/`([^`]{3,200})`/g)) {
      const cleaned = m[1].replace(/\$\{[^}]+\}/g, ' ');
      if (!/^[a-z0-9\s\-:/%.\[\]!]+$/i.test(cleaned.trim())) continue;
      if (!cleaned.includes('-') && !cleaned.includes(':')) continue;
      for (const token of cleaned.split(/[\s\n]+/)) {
        const t = token.trim();
        if (t && /^[a-zA-Z][a-zA-Z0-9_:\-/\[\]%.!]+$/.test(t) && t.includes('-')) {
          classes.add(t);
        }
      }
    }
  }
  return [...classes];
}

async function buildCss(classList) {
  const cssPath = path.join(root, 'src/index.css');
  const input = fs.readFileSync(cssPath, 'utf8');

  async function loadStylesheet(id, base) {
    let resolved;
    if (id.startsWith('.')) {
      resolved = path.resolve(base, id);
    } else if (id === 'tailwindcss') {
      resolved = path.join(root, 'node_modules/tailwindcss/index.css');
    } else if (id.startsWith('tailwindcss/')) {
      resolved = path.join(root, 'node_modules', id);
    } else {
      try {
        resolved = require.resolve(id + '/index.css', { paths: [base, root] });
      } catch {
        resolved = require.resolve(id, { paths: [base, root] });
      }
    }
    if (!fs.existsSync(resolved) || !resolved.endsWith('.css')) {
      // Prefer .css sibling
      const cssTry = resolved.replace(/\.js$/, '.css');
      if (fs.existsSync(path.join(path.dirname(resolved), 'index.css'))) {
        resolved = path.join(path.dirname(resolved), 'index.css');
      } else if (fs.existsSync(cssTry)) {
        resolved = cssTry;
      }
    }
    return {
      path: resolved,
      base: path.dirname(resolved),
      content: fs.readFileSync(resolved, 'utf8'),
    };
  }

  const compiler = await compile(input, {
    base: path.dirname(cssPath),
    from: cssPath,
    loadStylesheet,
  });

  return String(compiler.build(classList));
}

function transpileProject() {
  const srcDir = path.join(root, 'src');
  const tmpDir = path.join(root, '.build-tmp');
  rimraf(tmpDir);
  ensureDir(tmpDir);

  const files = walk(srcDir).filter((f) => /\.(tsx?|jsx?)$/.test(f));
  for (const file of files) {
    const rel = path.relative(srcDir, file);
    const text = fs.readFileSync(file, 'utf8');
    const outRel = rel.replace(/\.tsx?$/, '.js');
    const result = ts.transpileModule(text, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: file,
    });
    const outPath = path.join(tmpDir, outRel);
    ensureDir(path.dirname(outPath));
    const code = result.outputText
      .replace(/import\s+['"][^'"]+\.css['"];?\s*/g, '')
      .replace(/from\s+['"](\.[^'"]+)\.tsx?['"]/g, "from '$1.js'")
      .replace(/from\s+['"](\.[^'"]+)['"]/g, (full, p) => {
        // ensure relative imports keep extension for rollup resolution
        if (p.endsWith('.js')) return full;
        return `from '${p}.js'`;
      });
    fs.writeFileSync(outPath, code);
  }
  return tmpDir;
}

async function bundleJs(tmpDir) {
  const entry = path.join(tmpDir, 'main.js');

  const bundle = await rollup({
    input: entry,
    external: (id) => EXTERNALS.has(id) || id.startsWith('react/') || id.startsWith('react-dom/'),
    plugins: [
      {
        name: 'local-resolve',
        resolveId(source, importer) {
          if (EXTERNALS.has(source)) return { id: source, external: true };
          if (source.startsWith('react/') || source.startsWith('react-dom/')) {
            return { id: source, external: true };
          }
          if (!importer) return null;
          if (!source.startsWith('.')) return null;

          const base = path.resolve(path.dirname(importer), source);
          const candidates = [base, base + '.js', path.join(base, 'index.js')];
          for (const c of candidates) {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
          }
          return null;
        },
        load(id) {
          if (fs.existsSync(id) && fs.statSync(id).isFile()) {
            return fs.readFileSync(id, 'utf8');
          }
          return null;
        },
      },
    ],
    onwarn(w, warn) {
      if (w.code === 'CIRCULAR_DEPENDENCY' || w.code === 'THIS_IS_UNDEFINED') return;
      warn(w);
    },
  });

  const { output } = await bundle.generate({
    format: 'es',
    sourcemap: false,
  });
  await bundle.close();
  return output[0].code;
}

function writeHtml(jsFile, cssFile) {
  const importMap = {
    imports: {
      react: 'https://esm.sh/react@19.2.0',
      'react-dom': 'https://esm.sh/react-dom@19.2.0',
      'react-dom/client': 'https://esm.sh/react-dom@19.2.0/client',
      'react/jsx-runtime': 'https://esm.sh/react@19.2.0/jsx-runtime',
      'react/jsx-dev-runtime': 'https://esm.sh/react@19.2.0/jsx-dev-runtime',
      'react-router-dom': 'https://esm.sh/react-router-dom@7.13.1?external=react,react-dom',
      'framer-motion': 'https://esm.sh/framer-motion@12.35.0?external=react,react-dom',
      'lucide-react': 'https://esm.sh/lucide-react@0.577.0?external=react,react-dom',
    },
  };

  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  // Remove any prior scripts in body (keep root)
  html = html.replace(
    /<script type="module" src="\/src\/main\.tsx"><\/script>[\s\S]*?<\/body>/,
    `</body>`
  );
  // Clean leftover scripts after root
  html = html.replace(
    /<div id="root"><\/div>[\s\S]*<\/body>/,
    `<div id="root"></div>
    <script type="importmap">
${JSON.stringify(importMap, null, 2)}
    </script>
    <link rel="stylesheet" href="/assets/${cssFile}" />
    <script type="module" src="/assets/${jsFile}"></script>
  </body>`
  );
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
}

function copyPublic() {
  const pub = path.join(root, 'public');
  for (const f of walk(pub)) {
    const rel = path.relative(pub, f);
    const dest = path.join(outDir, rel);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(f, dest);
  }
}

async function main() {
  console.log('→ Collecting utility classes…');
  const srcFiles = walk(path.join(root, 'src')).filter((f) =>
    /\.(tsx?|jsx?|css)$/.test(f)
  );
  const classes = extractClasses(srcFiles);
  // Dynamic / common extras
  [
    'min-h-screen','flex','flex-1','flex-col','items-center','justify-between','justify-center',
    'gap-1','gap-1.5','gap-2','gap-3','gap-4','gap-6','p-3','p-4','p-5','p-6','p-8','p-10',
    'px-2','px-2.5','px-3','px-4','px-5','px-6','py-0.5','py-1','py-1.5','py-2','py-2.5','py-3','py-4','py-5','py-8',
    'pt-1','pt-0.5','pt-5','pb-4','pb-5','mb-1','mb-1.5','mb-2','mb-3','mb-4','mb-5','mb-6','mt-0.5','mt-1','mt-1.5','mt-2','mt-3','mt-4','mt-6',
    'ml-2','ml-auto','mx-2','my-0.5',
    'text-[9px]','text-[10px]','text-[11px]','text-xs','text-sm','text-base','text-lg','text-xl','text-2xl',
    'text-white','text-accent','text-slate-100','text-slate-200','text-slate-300','text-slate-400','text-slate-500','text-slate-600',
    'text-emerald-300','text-emerald-400','text-emerald-500/80','text-rose-300','text-rose-400','text-amber-300','text-amber-400','text-sky-300','text-sky-400',
    'bg-surface','bg-panel','bg-panel/80','bg-surface/40','bg-surface/50','bg-surface/60','bg-white/2','bg-white/3','bg-white/5',
    'bg-accent/8','bg-accent/10','bg-accent/12','bg-accent/15','bg-accent/25',
    'bg-emerald-500/5','bg-emerald-500/8','bg-emerald-500/10',
    'bg-rose-500/5','bg-rose-500/8','bg-rose-500/10',
    'bg-amber-500/5','bg-amber-500/10','bg-sky-500/8','bg-sky-500/10',
    'border','border-b','border-t','border-l-2','border-line','border-line/60','border-transparent',
    'border-accent/25','border-accent/30','border-accent/40','border-accent/50',
    'border-emerald-500/20','border-emerald-500/25','border-emerald-500/30','border-emerald-500/40',
    'border-rose-500/25','border-rose-500/30','border-rose-500/40','border-rose-500/60',
    'border-amber-500/25','border-amber-500/30','border-sky-500/25','border-sky-500/30',
    'border-l-accent','border-l-transparent',
    'rounded','rounded-md','rounded-lg','rounded-xl','rounded-full',
    'font-mono','font-display','font-medium','font-semibold',
    'tracking-tight','tracking-wide','tracking-wider','tracking-[0.14em]','tracking-[0.16em]','tracking-[0.18em]',
    'uppercase','leading-none','leading-relaxed','line-clamp-1','line-clamp-2',
    'w-full','w-px','w-60','w-14','h-1.5','h-3','h-3.5','h-4','h-4.5','h-5','h-6','h-7','h-8','h-9','h-10','h-14','h-auto','h-full','min-h-screen','min-w-0','max-w-2xl','max-w-3xl',
    'max-h-72','max-h-[200px]','max-h-[520px]','max-h-[600px]','max-h-[640px]',
    'shrink-0','overflow-hidden','overflow-x-auto','overflow-y-auto','truncate',
    'grid','grid-cols-2','sm:grid-cols-2','sm:grid-cols-3','md:grid-cols-2','md:grid-cols-3','lg:grid-cols-2','lg:grid-cols-3','lg:grid-cols-4','lg:grid-cols-5','lg:col-span-1','lg:col-span-2','lg:col-span-3','xl:grid-cols-4','xl:grid-cols-6',
    'hidden','md:block','sm:flex-row','sm:items-end','flex-wrap','items-start','items-end','items-stretch','justify-end','text-left','text-right','text-center',
    'space-y-0','space-y-0.5','space-y-2','space-y-3','space-y-4','space-x-0','divide-y','divide-line',
    'sticky','top-0','backdrop-blur','transition-colors','transition-all','hover:scale-[1.01]','hover:bg-white/3','hover:bg-white/10','hover:bg-accent/25','hover:bg-rose-500/20','hover:bg-amber-500/20','hover:border-emerald-500/40','hover:border-rose-500/60','hover:text-slate-200','hover:underline',
    'disabled:opacity-40','animate-pulse','cursor-pointer','opacity-40','opacity-50','opacity-70','opacity-85','opacity-90',
    'from-violet-500/20','to-violet-500/5','from-accent/25','to-accent/5','from-sky-500/20','to-sky-500/5',
    'bg-gradient-to-br','inline-flex','relative','absolute',
  ].forEach((c) => classes.push(c));

  console.log(`  ${new Set(classes).size} unique candidates`);

  console.log('→ Compiling Tailwind CSS…');
  const css = await buildCss([...new Set(classes)]);
  console.log(`  ${css.length} bytes`);

  console.log('→ Transpiling TypeScript…');
  const tmpDir = transpileProject();

  console.log('→ Bundling app modules…');
  const js = await bundleJs(tmpDir);
  console.log(`  ${js.length} bytes`);

  rimraf(outDir);
  ensureDir(assetsDir);
  fs.writeFileSync(path.join(assetsDir, 'index.js'), js);
  fs.writeFileSync(path.join(assetsDir, 'index.css'), css);
  copyPublic();
  writeHtml('index.js', 'index.css');
  rimraf(tmpDir);

  // Sanity
  if (!fs.existsSync(path.join(outDir, 'index.html'))) throw new Error('missing index.html');
  console.log('✓ Build complete → dist/');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
