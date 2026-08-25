import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeLegacyToken, discardLegacyToken, sessionFetch, withSession } from "@/utils/auth";

describe("session authentication", () => {
  afterEach(() => {
    document.cookie = "matrixspooll_csrf_token=; Max-Age=0; Path=/";
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("consumes and removes the legacy bearer token", () => {
    localStorage.setItem("matrixspooll_auth_token", "legacy-token");

    expect(consumeLegacyToken()).toBe("legacy-token");
    expect(localStorage.getItem("matrixspooll_auth_token")).toBeNull();
    expect(consumeLegacyToken()).toBeNull();
  });

  it("discards a legacy bearer token after a new login", () => {
    localStorage.setItem("matrixspooll_auth_token", "legacy-token");

    discardLegacyToken();

    expect(localStorage.getItem("matrixspooll_auth_token")).toBeNull();
  });

  it("adds the double-submit token only to unsafe methods", () => {
    document.cookie = "matrixspooll_csrf_token=csrf-value; Path=/";

    const read = withSession();
    const write = withSession({ method: "POST" });

    expect(read.credentials).toBe("same-origin");
    expect(new Headers(read.headers).has("X-CSRF-Token")).toBe(false);
    expect(new Headers(write.headers).get("X-CSRF-Token")).toBe("csrf-value");
  });

  it("preserves caller headers and delegates to fetch", async () => {
    document.cookie = "matrixspooll_csrf_token=csrf-value; Path=/";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await sessionFetch("/api/v1/example", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(options.headers);
    expect(options.credentials).toBe("same-origin");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("csrf-value");
  });
});
