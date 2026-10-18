import { describe, it, expect } from "vitest";
import { stripPreviewToken } from "./ChatCore";

describe("stripPreviewToken", () => {
  it("drops a lone _pvt query (the reported transcript leak)", () => {
    expect(stripPreviewToken("http://localhost:3000/preview/abc/8000/?_pvt=eyJhbGci.long.token"))
      .toBe("http://localhost:3000/preview/abc/8000/");
  });
  it("keeps other query params around it", () => {
    expect(stripPreviewToken("http://h/x?_pvt=T&a=1")).toBe("http://h/x?a=1");
    expect(stripPreviewToken("http://h/x?a=1&_pvt=T")).toBe("http://h/x?a=1");
    expect(stripPreviewToken("http://h/x?a=1&_pvt=T&b=2#f")).toBe("http://h/x?a=1&b=2#f");
  });
  it("leaves text without a token alone", () => {
    expect(stripPreviewToken("Open the preview")).toBe("Open the preview");
    expect(stripPreviewToken("http://h/x?not_pvt=1")).toBe("http://h/x?not_pvt=1");
  });
});
