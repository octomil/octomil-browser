import { build } from 'esbuild';

// CJS bundle for Node/bundler require()
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  outfile: 'dist/index.cjs',
  external: ['onnxruntime-web'],
  sourcemap: true,
  target: 'es2022',
});

// IIFE bundle for <script> tag usage (global `Octomil`)
// The raw IIFE assigns a namespace object to `Octomil`, so `Octomil.Octomil`
// would be the class. The footer rewires the global so `new Octomil(...)`
// works directly while sub-exports remain accessible (e.g. Octomil.OctomilError).
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: '__Octomil_ns',
  platform: 'browser',
  outfile: 'dist/octomil.min.js',
  minify: true,
  sourcemap: true,
  target: ['es2020', 'chrome113', 'firefox115', 'safari16'],
  footer: {
    js: 'var Octomil=__Octomil_ns.Octomil;Object.assign(Octomil,__Octomil_ns);',
  },
});

console.log('Build complete: dist/index.cjs, dist/octomil.min.js');
