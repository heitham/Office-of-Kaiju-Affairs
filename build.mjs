/**
 * Assemble the deployable site into dist/.
 *
 *   node build.mjs
 *
 * The repo keeps four things side by side — the CMS's published site, the
 * runtime, the Arena and the recorded baselines — but the deployed URL has to
 * serve the site at the root. This copies them into one tree:
 *
 *   dist/                 ← site/** (the CMS publish output)
 *   dist/manifest.json    ← site/manifest.json, or the mock if RIFT hasn't published yet
 *   dist/runtime/         ← runtime/ minus its tests and mock
 *   dist/arena/
 *   dist/baselines/
 *
 * No dependencies. Node 18+.
 */

import { cp, mkdir, rm, readdir, access, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

// site/ ships with a README explaining who owns it. That README is not a publish.
const PLACEHOLDER_FILES = new Set(['README.md', '.gitkeep', '.DS_Store']);
const isPublished = async (p) =>
  (await exists(p)) && (await readdir(p)).some((name) => !PLACEHOLDER_FILES.has(name));

const log = (...args) => console.log('[build]', ...args);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

/* 1. The published site, or the local placeholder that stands in for it. */

const sitePublished = await isPublished(join(root, 'site'));
if (sitePublished) {
  await cp(join(root, 'site'), dist, {
    recursive: true,
    filter: (src) => !PLACEHOLDER_FILES.has(src.split(/[\\/]/).pop())
  });
  log('site/ → dist/');
} else {
  await cp(join(root, 'scaffold'), dist, { recursive: true });
  log('site/ has no publish yet — using scaffold/ placeholder pages so the runtime is testable locally');
}

/* 2. The manifest. RIFT generates it; the mock stands in until then. */

const publishedManifest = join(root, 'site', 'manifest.json');
if (await exists(publishedManifest)) {
  await cp(publishedManifest, join(dist, 'manifest.json'));
  const parsed = JSON.parse(await readFile(publishedManifest, 'utf8'));
  log(`manifest: published, v${parsed.manifestVersion}, ${parsed.pages?.length ?? 0} pages`);
} else {
  await cp(join(root, 'runtime', 'mock', 'manifest.json'), join(dist, 'manifest.json'));
  log('manifest: MOCK (site/manifest.json not published yet)');
}

/* 3. The runtime, without its dev-only folders. */

await cp(join(root, 'runtime'), join(dist, 'runtime'), {
  recursive: true,
  filter: (src) => !/[\\/]runtime[\\/](test|mock)([\\/]|$)/.test(src)
});
log('runtime/ → dist/runtime/');

/* 4. The Arena and the recorded baselines. */

await cp(join(root, 'arena'), join(dist, 'arena'), { recursive: true });
await cp(join(root, 'baselines'), join(dist, 'baselines'), {
  recursive: true,
  filter: (src) => !src.endsWith('.mjs')
});
log('arena/ and baselines/ → dist/');

/* 5. A build stamp, so a deployed URL can be traced back to a commit. */

await writeFile(
  join(dist, 'build.json'),
  JSON.stringify({
    builtAt: new Date().toISOString(),
    siteSource: sitePublished ? 'site/' : 'scaffold/ (placeholder)',
    manifest: (await exists(publishedManifest)) ? 'published' : 'mock'
  }, null, 2) + '\n'
);

/* 6. The published content must still match the Arena's answer keys. A content
      edit that moves a fee or a threshold silently invalidates the race, so the
      coupling check gates the deploy rather than warning after it. */

log('checking content coupling…');
const coupling = spawnSync(process.execPath, [join(root, 'tools', 'check-coupling.mjs'), join(dist, 'manifest.json')], {
  stdio: 'inherit'
});
if (coupling.status !== 0) {
  console.error('[build] FAILED — the published content no longer matches arena/answer-keys.json. Nothing was deployed.');
  process.exit(1);
}

log('validating baseline traces…');
const traces = spawnSync(process.execPath, [join(root, 'tools', 'check-traces.mjs')], { stdio: 'inherit' });
if (traces.status !== 0) {
  console.error('[build] FAILED — a baseline trace does not match baselines/trace.schema.json. Nothing was deployed.');
  process.exit(1);
}

log('done → dist/');
if (!sitePublished) log('NOTE: this build is NOT submittable — it has placeholder pages, not the published site.');
