import { test, expect, describe } from "bun:test";
import { resolveLaunchUrl, launchLabel } from "../src/public/app/pages/home/utils";

const url = (address: string | null, port: string | null, scheme = "http", indexPath = "/") =>
  resolveLaunchUrl({ scheme, address, port, indexPath });

describe("resolveLaunchUrl", () => {
  test("drops the published port for a proxied domain", () => {
    expect(url("app.example.com", "8080", "https")).toBe("https://app.example.com/");
    expect(url("example.com", "8080")).toBe("http://example.com/");
  });

  test("honours a port typed into the address", () => {
    expect(url("app.example.com:8080", "9000", "https")).toBe("https://app.example.com:8080/");
  });

  test("keeps the port for IP literals and LAN names", () => {
    expect(url("192.168.1.10", "8080")).toBe("http://192.168.1.10:8080/");
    expect(url("nas.local", "8080")).toBe("http://nas.local:8080/");
    expect(url("server.lan", "8080")).toBe("http://server.lan:8080/");
    expect(url("nas", "8080")).toBe("http://nas:8080/");
  });

  test("keeps the port when no address is set", () => {
    expect(url("", "8080")).toBe("http://localhost:8080/");
    expect(url(null, "8080")).toBe("http://localhost:8080/");
  });

  test("handles IPv6 literals", () => {
    expect(url("::1", "8080")).toBe("http://[::1]:8080/");
    expect(url("[::1]:8080", null)).toBe("http://[::1]:8080/");
  });

  test("a full URL in the address describes the target completely", () => {
    expect(url("https://app.example.com/admin", "8080")).toBe("https://app.example.com/admin");
    expect(url("http://192.168.1.10:9000", "8080")).toBe("http://192.168.1.10:9000/");
    expect(url("https://192.168.1.10", "8080")).toBe("https://192.168.1.10/");
  });

  test("omits ports that are the scheme default", () => {
    expect(url("192.168.1.10", "80")).toBe("http://192.168.1.10/");
    expect(url("192.168.1.10", "443", "https")).toBe("https://192.168.1.10/");
  });

  test("normalises compose-style port fields", () => {
    expect(url("192.168.1.10", "8080:80")).toBe("http://192.168.1.10:8080/");
    expect(url("192.168.1.10", "8080/tcp")).toBe("http://192.168.1.10:8080/");
  });

  test("applies the index path", () => {
    expect(url("app.example.com", "8080", "https", "/dashboard")).toBe("https://app.example.com/dashboard");
    expect(url("192.168.1.10", "8080", "http", "dashboard")).toBe("http://192.168.1.10:8080/dashboard");
  });

  test("returns null when there is nothing to open", () => {
    expect(url("", null)).toBeNull();
    expect(url(null, null)).toBeNull();
  });
});

describe("launchLabel", () => {
  test("shows the port when present, else the hostname", () => {
    expect(launchLabel("http://192.168.1.10:8080/")).toBe(":8080");
    expect(launchLabel("https://app.example.com/")).toBe("app.example.com");
  });
});

