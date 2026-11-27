/**
 * The port check that runs before a stack is deployed.
 */
import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { publishedPorts, findPortConflicts, describeConflicts } from "../src/lib/port-check";
import { ports as portProvider } from "../src/lib/providers/ports";
import { DockerClient, type DockerContainer } from "../src/lib/docker";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

/** The shape `docker compose config --format json` gives, variables already substituted. */
const RESOLVED = {
  services: {
    web:  { ports: [{ target: 80, published: "8080", protocol: "tcp" }, { target: 443, published: "8443", host_ip: "127.0.0.1" }] },
    dns:  { ports: [{ target: 53, published: "5353", protocol: "udp" }] },
    host: { network_mode: "host", ports: [{ target: 9000, published: "9000" }] },
    rng:  { ports: [{ target: 6000, published: "6000-6002" }] },
    none: { ports: [{ target: 7000 }] },
  },
};

function container(project: string, name: string, port: number, ip = "0.0.0.0", type = "tcp"): DockerContainer {
  return {
    Id: name, Names: [`/${name}`], Image: "x", ImageID: "x", Status: "Up", State: "running", Created: 0,
    Ports: [{ IP: ip, PrivatePort: port, PublicPort: port, Type: type }],
    Labels: { "com.docker.compose.project": project },
  };
}

function world(listeners: Array<{ port: number; proto?: string; address?: string; process?: string }>, containers: DockerContainer[]) {
  spies.push(spyOn(portProvider, "listeners").mockResolvedValue(
    listeners.map(l => ({ port: l.port, proto: l.proto ?? "tcp", address: l.address ?? "0.0.0.0", process: l.process ?? "", pid: null })),
  ));
  spies.push(spyOn(DockerClient, "listContainers").mockResolvedValue({ ok: true, data: containers }));
}

describe("publishedPorts", () => {
  test("reads published ports, protocols, host addresses and ranges; skips host networking", () => {
    const ports = publishedPorts(RESOLVED);
    expect(ports.map(p => `${p.service} ${p.hostIp || "*"}:${p.port}/${p.proto}`)).toEqual([
      "web *:8080/tcp", "web 127.0.0.1:8443/tcp", "dns *:5353/udp",
      "rng *:6000/tcp",
    ]);
    expect(ports.find(p => p.service === "rng")?.alternatives).toEqual([6000, 6001, 6002]);
  });

  test("nothing to read gives nothing", () => {
    expect(publishedPorts(null)).toEqual([]);
    expect(publishedPorts({ services: { a: { image: "x" } } })).toEqual([]);
  });
});

describe("findPortConflicts", () => {
  const wanted = publishedPorts(RESOLVED);

  test("a port another stack's container publishes is named with that container", async () => {
    world([{ port: 8080, process: "docker-proxy" }], [container("other", "other-web-1", 8080)]);
    const conflicts = await findPortConflicts(wanted, "mine");
    expect(conflicts).toEqual([{ port: 8080, proto: "tcp", service: "web", heldBy: 'container "other-web-1" (stack other)' }]);
    expect(describeConflicts(conflicts)).toBe('port 8080/tcp (service web) is already used by container "other-web-1" (stack other)');
  });

  test("the stack's own containers do not count, so a redeploy does not clash with itself", async () => {
    world([{ port: 8080, process: "docker-proxy" }], [container("mine", "mine-web-1", 8080)]);
    expect(await findPortConflicts(wanted, "mine")).toEqual([]);
  });

  test("a process outside Docker is named", async () => {
    world([{ port: 5353, proto: "udp", process: "avahi-daemon" }], []);
    expect(await findPortConflicts(wanted, "mine")).toEqual([
      { port: 5353, proto: "udp", service: "dns", heldBy: "process avahi-daemon" },
    ]);
  });

  test("tcp and udp on the same number do not clash", async () => {
    world([{ port: 8080, proto: "udp", process: "x" }], []);
    expect(await findPortConflicts(wanted, "mine")).toEqual([]);
  });

  test("binds on different specific addresses do not clash; a wildcard clashes with any", async () => {
    world([{ port: 8443, address: "192.168.1.5", process: "nginx" }], []);
    expect(await findPortConflicts(wanted, "mine")).toEqual([]);     // wants 127.0.0.1:8443
    while (spies.length) spies.pop()!.mockRestore();
    world([{ port: 8443, address: "[::]", process: "nginx" }], []);
    expect((await findPortConflicts(wanted, "mine")).map(c => c.port)).toEqual([8443]);
  });

  test("a published range is a choice: it clashes only when every port in it is taken", async () => {
    world([{ port: 6000, process: "a" }, { port: 6002, address: "127.0.0.1%lo", process: "c" }], []);
    expect(await findPortConflicts(wanted, "mine")).toEqual([]);             // 6001 is free
    while (spies.length) spies.pop()!.mockRestore();
    world([{ port: 6000, process: "a" }, { port: 6001, process: "b" }, { port: 6002, process: "c" }], []);
    const [conflict] = await findPortConflicts(wanted, "mine");
    expect(conflict).toMatchObject({ port: 6000, range: "6000-6002", heldBy: "process a" });
    expect(describeConflicts([conflict!])).toBe("every port in 6000-6002/tcp (service rng) is in use, 6000 by process a");
  });

  test("a host process on another address of a port the stack itself maps is still caught", async () => {
    // The stack maps 127.0.0.1:8443 itself (docker-proxy holds it); a host process holds
    // 127.0.0.2:8443, which a redeploy that moves the bind there would collide with.
    const want = [{ port: 8443, proto: "tcp" as const, hostIp: "127.0.0.2", service: "web" }];
    world(
      [{ port: 8443, address: "127.0.0.1", process: "docker-proxy" }, { port: 8443, address: "127.0.0.2", process: "nginx" }],
      [container("mine", "mine-web-1", 8443, "127.0.0.1")],
    );
    expect((await findPortConflicts(want, "mine")).map(c => c.heldBy)).toEqual(["process nginx"]);
  });

  test("an IPv4 wildcard does not cover an explicit IPv6 address", async () => {
    const want = [{ port: 9090, proto: "tcp" as const, hostIp: "::1", service: "web" }];
    world([{ port: 9090, address: "0.0.0.0", process: "prom" }], []);
    expect(await findPortConflicts(want, "mine")).toEqual([]);
    while (spies.length) spies.pop()!.mockRestore();
    world([{ port: 9090, address: "[::]", process: "prom" }], []);         // dual-stack does
    expect((await findPortConflicts(want, "mine")).length).toBe(1);
  });

  test("no published ports means no lookups at all", async () => {
    const listeners = spyOn(portProvider, "listeners");
    spies.push(listeners);
    expect(await findPortConflicts([], "mine")).toEqual([]);
    expect(listeners).not.toHaveBeenCalled();
  });
});
