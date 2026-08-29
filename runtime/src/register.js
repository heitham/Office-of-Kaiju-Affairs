/**
 * Binding to the browser's WebMCP surface.
 *
 * Chrome 150+ exposes `document.modelContext`. `navigator.modelContext` was the
 * pre-March-2026 location and is deprecated; we fall back to it only so older
 * preview builds still work, and we say so in the console.
 *
 * Per the March 2026 spec revision the surface is registerTool()/unregisterTool()
 * — there is no provideContext() batch call any more.
 */

const DEPRECATION_NOTE =
  '[kaiju-webmcp] navigator.modelContext is deprecated; this browser predates the March 2026 WebMCP revision. Chrome 150+ exposes document.modelContext.';

/** @returns {{ ctx: any, surface: 'document'|'navigator' }|null} */
export function findModelContext(scope = globalThis) {
  const doc = scope.document?.modelContext;
  if (doc && typeof doc.registerTool === 'function') return { ctx: doc, surface: 'document' };
  const nav = scope.navigator?.modelContext;
  if (nav && typeof nav.registerTool === 'function') {
    console.warn(DEPRECATION_NOTE);
    return { ctx: nav, surface: 'navigator' };
  }
  return null;
}

/** Wrap execute so a thrown error becomes a tool error, never a dead call. */
function guard(tool) {
  return {
    ...tool,
    async execute(args, extra) {
      try {
        return await tool.execute(args || {}, extra);
      } catch (error) {
        console.error(`[kaiju-webmcp] ${tool.name} failed`, error);
        return {
          isError: true,
          content: [{ type: 'text', text: `${tool.name} failed: ${error?.message || error}` }],
          structuredContent: { ok: false, error: String(error?.message || error) }
        };
      }
    }
  };
}

/**
 * Register the tool set and return a controller.
 * @param {Array} tools
 */
export function registerTools(tools, scope = globalThis) {
  const found = findModelContext(scope);
  if (!found) {
    return {
      available: false,
      surface: null,
      registered: [],
      unregisterAll() {},
      reason: 'This browser does not expose a WebMCP model context. Open the site in Chrome 150+ (or the ChatGPT in-app browser) to give your agent the tools.'
    };
  }

  const { ctx, surface } = found;
  const handles = [];
  const registered = [];

  for (const tool of tools) {
    try {
      const handle = ctx.registerTool(guard(tool));
      handles.push({ name: tool.name, handle });
      registered.push(tool.name);
    } catch (error) {
      console.error(`[kaiju-webmcp] could not register ${tool.name}`, error);
    }
  }

  return {
    available: true,
    surface,
    registered,
    unregisterAll() {
      for (const { name, handle } of handles.splice(0)) {
        try {
          if (handle && typeof handle.unregister === 'function') handle.unregister();
          else if (typeof ctx.unregisterTool === 'function') ctx.unregisterTool(name);
        } catch (error) {
          console.warn(`[kaiju-webmcp] could not unregister ${name}`, error);
        }
      }
      registered.length = 0;
    }
  };
}
