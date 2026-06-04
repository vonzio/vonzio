// @vonzio/plugin-hello — the worked example plugin for the external loader.
//
// It declares exactly three capabilities (storage.kv, notifications.channel,
// http.outbound), which is the audit signal a small plugin gives: the operator
// sees precisely what it can reach. The matching manifest lives in
// package.json under the `vonzio` block. See docs/PLUGIN_LOADER_SPEC.md.

import type { PluginContext, VonzioPlugin } from "@vonzio/plugin-api";

/** Config parsed from env. The loader calls configSchema.parse(process.env).
 *  A trivial parser keeps the example dependency-free; real plugins typically
 *  use zod. */
interface HelloConfig {
  greeting: string;
}

const plugin: VonzioPlugin<HelloConfig> = {
  name: "hello",
  apiVersion: "1.0",

  configSchema: {
    parse: (env: unknown): HelloConfig => {
      const e = (env ?? {}) as Record<string, string | undefined>;
      return { greeting: e.HELLO_GREETING ?? "hello" };
    },
  },

  async init(ctx: PluginContext<HelloConfig>): Promise<void> {
    // storage.kv — persist a per-plugin counter.
    await ctx.storage.set("boots", ((await ctx.storage.get<number>("boots")) ?? 0) + 1);

    // notifications.channel — claim the "hello" kind.
    ctx.notificationBus.registerHandler("hello", async (req) => {
      ctx.log.info({ recipient: req.recipient }, `${ctx.config.greeting}: ${req.text}`);
      return { ok: true };
    });

    // http.outbound — a route that calls the one allowlisted host via the
    // audited ctx.http (raw fetch would be flagged by the loader's anomaly
    // detector + the no-raw-fetch lint).
    ctx.server.get("/ping", async () => {
      const res = await ctx.http.fetch("https://hello-plugin.example.com/health");
      return { upstreamStatus: res.status };
    });
  },
};

export default plugin;
