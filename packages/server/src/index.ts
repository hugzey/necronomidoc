import { serve } from "@hono/node-server";
import { createApp, type App } from "./app.js";
import { loadConfig, type NecronomidocConfig } from "./config.js";

export * from "./config.js";
export * from "./build.js";
export { createApp, type App } from "./app.js";
export * from "./ingest/registry.js";
export * from "./ingest/providers.js";
export * from "./ingest/fetch.js";
export * from "./ingest/queue.js";
export * from "./ingest/status.js";

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
    stop: () => {
      app.queue.stop();
      server.close();
    },
  };
}
