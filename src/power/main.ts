/// <reference types="node" />
// Server entry of the HexCard power (spec 07 design §main.ts), bundled by
// scripts/buildPowerServer.ts into powers/hexcard/server/hexcard-mcp.mjs.
//
// 1. zodJitless.ts first, so no Zod schema generates code from strings (Requirement 3.3).
// 2. The permission start check, with the server file's path from import.meta.url (Requirement 2.7).
// 3. The tools and the protocol handler, then the stdio loop until standard input ends
//    (Requirements 4.1, 4.10). Nothing then keeps the event loop alive, so the process exits with 0.

import "./zodJitless.ts"; // must stay the first import (see zodJitless.ts)
import { fileURLToPath } from "node:url";
import pluginJson from "../../powers/hexcard/plugin.json?raw";
import { createProtocolHandler } from "./protocol.ts";
import { startCheckFailure } from "./startCheck.ts";
import { serveLines } from "./stdio.ts";
import { createPowerTools } from "./tools/index.ts";

const serverFile = fileURLToPath(import.meta.url);
const failure = startCheckFailure(process.permission, serverFile);
if (failure !== undefined) {
  process.stderr.write(`hexcard: refusing to start: ${failure}. Start the server with the command line of mcp.json.\n`);
  process.exitCode = 1; // standard input is never read, nothing goes to standard output
} else {
  const tools = createPowerTools();
  // Design D18: serverInfo.version is the manifest's own version.
  const handler = createProtocolHandler({ tools, serverVersion: (JSON.parse(pluginJson) as { version: string }).version });
  await serveLines(process.stdin, process.stdout, handler);
}
