import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { createVerify, createPublicKey } from "node:crypto";
import type { Config } from "../config.js";
import type { IntegrationService, TellerConfig } from "../services/integration-service.js";

export interface TellerConnectRoutesOptions {
  config: Config;
  integrationService: IntegrationService;
}

/** Minimal shape Vonzio cares about from the Teller Connect onSuccess payload. */
interface ConnectPayload {
  accessToken: string;
  enrollment: {
    id: string;
    institution: { id?: string; name?: string };
  };
  user?: { id?: string };
  /**
   * Optional Ed25519 signature over the canonical JSON of
   * {accessToken, enrollment, user}. Base64-encoded. When present we verify
   * against TELLER_SIGNING_PUBKEY; when absent we trust the session.
   */
  signature?: string;
}

/**
 * Build a stable byte-for-byte representation of the payload so the sender
 * and verifier hash the same thing. Recursively sorts keys at every depth —
 * `JSON.stringify(p, sortedKeys)` only sorts the top level, which would let
 * a nested object (e.g. enrollment.institution) flap based on insertion
 * order and break verification non-deterministically.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

function verifySignature(pubkeyB64: string, message: string, signatureB64: string): boolean {
  try {
    // Teller publishes the Ed25519 public key as raw 32 bytes, base64-encoded.
    // Wrap it in a DER SubjectPublicKeyInfo so Node's KeyObject accepts it.
    const raw = Buffer.from(pubkeyB64, "base64");
    if (raw.length !== 32) return false;
    const der = Buffer.concat([
      Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
      raw,
    ]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const v = createVerify("");
    v.update(message);
    v.end();
    return v.verify(key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export const tellerConnectRoutes = fp(
  async (server: FastifyInstance, opts: TellerConnectRoutesOptions) => {
    const { config, integrationService } = opts;

    server.get("/v1/integrations/teller/config", async () => {
      // Frontend uses this to decide whether to render the "Connect bank"
      // button and which Teller Connect environment to open against.
      return {
        enabled: Boolean(config.TELLER_APP_ID && config.TELLER_CERT_PATH && config.TELLER_KEY_PATH),
        application_id: config.TELLER_APP_ID ?? null,
        environment: config.TELLER_ENVIRONMENT,
      };
    });

    server.post<{ Body: ConnectPayload }>(
      "/v1/integrations/teller/callback",
      async (request, reply) => {
        const user = request.user!;
        const body = request.body;

        if (!body?.accessToken || !body?.enrollment?.id) {
          return reply.code(400).send({ error: "invalid_payload", message: "Missing accessToken or enrollment.id" });
        }

        // Optional signature verification — when both pubkey and signature
        // are present, the signature must verify. When either is missing we
        // fall back to "trust the authenticated session" (browser POST from
        // a logged-in dashboard origin). Strict-mode is opt-in by setting
        // TELLER_SIGNING_PUBKEY and requiring the client to send `signature`.
        if (config.TELLER_SIGNING_PUBKEY && body.signature) {
          const { signature: _sig, ...rest } = body;
          const ok = verifySignature(config.TELLER_SIGNING_PUBKEY, canonicalize(rest), body.signature);
          if (!ok) {
            return reply.code(401).send({ error: "invalid_signature" });
          }
        }

        const tellerConfig: TellerConfig = {
          enrollment_id: body.enrollment.id,
          access_token: body.accessToken,
          institution_id: body.enrollment.institution?.id,
          institution_name: body.enrollment.institution?.name,
          teller_user_id: body.user?.id,
          enrolled_at: new Date().toISOString(),
        };

        // De-dup: replace the row if this user already enrolled this same
        // enrollment_id (re-running Connect to re-grant). Match on
        // (user_id, type, external_id=enrollment_id).
        const existing = await integrationService.listByUserAndType(user.id, "teller");
        const dup = existing.find((r) => (r.config as unknown as TellerConfig).enrollment_id === body.enrollment.id);
        if (dup) {
          await integrationService.delete(dup.id);
        }

        const created = await integrationService.create(user.id, "teller", tellerConfig as unknown as Record<string, unknown>);

        return reply.send({
          id: created.id,
          enrollment_id: tellerConfig.enrollment_id,
          institution_name: tellerConfig.institution_name ?? null,
        });
      },
    );
  },
  { name: "teller-connect-routes" },
);
