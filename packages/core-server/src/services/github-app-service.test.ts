import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { GithubAppService } from "./github-app-service.js";

// A throwaway RSA keypair so the JWT signature is real and verifiable.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function decodeJwt(jwt: string) {
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  return { header, payload, signingInput: `${h}.${p}`, signature: s };
}

describe("GithubAppService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports configuration state from id/key/slug/client", () => {
    expect(new GithubAppService({}).isConfigured()).toBe(false);
    expect(new GithubAppService({ appId: "1", privateKey: PEM }).isConfigured()).toBe(true);
    expect(new GithubAppService({ appId: "1", privateKey: PEM }).canInstall()).toBe(false);
    // slug alone is no longer enough — install needs the OAuth client creds so we
    // can verify installation ownership at callback time (default-deny otherwise).
    expect(new GithubAppService({ appId: "1", privateKey: PEM, slug: "app" }).canInstall()).toBe(false);
    expect(
      new GithubAppService({ appId: "1", privateKey: PEM, slug: "app", clientId: "c", clientSecret: "s" }).canInstall(),
    ).toBe(true);
  });

  it("builds an install URL with the encoded state", () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM, slug: "my-app" });
    const url = svc.installUrl("a b/c");
    expect(url).toBe("https://github.com/apps/my-app/installations/new?state=a%20b%2Fc");
  });

  // Fresh Response per call — a Response body can only be read once, so reused
  // instances break any test that triggers more than one fetch.
  const tokenResponse = (token: string, expiresInMs: number) => () =>
    Promise.resolve(
      new Response(JSON.stringify({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }), { status: 201 }),
    );

  it("normalizes literal \\n escapes in the private key", async () => {
    // Single-line env var form: real newlines replaced by the two-char "\n".
    const escaped = PEM.replace(/\n/g, "\\n");
    const svc = new GithubAppService({ appId: "42", privateKey: escaped });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(tokenResponse("ghs_abc", 3600_000));
    await expect(svc.getInstallationToken("123")).resolves.toBe("ghs_abc");
    // The JWT it sent must verify against the public key — proves the key parsed.
    const auth = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const jwt = auth.Authorization.replace("Bearer ", "");
    const { header, payload, signingInput, signature } = decodeJwt(jwt);
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe("42");
    const ok = createVerify("RSA-SHA256").update(signingInput).verify(publicKey, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  it("caches the installation token until near expiry", async () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(tokenResponse("ghs_1", 3600_000));
    const a = await svc.getInstallationToken("inst1");
    const b = await svc.getInstallationToken("inst1");
    expect(a).toBe("ghs_1");
    expect(b).toBe("ghs_1");
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it("re-mints when the cached token is past the skewed expiry", async () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM });
    // expires_at already in the past → cache entry is immediately stale.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(tokenResponse("ghs_x", -1000));
    await svc.getInstallationToken("inst2");
    await svc.getInstallationToken("inst2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a failed token mint", async () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(svc.getInstallationToken("inst3")).rejects.toThrow(/401/);
  });

  it("fetches installation account metadata", async () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 99, account: { login: "Fucec", type: "Organization" } }), { status: 200 }),
    );
    const inst = await svc.getInstallation("99");
    expect(inst).toEqual({ id: 99, accountLogin: "Fucec", accountType: "Organization" });
  });

  it("exchanges a user-OAuth code for an access token", async () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM, clientId: "cid", clientSecret: "sec" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "u-token" }), { status: 200 }),
    );
    await expect(svc.exchangeUserCode("the-code")).resolves.toBe("u-token");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ client_id: "cid", client_secret: "sec", code: "the-code" });
  });

  it("throws exchanging a code without client creds", async () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM });
    await expect(svc.exchangeUserCode("x")).rejects.toThrow(/OAuth client not configured/);
  });

  it("confirms a user owns an installation (verification gate)", async () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ total_count: 2, installations: [{ id: 11 }, { id: 22 }] }), { status: 200 }),
    );
    expect(await svc.userHasInstallation("u-token", "22")).toBe(true);
  });

  it("rejects an installation the user does NOT own (the IDOR gate)", async () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ total_count: 1, installations: [{ id: 11 }] }), { status: 200 }),
    );
    // 999 is someone else's enumerable installation id — must not bind.
    expect(await svc.userHasInstallation("u-token", "999")).toBe(false);
  });

  it("paginates user installations before giving up", async () => {
    const svc = new GithubAppService({ appId: "1", privateKey: PEM });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 101, installations: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 101, installations: [{ id: 777 }] }), { status: 200 }),
      );
    expect(await svc.userHasInstallation("u-token", "777")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
