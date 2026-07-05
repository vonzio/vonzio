import { describe, it, expect } from "vitest";
import { CalendarService } from "./calendar-service.js";

// The SSRF guard + https requirement live in the connection path. verify()
// hits them before any network call for these hosts, so we can assert the
// guard rejects internal/non-https targets without a live CalDAV server.
describe("CalendarService SSRF + scheme guard", () => {
  const svc = new CalendarService();
  const creds = { username: "u@example.com", password: "app-pw" };

  it("rejects a non-https CalDAV URL", async () => {
    await expect(
      svc.verify({ caldav_url: "http://caldav.example.com/", ...creds }),
    ).rejects.toThrow(/https/i);
  });

  it("rejects a loopback host", async () => {
    await expect(
      svc.verify({ caldav_url: "https://127.0.0.1/caldav/", ...creds }),
    ).rejects.toThrow(/blocked range|CalDAV connection failed/i);
  });

  it("rejects a link-local / cloud-metadata host", async () => {
    await expect(
      svc.verify({ caldav_url: "https://169.254.169.254/", ...creds }),
    ).rejects.toThrow(/blocked range|CalDAV connection failed/i);
  });

  it("rejects an RFC1918 host", async () => {
    await expect(
      svc.verify({ caldav_url: "https://10.1.2.3/dav/", ...creds }),
    ).rejects.toThrow(/blocked range|CalDAV connection failed/i);
  });
});