describe("authority safety", () => {
  const at = (address: string) =>
    resolveLaunchUrl({ scheme: "http", address, port: null, indexPath: "/" });

  test("userinfo cannot smuggle a different host", () => {
    // "http://good.com@evil.com/" navigates to evil.com — good.com is only userinfo — so
    // a tile would look trusted and lead elsewhere. The address field is user-editable.
    expect(at("good.com@evil.com")).toBeNull();
  });

  test("path, query and fragment characters are rejected in a bare authority", () => {
    expect(at("good.com/../x")).toBeNull();
    expect(at("good.com?next=evil")).toBeNull();
    expect(at("good.com#x")).toBeNull();
    expect(at("good.com\\evil.com")).toBeNull();
  });

  test("malformed bracket suffixes are rejected, not silently trimmed", () => {
    // "[::1]junk" used to resolve as "[::1]" — the parser tolerated the suffix and
    // dropped it, producing a URL the address never described.
    expect(at("[::1]junk")).toBeNull();
    expect(at("[::1")).toBeNull();
    expect(at("[not-ipv6]")).toBeNull();
  });

  test("a non-numeric or out-of-range port is not a port", () => {
    expect(at("good.com:http")).toBeNull();
    expect(at("good.com:0")).toBeNull();
    expect(at("good.com:99999")).toBeNull();
  });

  test("invalid IPv6 literals are rejected, not bracketed and shipped", () => {
    // A character-and-count check passed these; the URL parser does not, and it rejects
    // exactly what a browser would.
    expect(at(":::")).toBeNull();
    expect(at("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(at("gg::1")).toBeNull();
    expect(at("[:::]:8080")).toBeNull();
  });

  test("valid IPv6 forms, including IPv4-mapped, still resolve", () => {
    expect(at("fe80::1")).toBe("http://[fe80::1]/");
    expect(at("2001:db8::1")).toBe("http://[2001:db8::1]/");
    expect(at("::ffff:192.168.1.1")).toBe("http://[::ffff:192.168.1.1]/");
  });

  test("an out-of-range metadata port is dropped, keeping the address usable", () => {
    // The AppConfig port field is editable, so 0 and 99999 reach here.
    expect(resolveLaunchUrl({ scheme: "http", address: "nas.local", port: "0", indexPath: "/" }))
      .toBe("http://nas.local/");
    expect(resolveLaunchUrl({ scheme: "http", address: "nas.local", port: "99999", indexPath: "/" }))
      .toBe("http://nas.local/");
  });

  test("an out-of-range port inside a full URL invalidates it", () => {
    // Unlike a supplementary port, this one is part of the address being described.
    expect(resolveLaunchUrl({ scheme: null, address: "http://nas.local:0/", port: null, indexPath: "/" }))
      .toBeNull();
    expect(resolveLaunchUrl({ scheme: null, address: "http://nas.local:99999/", port: null, indexPath: "/" }))
      .toBeNull();
    expect(resolveLaunchUrl({ scheme: null, address: "http://nas.local:8080/", port: null, indexPath: "/" }))
      .toBe("http://nas.local:8080/");
  });

  test("ordinary authorities still resolve", () => {
    expect(at("good.com")).toBe("http://good.com/");
    expect(at("192.168.1.10:8080")).toBe("http://192.168.1.10:8080/");
    expect(at("[::1]:8080")).toBe("http://[::1]:8080/");
    expect(at("::1")).toBe("http://[::1]/");
    expect(at("good.com:8080")).toBe("http://good.com:8080/");
  });
});

describe("scheme safety", () => {
  test("a javascript scheme cannot reach the href", () => {
    // scheme comes from stack metadata a user can edit, and from CasaOS imports; the
    // result is used as an anchor href, so anything but http/https must not survive.
    const out = resolveLaunchUrl({ scheme: "javascript", address: "example.com", port: null, indexPath: "/" });
    expect(out?.startsWith("javascript:")).toBe(false);
    expect(out).toBe("http://example.com/");
  });

  test("https is preserved, case-insensitively", () => {
    expect(resolveLaunchUrl({ scheme: "HTTPS", address: "example.com", port: null, indexPath: "/" }))
      .toBe("https://example.com/");
  });

  test("a full URL carrying a hostile scheme is downgraded, not trusted", () => {
    const out = resolveLaunchUrl({ scheme: null, address: "javascript://evil/%0aalert(1)", port: null, indexPath: "/" });
    expect(out?.startsWith("javascript:")).toBe(false);
  });

  test("an unknown scheme falls back to http rather than being dropped", () => {
    expect(resolveLaunchUrl({ scheme: "ftp", address: "example.com", port: null, indexPath: "/" }))
      .toBe("http://example.com/");
  });
});
