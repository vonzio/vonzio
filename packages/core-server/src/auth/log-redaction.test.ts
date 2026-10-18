import { describe, expect, it } from "vitest";
import { cookieNames, redactAuthBody, setCookieNames, REDACTED } from "./log-redaction.js";

describe("cookieNames", () => {
  it("keeps names and drops values", () => {
    expect(cookieNames("better-auth.session_token=abc123; vonzio_authed=1")).toEqual([
      "better-auth.session_token",
      "vonzio_authed",
    ]);
  });
  it("handles missing header", () => {
    expect(cookieNames(undefined)).toEqual([]);
    expect(cookieNames("")).toEqual([]);
  });
});

describe("setCookieNames", () => {
  it("drops values and attributes", () => {
    expect(
      setCookieNames([
        "better-auth.session_token=xyz; Path=/; HttpOnly",
        "vonzio_authed=1; Path=/; Max-Age=604800",
      ]),
    ).toEqual(["better-auth.session_token", "vonzio_authed"]);
  });
});

describe("redactAuthBody", () => {
  it("redacts token-like keys at any depth", () => {
    const body = JSON.stringify({
      session: { token: "s3cret", expiresAt: "2026-10-25", user: { id: "u1", email: "a@b.c" } },
      token: "top",
      list: [{ accessToken: "x" }],
    });
    expect(redactAuthBody(body)).toEqual({
      session: { token: REDACTED, expiresAt: "2026-10-25", user: { id: "u1", email: "a@b.c" } },
      token: REDACTED,
      list: [{ accessToken: REDACTED }],
    });
  });
  it("keeps error shapes readable", () => {
    expect(redactAuthBody(JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid" }))).toEqual({
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid",
    });
  });
  it("replaces non-JSON wholesale", () => {
    expect(redactAuthBody("opaque-token-value")).toBe(REDACTED);
  });
  it("passes empty through", () => {
    expect(redactAuthBody("")).toBe("");
  });
});
