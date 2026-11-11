/// <reference types="node" />
// Permission-model probes run before the server reads any input (spec 07 Requirement 2.7;
// design §startCheck.ts, D3).

import { dirname, parse } from "node:path";

/** The part of `process.permission` the probes use. */
export interface PermissionApi {
  has(scope: string, reference?: string): boolean;
}

/**
 * Why the server must not start, or undefined. `serverFile` comes from import.meta.url. The probes
 * run in this order and the first that fails names the reason.
 */
export function startCheckFailure(permission: PermissionApi | undefined, serverFile: string): string | undefined {
  if (permission === undefined) return "the permission model is off";
  const folder = dirname(serverFile);
  // has("fs.write") without a reference is true only when every write is allowed, so three
  // concrete paths are probed as well (design §startCheck.ts).
  if (
    permission.has("fs.write") ||
    permission.has("fs.write", serverFile) ||
    permission.has("fs.write", folder) ||
    permission.has("fs.write", parse(serverFile).root)
  ) {
    return "writing files is allowed";
  }
  if (permission.has("child")) return "child processes are allowed";
  if (permission.has("worker")) return "worker threads are allowed";
  if (permission.has("addon") || permission.has("wasi")) return "native add-ons or WASI are allowed";
  if (permission.has("fs.read") || permission.has("fs.read", folder)) return "reading the server's folder is allowed";
  return undefined;
}
