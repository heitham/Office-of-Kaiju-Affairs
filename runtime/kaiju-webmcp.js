/**
 * Kaiju Affairs — WebMCP runtime entry point.
 *
 * The CMS emits exactly one line into every published page:
 *
 *   <script type="module" src="/runtime/kaiju-webmcp.js" data-manifest="/manifest.json"></script>
 *
 * Everything else — which tools exist, what they know, which form this page
 * carries — comes from the manifest the CMS generates at publish time. No page
 * hand-codes a tool. Publish a thousand more pages and the agent layer scales
 * with them for free.
 *
 * MIT licensed. See LICENSE at the repository root.
 */

import { loadManifest } from './src/manifest.js';
import { createTools } from './src/tools.js';
import { registerTools, findModelContext } from './src/register.js';
import { normalizePath } from './src/util.js';

const DEFAULTS = {
  manifest: '/manifest.json',
  page: null,
  debug: false
};

/** Read configuration off our own <script> tag. */
function readConfig() {
  const scripts = [...document.querySelectorAll('script[data-manifest], script[src*="kaiju-webmcp"]')];
  const self = scripts.find((s) => {
    try { return new URL(s.src, location.href).href === import.meta.url; }
    catch { return false; }
  }) || scripts[0];

  if (!self) return { ...DEFAULTS };
  return {
    manifest: self.dataset.manifest || DEFAULTS.manifest,
    page: self.dataset.page || DEFAULTS.page,
    debug: self.dataset.debug === 'true' || self.dataset.debug === ''
  };
}

const config = readConfig();
const currentPath = () => normalizePath(config.page || location.pathname);
const getManifest = () => loadManifest(config.manifest);

const tools = createTools({ getManifest, currentPath });
let controller = registerTools(tools);

/** Public handle: judges can inspect this in the console; the Arena reads it. */
const api = {
  version: '1.0.0',
  get available() { return controller.available; },
  get surface() { return controller.surface; },
  get registered() { return [...controller.registered]; },
  get reason() { return controller.reason || null; },
  config,
  currentPath,
  manifest: getManifest,
  /** Invoke a tool by name exactly as an agent would — used by the Arena's self-test. */
  async call(name, args = {}) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.execute(args);
  },
  definitions: tools.map(({ name, title, description, inputSchema, annotations }) => ({
    name, title, description, inputSchema, annotations
  }))
};

Object.defineProperty(globalThis, 'kaijuWebMCP', { value: api, writable: false, configurable: true });
document.dispatchEvent(new CustomEvent('kaiju-webmcp:ready', { detail: api }));

if (config.debug) {
  console.info(
    `[kaiju-webmcp] ${controller.available
      ? `${controller.registered.length} tools registered via ${controller.surface}.modelContext: ${controller.registered.join(', ')}`
      : controller.reason}`
  );
}

// Tools belong to this document. Drop them when the page goes away, and put
// them back if the browser restores us from the back/forward cache.
addEventListener('pagehide', () => controller.unregisterAll());
addEventListener('pageshow', (event) => {
  if (event.persisted && findModelContext()) controller = registerTools(tools);
});

export default api;
