import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'app.js', 'styles.css', 'telemetry.css']) {
  await cp(join(root, 'public', file), join(output, file));
}
const functions = join(output, 'netlify', 'functions');
await mkdir(functions, { recursive: true });
await cp(join(root, 'netlify', 'functions', 'api-proxy.mjs'), join(functions, 'api-proxy.mjs'));
await writeFile(join(output, 'netlify.toml'), `[build]\n  publish = "."\n  functions = "netlify/functions"\n\n[functions]\n  node_bundler = "esbuild"\n\n[[redirects]]\n  from = "/api/*"\n  to = "/.netlify/functions/api-proxy/api/:splat"\n  status = 200\n  force = true\n`);
await writeFile(join(output, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
`);
console.log(`Built Netlify frontend in ${output}`);