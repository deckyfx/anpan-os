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
