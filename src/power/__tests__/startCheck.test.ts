/// <reference types="node" />
// Spec 07 task 3.1: startCheck.ts (Requirement 2.7), with fake permission objects. The real
// process.permission is exercised by the server process tests of task 3.5.
import { dirname, parse } from "node:path";
import { describe, expect, it } from "vitest";
import { startCheckFailure, type PermissionApi } from "../startCheck.ts";

const SERVER_FILE = "/opt/kiro/powers/hexcard/server/hexcard-mcp.mjs";

/** Grants exactly the listed "scope" or "scope reference" entries and records every probe. */
function fakePermission(...granted: string[]): PermissionApi & { probes: string[] } {
  const probes: string[] = [];
  return {
    probes,
    has(scope, reference) {
      const key = reference === undefined ? scope : `${scope} ${reference}`;
      probes.push(key);
      return granted.includes(key);
    },
  };
}

describe("startCheckFailure", () => {
  it("refuses when the permission model is off", () => {
    expect(startCheckFailure(undefined, SERVER_FILE)).toBe("the permission model is off");
  });

  it("passes the start line of mcp.json (only the server file is readable)", () => {
    const permission = fakePermission(`fs.read ${SERVER_FILE}`);
    expect(startCheckFailure(permission, SERVER_FILE)).toBeUndefined();
    expect(permission.probes).toEqual([
      "fs.write",
      `fs.write ${SERVER_FILE}`,
      `fs.write ${dirname(SERVER_FILE)}`,
      `fs.write ${parse(SERVER_FILE).root}`,
      "child",
      "worker",
      "addon",
      "wasi",
      "fs.read",
      `fs.read ${dirname(SERVER_FILE)}`,
    ]);
  });

  it.each([
    ["fs.write"],
    [`fs.write ${SERVER_FILE}`],
    [`fs.write ${dirname(SERVER_FILE)}`],
    ["fs.write /"],
  ])("refuses when %s is allowed", (grant) => {
    expect(startCheckFailure(fakePermission(grant), SERVER_FILE)).toBe("writing files is allowed");
  });

  it.each([
    ["child", "child processes are allowed"],
    ["worker", "worker threads are allowed"],
    ["addon", "native add-ons or WASI are allowed"],
    ["wasi", "native add-ons or WASI are allowed"],
    ["fs.read", "reading the server's folder is allowed"],
    [`fs.read ${dirname(SERVER_FILE)}`, "reading the server's folder is allowed"],
  ])("refuses when %s is allowed", (grant, reason) => {
    expect(startCheckFailure(fakePermission(grant), SERVER_FILE)).toBe(reason);
  });

  it("names the first failing probe in the order of the design", () => {
    const all = ["fs.write", "child", "worker", "addon", "fs.read"];
    expect(startCheckFailure(fakePermission(...all), SERVER_FILE)).toBe("writing files is allowed");
    expect(startCheckFailure(fakePermission(...all.slice(1)), SERVER_FILE)).toBe("child processes are allowed");
    expect(startCheckFailure(fakePermission(...all.slice(2)), SERVER_FILE)).toBe("worker threads are allowed");
    expect(startCheckFailure(fakePermission(...all.slice(3)), SERVER_FILE)).toBe("native add-ons or WASI are allowed");
    expect(startCheckFailure(fakePermission(...all.slice(4)), SERVER_FILE)).toBe("reading the server's folder is allowed");
  });

  it("passes a write grant for an unrelated folder (design D3)", () => {
    expect(startCheckFailure(fakePermission("fs.write /var/tmp"), SERVER_FILE)).toBeUndefined();
  });
});
