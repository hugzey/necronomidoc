import { serve } from "@hono/node-server";
import { createApp, type App } from "./app.js";
import { loadConfig, type NecronomidocConfig } from "./config.js";

export * from "./config.js";
export * from "./build.js";
export { createApp, type App } from "./app.js";

/** Start the portable server and return a stop() handle. */
export function startServer(
  overrides: Partial<NecronomidocConfig> = {},
): { app: App; config: NecronomidocConfig; stop: () => void } {
  const config = loadConfig(overrides);
  const app = createApp(config);
  const server = serve({ fetch: app.fetch, port: config.port });
  return {
    app,
    config,
    stop: () => server.close(),
  };
}
