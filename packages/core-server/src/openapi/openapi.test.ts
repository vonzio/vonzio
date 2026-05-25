/**
 * Boot smoke test for the OpenAPI / Swagger setup.
 *
 * Catches the exact failure mode that took prod down in v0.1.73:
 * Fastify can't resolve route `$ref`s at validator-compile time, throws
 * `FST_ERR_SCH_VALIDATION_BUILD`, server crashes on startup.
 *
 * The test:
 *   1. Creates a fresh Fastify instance (no DB / containers — pure).
 *   2. Registers @fastify/swagger with our `swaggerOptions`.
 *   3. Registers every component schema via `registerSchemas()`.
 *   4. Defines a stub route for *each* schema that has the `Input`
 *      suffix, with `body: { $ref: "<id>#" }` — mirrors how real route
 *      handlers reference them.
 *   5. `await server.ready()` triggers validator compilation. If any
 *      `$ref` can't resolve, this throws → test fails. If it returns,
 *      the schema setup is sound and the server would boot in prod.
 *
 * Keep this test green and prod stays up.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { swaggerOptions, registerSchemas, registerOpenApiJsonRoute, componentSchemas, ajvOptions } from "./index.js";

/**
 * Build a Fastify instance with the SAME ajv config buildServer uses —
 * via the shared `ajvOptions` constant. If server.ts's ajv config drifts,
 * this test drifts with it.
 */
function fastifyWithRealConfig(): ReturnType<typeof Fastify> {
  return Fastify({ logger: false, ajv: ajvOptions });
}

describe("OpenAPI / swagger boot", () => {
  it("resolves every *Input component as a route body $ref", async () => {
    const server = fastifyWithRealConfig();

    await server.register(swagger, swaggerOptions);
    registerSchemas(server);

    const inputSchemaIds = Object.values(componentSchemas)
      .map((s) => s.$id)
      .filter((id) => id.endsWith("Input"));

    expect(inputSchemaIds.length).toBeGreaterThan(0);

    for (const id of inputSchemaIds) {
      server.post(`/__smoke/body/${id}`, {
        schema: { body: { $ref: `${id}#` } },
      }, async () => ({ ok: true }));
    }

    await expect(server.ready()).resolves.not.toThrow();
    await server.close();
  });

  it("accepts inline route schemas with OpenAPI annotation keywords (`example`)", async () => {
    // Regression guard for the v0.1.74 outage. Ajv's strict schema mode
    // rejected `example:` as an unknown keyword in inline params /
    // querystring schemas — the server crashed on boot. The ajv config
    // in buildServer (mirrored in fastifyWithRealConfig) accepts these
    // annotations as no-op. If this test fails, OpenAPI-annotated
    // inline schemas will crash the real server on startup.
    const server = fastifyWithRealConfig();
    await server.register(swagger, swaggerOptions);
    registerSchemas(server);

    server.get("/__smoke/annotated/:id", {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", example: "prof_abcdef" } },
        },
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", example: "1" },
            limit: { type: "string", example: "50" },
          },
        },
      },
    }, async () => ({ ok: true }));

    await expect(server.ready()).resolves.not.toThrow();
    await server.close();
  });

  it("serves the spec as JSON at /v1/openapi.json", async () => {
    // The dashboard / external codegen / link previews fetch the spec at
    // the conventional /v1/openapi.json URL. Built-in `/v1/docs/json` works
    // out of the box; the alias is wired by `registerOpenApiJsonRoute`.
    // This test guards the alias against silent regressions (e.g. someone
    // removing the call in server.ts).
    const server = fastifyWithRealConfig();
    await server.register(swagger, swaggerOptions);
    registerSchemas(server);
    registerOpenApiJsonRoute(server);
    await server.ready();

    const res = await server.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { openapi?: string; info?: { title?: string }; components?: { schemas?: Record<string, unknown> } };
    expect(body.openapi).toMatch(/^3\./);
    expect(body.info?.title).toBe("Vonzio API");
    expect(Object.keys(body.components?.schemas ?? {})).toContain("Profile");

    await server.close();
  });

  it("generates an OpenAPI spec containing every registered component", async () => {
    const server = fastifyWithRealConfig();
    await server.register(swagger, swaggerOptions);
    registerSchemas(server);
    await server.ready();

    const spec = server.swagger() as { components?: { schemas?: Record<string, unknown> } };
    const componentNames = Object.keys(spec.components?.schemas ?? {});

    for (const schema of Object.values(componentSchemas)) {
      expect(componentNames).toContain(schema.$id);
    }

    await server.close();
  });
});
