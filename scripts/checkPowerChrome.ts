/**
 * Headless Chrome check of the HexCard power's Node text backend and of `render_card` (spec 07
 * Requirements 10.3, 16.9, 17.6; design §Headless Chrome check, D8):
 *
 *   npm run build                                # the card phase serves dist/
 *   npm run check:power-chrome                   # Chrome from /usr/bin/google-chrome
 *   npm run check:power-chrome -- --chrome <path>
 *
 * Run by hand, never by `npx vitest --run`. Nothing is written into the repository: the summary
 * (`summary.json`), the screenshots, the server's PNG files and, for every difference, the images and
 * the list of differing pixels go to a new folder `<os temp>/hexcard-power-check-<UTC timestamp>/`.
 *
 * 1. Server: the committed `powers/hexcard/server/hexcard-mcp.mjs`, started as Kiro would start it
 *    (the command and `args` of `powers/hexcard/mcp.json`, `${PLUGIN_ROOT}` replaced by the power
 *    folder), called over standard input and output.
 * 2. Text phase: a check page built from `src/engine/graphics/textRaster.ts` draws every covered
 *    character alone and runs of 24 covered characters with the canvas backend; Node draws the same
 *    cases with the Node text backend; the masks must be equal, for every font file and render size
 *    that TEXT_SIZE_TABLE uses.
 * 3. Card phase, at UI scale 1 and at UI scale 2, each on a fresh Chrome profile: every card of every
 *    SHOWCASE_STACKS entry is opened through the menus; `render_card` of the auto-saved stack (or of
 *    the showcase's `create()` output when no record exists) must equal the studio's canvas.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { build, runnerImport } from "vite";

// ---------------------------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const POWER_DIR = join(REPO_ROOT, "powers", "hexcard");
const SERVER_FILE = join(POWER_DIR, "server", "hexcard-mcp.mjs");
const VITE_BIN = join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
const DEFAULT_CHROME = "/usr/bin/google-chrome";

/** Characters per run of the text phase (Requirement 17.6). */
const RUN_LENGTH = 24;
/** Extra width of a text case beyond the Node text backend's width. */
const CASE_MARGIN = 64;
/** Text cases sent to Chrome per CDP call. */
const TEXT_BATCH = 300;
/** Delay before the first read of a card, longer than the 500 ms auto-save delay. */
const FIRST_READ_DELAY_MS = 600;
/** Delay between the two reads of a card. */
const SECOND_READ_DELAY_MS = 1000;
/** Differing pixels listed per case in summary.json. */
const PIXEL_LIST_LIMIT = 200;
/** Text-phase differences whose images are written (the summary lists all of them). */
const TEXT_IMAGE_LIMIT = 40;

const CARD_WIDTH = 512;
const CARD_HEIGHT = 342;

/** A window per UI scale: computeUiScale (FloatingTools.tsx) gives 1 for the first and 2 for the second. */
const VIEWPORTS: Readonly<Record<number, { width: number; height: number }>> = {
  1: { width: 800, height: 600 },
  2: { width: 1100, height: 760 },
};
const SCALES: readonly number[] = [1, 2];

// ---------------------------------------------------------------------------------------------
// Types of the repository modules this script loads through runnerImport
// ---------------------------------------------------------------------------------------------
// They are declared here and not imported: textRaster.ts reads `import.meta.env`, which the Node
// project of tsconfig.json has no types for.

interface MeasuringBackend {
  measureText(text: string, cssFont: string): number;
}

interface TextRasterModule {
  TEXT_SIZE_TABLE: Record<string, Record<string, { file: string; boldFile?: string; renderSize: number; lineHeight: number }>>;
  cssFontString(font: string, size: number, bold: boolean): string;
  renderCrisp1BitText(
    text: string,
    font: string,
    size: number,
    style: readonly string[],
    rect: { x: number; y: number; width: number; height: number },
    align: string,
    wrap: boolean,
    backend: MeasuringBackend,
  ): { mask: Uint8Array };
}

interface NodeTextModule {
  parseFaces(bytes: unknown): unknown;
  createNodeTextBackend(faces: unknown): MeasuringBackend;
  coveredCodePoints(faces: unknown, file: string): ReadonlySet<number>;
}

interface FontBytesModule {
  bundledFontBytes(): unknown;
}

interface ShowcaseStackData {
  id: string;
  name: string;
  themePalette: { name: string; darkBitHex: string; lightBitHex: string };
  cards: { name: string }[];
}

interface PresetsModule {
  SHOWCASE_STACKS: readonly { id: string; name: string; create(): ShowcaseStackData }[];
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      last = `status ${response.status}`;
    } catch (error) {
      last = describeError(error);
    }
    await sleep(100);
  }
  throw new Error(`${url} did not answer within ${timeoutMs} ms (${last})`);
}

/** Processes and folders to clean up when the check ends, however it ends. */
const children: ChildProcess[] = [];
const scratchFolders: string[] = [];

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timer);
}

// ---------------------------------------------------------------------------------------------
// PNG output (RGBA, 8 bit) for the images the check writes
// ---------------------------------------------------------------------------------------------

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** A 0 / non-zero mask as a black-on-white RGBA image. */
function maskToRgba(mask: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(mask.length * 4);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] !== 0 ? 0 : 255;
    rgba.set([v, v, v, 255], i * 4);
  }
  return rgba;
}

// ---------------------------------------------------------------------------------------------
// The power's server over standard input and output
// ---------------------------------------------------------------------------------------------

interface McpMessage {
  id?: number;
  result?: { content?: { type: string; text?: string; data?: string }[]; isError?: boolean } & Record<string, unknown>;
  error?: { code: number; message: string };
}

class PowerServer {
  readonly child: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, (message: McpMessage) => void>();
  stderr = "";

  constructor(command: string, args: readonly string[]) {
    this.child = track(spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }));
    this.child.stdout!.setEncoding("utf8");
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (text: string) => {
      this.stderr += text;
    });
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const message = JSON.parse(line) as McpMessage;
        if (message.id !== undefined) this.waiting.get(message.id)?.(message);
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<McpMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the server did not answer ${method} within 60 s`)), 60_000);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(message);
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async initialize(): Promise<void> {
    const answer = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "checkPowerChrome", version: "0" },
    });
    if (answer.error !== undefined) throw new Error(`initialize failed: ${answer.error.message}`);
    this.notify("notifications/initialized");
  }

  /** `render_card` with the arguments of the check. */
  async renderCard(stack: string, card: number, scale: number): Promise<RenderedCard> {
    const answer = await this.request("tools/call", { name: "render_card", arguments: { stack, card, scale } });
    if (answer.error !== undefined) throw new Error(`render_card: protocol error ${answer.error.code} ${answer.error.message}`);
    const content = answer.result?.content ?? [];
    const text = content[0]?.text;
    if (answer.result?.isError === true || text === undefined) throw new Error(`render_card returned an error result: ${text ?? "no text"}`);
    const summary = JSON.parse(text) as { ok: boolean; uncoveredCharacters?: { path: string; character: string }[] };
    const data = content[1]?.data;
    if (data === undefined) throw new Error("render_card returned no image");
    return { summary, png: Buffer.from(data, "base64") };
  }
}

interface RenderedCard {
  summary: { ok: boolean; uncoveredCharacters?: { path: string; character: string }[] };
  png: Buffer;
}

function startPowerServer(): PowerServer {
  const mcp = JSON.parse(readFileSync(join(POWER_DIR, "mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const entry = mcp.mcpServers.hexcard;
  const args = entry.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", POWER_DIR));
  return new PowerServer(entry.command, args);
}

// ---------------------------------------------------------------------------------------------
// Chrome and the DevTools protocol
// ---------------------------------------------------------------------------------------------

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, ((params: any) => void)[]>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      } else if (message.method !== undefined) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`could not open ${url}`)), { once: true });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(event: string): Promise<any> {
    return new Promise((resolve) => {
      const listener = (params: unknown): void => {
        const list = this.listeners.get(event) ?? [];
        this.listeners.set(event, list.filter((entry) => entry !== listener));
        resolve(params);
      };
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    });
  }

  /** Evaluates an expression in the page and returns its value (promises are awaited). */
  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails !== undefined) {
      throw new Error(`page error: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
    }
    return answer.result.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

interface RunningChrome {
  child: ChildProcess;
  cdp: Cdp;
  version: string;
}

async function launchChrome(chrome: string, profile: string, viewport: { width: number; height: number }): Promise<RunningChrome> {
  const port = await freePort();
  const child = track(
    spawn(
      chrome,
      [
        "--headless=new",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--disable-lcd-text",
        "--no-first-run",
        "--no-default-browser-check",
        `--window-size=${viewport.width},${viewport.height}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    ),
  );
  const version = (await (await waitForHttp(`http://127.0.0.1:${port}/json/version`, 30_000)).json()) as { Browser: string };
  const targets = (await (await waitForHttp(`http://127.0.0.1:${port}/json/list`, 10_000)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((target) => target.type === "page");
  if (page === undefined) throw new Error("Chrome has no page target");
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { child, cdp, version: version.Browser };
}

async function closeChrome(running: RunningChrome): Promise<void> {
  running.cdp.close();
  await stop(running.child);
}

async function navigate(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
}

async function waitFor(cdp: Cdp, expression: string, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate<boolean>(`Boolean(${expression})`)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** `vite preview` of a folder (default: the repository's dist/), started like a developer would. */
async function startPreview(outDir: string | undefined): Promise<{ origin: string }> {
  const port = await freePort();
  const args = [VITE_BIN, "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"];
  if (outDir !== undefined) args.push("--outDir", outDir);
  const env = { ...process.env };
  delete env.BASE_PATH; // the studio is served from "/"
  track(spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: "ignore" }));
  const origin = `http://127.0.0.1:${port}`;
  await waitForHttp(`${origin}/`, 30_000);
  return { origin };
}

// ---------------------------------------------------------------------------------------------
// Text phase
// ---------------------------------------------------------------------------------------------

/** Packs a mask the way the check page does: bit i of the mask is bit (i & 7) of byte (i >> 3). */
function packMask(mask: Uint8Array): Buffer {
  const bytes = Buffer.alloc((mask.length + 7) >> 3);
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) bytes[i >> 3] |= 1 << (i & 7);
  return bytes;
}

function unpackMask(packed: Buffer, length: number): Uint8Array {
  const mask = new Uint8Array(length);
  for (let i = 0; i < length; i++) mask[i] = (packed[i >> 3] >> (i & 7)) & 1;
  return mask;
}

/** The check page's entry module. It imports textRaster.ts by absolute path and exposes the two globals. */
function textCheckEntrySource(): string {
  const textRaster = join(REPO_ROOT, "src", "engine", "graphics", "textRaster.ts").replaceAll("\\", "/");
  return `import { createCanvasTextBackend, loadBundledFonts, renderCrisp1BitText } from ${JSON.stringify(textRaster)};
let backend = null;
globalThis.__hexcardTextReady = loadBundledFonts("/fonts/").then(() => {
  backend = createCanvasTextBackend();
  return true;
});
function packMask(mask) {
  const bytes = new Uint8Array((mask.length + 7) >> 3);
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) bytes[i >> 3] |= 1 << (i & 7);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
globalThis.__hexcardTextCheck = (cases) =>
  cases.map((c) =>
    packMask(
      renderCrisp1BitText(c.text, c.font, c.size, c.bold ? ["bold"] : [], { x: 0, y: 0, width: c.width, height: c.height }, "left", false, backend).mask,
    ),
  );
`;
}

/** Builds the check page into `pageDir` (script, index.html, a copy of public/fonts/). */
async function buildTextCheckPage(pageDir: string): Promise<void> {
  const entryId = "virtual:hexcard-text-check";
  const resolved = `\0${entryId}`;
  await build({
    configFile: false,
    envFile: false,
    root: REPO_ROOT,
    mode: "production",
    base: "/",
    logLevel: "silent",
    publicDir: false,
    plugins: [
      {
        name: "hexcard-text-check-entry",
        resolveId: (source) => (source === entryId ? resolved : undefined),
        load: (id) => (id === resolved ? textCheckEntrySource() : undefined),
      },
    ],
    build: {
      outDir: pageDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      target: "es2022",
      rolldownOptions: {
        input: entryId,
        output: { format: "iife", entryFileNames: "text-check.js", codeSplitting: false },
      },
    },
  });
  writeFileSync(join(pageDir, "index.html"), '<!doctype html>\n<meta charset="utf-8">\n<title>HexCard text check</title>\n<script src="/text-check.js"></script>\n');
  cpSync(join(REPO_ROOT, "public", "fonts"), join(pageDir, "fonts"), { recursive: true });
}

interface TextSetting {
  font: string;
  size: number;
  bold: boolean;
  file: string;
  renderSize: number;
  lineHeight: number;
}

/** One setting per (font file, render size) pair that TEXT_SIZE_TABLE uses, in table order. */
function textSettings(textRaster: TextRasterModule): TextSetting[] {
  const settings = new Map<string, TextSetting>();
  for (const [font, sizes] of Object.entries(textRaster.TEXT_SIZE_TABLE)) {
    for (const [sizeKey, entry] of Object.entries(sizes)) {
      const size = Number(sizeKey);
      const add = (file: string, bold: boolean): void => {
        const key = `${file}@${entry.renderSize}`;
        if (!settings.has(key)) settings.set(key, { font, size, bold, file, renderSize: entry.renderSize, lineHeight: entry.lineHeight });
      };
      add(entry.file, false);
      if (entry.boldFile !== undefined) add(entry.boldFile, true);
    }
  }
  return [...settings.values()];
}

interface TextCase {
  kind: "char" | "run";
  codePoints: number[];
  text: string;
  width: number;
}

function textCases(covered: readonly number[], backend: MeasuringBackend, css: string): TextCase[] {
  const cases: TextCase[] = [];
  const make = (kind: "char" | "run", codePoints: number[]): void => {
    const text = String.fromCodePoint(...codePoints);
    cases.push({ kind, codePoints, text, width: Math.ceil(backend.measureText(text, css)) + CASE_MARGIN });
  };
  for (const codePoint of covered) make("char", [codePoint]);
  // Runs of RUN_LENGTH consecutive covered characters; the last one wraps around so it is full too.
  for (let start = 0; start < covered.length; start += RUN_LENGTH) {
    const run: number[] = [];
    for (let i = 0; i < RUN_LENGTH; i++) run.push(covered[(start + i) % covered.length]);
    make("run", run);
  }
  return cases;
}

interface TextDifference {
  file: string;
  renderSize: number;
  kind: "char" | "run";
  codePoints: string[];
  width: number;
  height: number;
  differingPixels: number;
  pixels: { x: number; y: number; chrome: number; node: number }[];
  images?: string[];
}

interface TextPairSummary {
  file: string;
  renderSize: number;
  setting: { font: string; size: number; bold: boolean };
  coveredCharacters: number;
  charactersCompared: number;
  runsCompared: number;
  runLength: number;
  charactersInRuns: number;
  differingCases: number;
}

async function runTextPhase(
  chrome: string,
  outDir: string,
  modules: { textRaster: TextRasterModule; nodeText: NodeTextModule; fontBytes: FontBytesModule },
): Promise<{ chromeVersion: string; pairs: TextPairSummary[]; differences: TextDifference[] }> {
  const { textRaster, nodeText, fontBytes } = modules;
  const pageDir = join(outDir, "text-check-page");
  await buildTextCheckPage(pageDir);
  const preview = await startPreview(pageDir);
  const profile = mkdtempSync(join(tmpdir(), "hexcard-chrome-profile-"));
  scratchFolders.push(profile);
  const running = await launchChrome(chrome, profile, { width: 800, height: 600 });
  const pairs: TextPairSummary[] = [];
  const differences: TextDifference[] = [];
  let imagesWritten = 0;
  try {
    await navigate(running.cdp, `${preview.origin}/`);
    await running.cdp.evaluate<boolean>("globalThis.__hexcardTextReady");
    const faces = nodeText.parseFaces(fontBytes.bundledFontBytes());
    const backend = nodeText.createNodeTextBackend(faces);
    for (const setting of textSettings(textRaster)) {
      const css = textRaster.cssFontString(setting.font, setting.size, setting.bold);
      const covered = [...nodeText.coveredCodePoints(faces, setting.file)].sort((a, b) => a - b);
      const cases = textCases(covered, backend, css);
      const style = setting.bold ? ["bold"] : [];
      let differing = 0;
      for (let from = 0; from < cases.length; from += TEXT_BATCH) {
        const batch = cases.slice(from, from + TEXT_BATCH);
        const request = batch.map((c) => ({
          text: c.text,
          font: setting.font,
          size: setting.size,
          bold: setting.bold,
          width: c.width,
          height: setting.lineHeight,
        }));
        const chromePacked = await running.cdp.evaluate<string[]>(`globalThis.__hexcardTextCheck(${JSON.stringify(request)})`);
        batch.forEach((c, index) => {
          const rect = { x: 0, y: 0, width: c.width, height: setting.lineHeight };
          const nodeMask = textRaster.renderCrisp1BitText(c.text, setting.font, setting.size, style, rect, "left", false, backend).mask;
          const nodePacked = packMask(nodeMask);
          const chromeBytes = Buffer.from(chromePacked[index], "base64");
          if (nodePacked.equals(chromeBytes)) return;
          differing++;
          const chromeMask = unpackMask(chromeBytes, nodeMask.length);
          const pixels: TextDifference["pixels"] = [];
          let count = 0;
          for (let i = 0; i < nodeMask.length; i++) {
            const n = nodeMask[i] !== 0 ? 1 : 0;
            if (n === chromeMask[i]) continue;
            count++;
            if (pixels.length < PIXEL_LIST_LIMIT) pixels.push({ x: i % c.width, y: Math.floor(i / c.width), chrome: chromeMask[i], node: n });
          }
          const difference: TextDifference = {
            file: setting.file,
            renderSize: setting.renderSize,
            kind: c.kind,
            codePoints: c.codePoints.map(codePointLabel),
            width: c.width,
            height: setting.lineHeight,
            differingPixels: count,
            pixels,
          };
          if (imagesWritten < TEXT_IMAGE_LIMIT) {
            imagesWritten++;
            const folder = join(outDir, "text-differences");
            mkdirSync(folder, { recursive: true });
            const stem = `${setting.file.replace(/\.ttf$/, "")}-${setting.renderSize}-${c.kind}-${difference.codePoints[0]}`;
            writeFileSync(join(folder, `${stem}-chrome.png`), encodeRgbaPng(c.width, setting.lineHeight, maskToRgba(chromeMask)));
            writeFileSync(join(folder, `${stem}-node.png`), encodeRgbaPng(c.width, setting.lineHeight, maskToRgba(nodeMask)));
            difference.images = [`text-differences/${stem}-chrome.png`, `text-differences/${stem}-node.png`];
          }
          differences.push(difference);
        });
      }
      const runs = cases.filter((c) => c.kind === "run").length;
      pairs.push({
        file: setting.file,
        renderSize: setting.renderSize,
        setting: { font: setting.font, size: setting.size, bold: setting.bold },
        coveredCharacters: covered.length,
        charactersCompared: covered.length,
        runsCompared: runs,
        runLength: RUN_LENGTH,
        charactersInRuns: runs * RUN_LENGTH,
        differingCases: differing,
      });
      process.stdout.write(`  text ${setting.file} @${setting.renderSize}px: ${covered.length} characters, ${runs} runs, ${differing} differing\n`);
    }
    return { chromeVersion: running.version, pairs, differences };
  } finally {
    await closeChrome(running);
  }
}

// ---------------------------------------------------------------------------------------------
// Card phase
// ---------------------------------------------------------------------------------------------

/** Page-side helpers as expression texts. They run in the studio's page through DevTools only. */
const CANVAS_SELECTOR = "canvas.hc-card-canvas";

const READ_CANVAS = `(() => {
  const canvas = document.querySelector(${JSON.stringify(CANVAS_SELECTOR)});
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
  return btoa(binary);
})()`;

const canvasLabel = `document.querySelector(${JSON.stringify(CANVAS_SELECTOR)})?.getAttribute("aria-label")`;

/** The IndexedDB record of `stackId` (the text), or null. Never creates the database. */
function readRecordExpression(stackId: string): string {
  return `new Promise((resolve) => {
  const request = indexedDB.open("hexcard");
  request.onupgradeneeded = () => request.transaction.abort();
  request.onerror = () => resolve(null);
  request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("stacks")) { db.close(); resolve(null); return; }
    const get = db.transaction("stacks", "readonly").objectStore("stacks").get(${JSON.stringify(stackId)});
    get.onsuccess = () => { db.close(); resolve(typeof get.result === "string" ? get.result : null); };
    get.onerror = () => { db.close(); resolve(null); };
  };
})`;
}

/** Decodes PNG bytes in the page with createImageBitmap (no colour conversion) to RGBA. */
function decodePngExpression(base64: string): string {
  return `(async () => {
  const binary = atob(${JSON.stringify(base64)});
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  let out = "";
  for (let i = 0; i < data.length; i += 0x8000) out += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
  return { width: bitmap.width, height: bitmap.height, rgba: btoa(out) };
})()`;
}

interface Decoded {
  width: number;
  height: number;
  rgba: Buffer;
}

async function decodePng(cdp: Cdp, png: Uint8Array): Promise<Decoded> {
  const decoded = await cdp.evaluate<{ width: number; height: number; rgba: string }>(decodePngExpression(Buffer.from(png).toString("base64")));
  return { width: decoded.width, height: decoded.height, rgba: Buffer.from(decoded.rgba, "base64") };
}

async function clickAt(cdp: Cdp, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

/** Centre of the first element that `finder` (an expression returning an element or null) yields. */
async function centreOf(cdp: Cdp, finder: string, what: string): Promise<{ x: number; y: number; disabled: boolean }> {
  const found = await cdp.evaluate<{ x: number; y: number; disabled: boolean } | null>(`(() => {
    const element = ${finder};
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, disabled: Boolean(element.disabled) };
  })()`);
  if (found === null) throw new Error(`${what} not found`);
  return found;
}

/** Clicks a menu title and then one of its items, with real mouse events. */
async function clickMenuItem(cdp: Cdp, menu: string, item: string): Promise<void> {
  const title = await centreOf(cdp, `[...document.querySelectorAll(".s7-menu-title")].find((e) => e.textContent.trim() === ${JSON.stringify(menu)})`, `menu ${menu}`);
  await clickAt(cdp, title.x, title.y);
  await waitFor(cdp, `document.querySelector('[role="menu"][aria-label=${JSON.stringify(menu)}]')`, `the ${menu} menu`, 5000);
  const target = await centreOf(
    cdp,
    `[...document.querySelectorAll('[role="menu"] .s7-menu-label')].find((e) => e.textContent.trim() === ${JSON.stringify(item)})?.closest("button")`,
    `${menu} > ${item}`,
  );
  if (target.disabled) throw new Error(`${menu} > ${item} is disabled`);
  await clickAt(cdp, target.x, target.y);
  await parkMouse(cdp);
}

/** Moves the pointer to an empty spot of the menu bar so no card part sees it. */
async function parkMouse(cdp: Cdp): Promise<void> {
  const width = await cdp.evaluate<number>("window.innerWidth");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: width - 4, y: 4 });
}

/** File > Open Showcase Stack..., the entry named `name`, Open, and Don't Save if asked. */
async function openShowcase(cdp: Cdp, name: string): Promise<void> {
  await clickMenuItem(cdp, "File", "Open Showcase Stack...");
  await waitFor(cdp, `document.querySelector(".s7-chooser-window")`, "the showcase chooser", 5000);
  const entry = await centreOf(
    cdp,
    `[...document.querySelectorAll(".s7-chooser-item")].find((e) => e.querySelector(".s7-chooser-name")?.textContent.trim() === ${JSON.stringify(name)})`,
    `showcase ${name}`,
  );
  await clickAt(cdp, entry.x, entry.y);
  const open = await centreOf(
    cdp,
    `[...document.querySelectorAll(".s7-chooser-window button")].find((e) => e.textContent.trim() === "Open")`,
    "the Open button",
  );
  await clickAt(cdp, open.x, open.y);
  await parkMouse(cdp);
  // The unsaved-changes question may appear (spec 04 Requirement 7.6); answer Don't Save.
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const button = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = [...document.querySelectorAll(".s7-dialog button")].find((e) => e.textContent.trim() === "Don't Save");
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    if (button !== null) {
      await clickAt(cdp, button.x, button.y);
      await parkMouse(cdp);
      break;
    }
    await sleep(100);
  }
}

interface ColourCounts {
  [hex: string]: number;
}

function countColours(rgba: Buffer): ColourCounts {
  const counts: ColourCounts = {};
  for (let i = 0; i < rgba.length; i += 4) {
    const hex =
      rgba[i + 3] === 255
        ? `#${[rgba[i], rgba[i + 1], rgba[i + 2]].map((v) => v.toString(16).toUpperCase().padStart(2, "0")).join("")}`
        : `#${[rgba[i], rgba[i + 1], rgba[i + 2]].map((v) => v.toString(16).toUpperCase().padStart(2, "0")).join("")}/alpha${rgba[i + 3]}`;
    counts[hex] = (counts[hex] ?? 0) + 1;
  }
  return counts;
}

function addCounts(into: ColourCounts, more: ColourCounts): void {
  for (const [hex, count] of Object.entries(more)) into[hex] = (into[hex] ?? 0) + count;
}

interface PixelDifference {
  differingPixels: number;
  pixels: { x: number; y: number; render: string; studio: string }[];
}

function comparePixels(render: Decoded, studio: Decoded): PixelDifference {
  const pixelHex = (image: Decoded, i: number): string => image.rgba.subarray(i * 4, i * 4 + 4).toString("hex");
  const pixels: PixelDifference["pixels"] = [];
  let count = 0;
  for (let i = 0; i < render.width * render.height; i++) {
    const a = pixelHex(render, i);
    const b = pixelHex(studio, i);
    if (a === b) continue;
    count++;
    if (pixels.length < PIXEL_LIST_LIMIT) pixels.push({ x: i % render.width, y: Math.floor(i / render.width), render: a, studio: b });
  }
  return { differingPixels: count, pixels };
}

interface CardResult {
  position: number;
  name: string;
  stackText: "auto-saved record" | "create() output";
  stable: boolean;
  renderedAs: string;
  compared: string;
  pixelsCompared: number;
  differingPixels: number;
  uncoveredCharacters: string[];
  screenshotColours: ColourCounts;
  foreignColours: string[];
  problems: string[];
  pixels?: PixelDifference["pixels"];
  images?: string[];
}

interface StackResult {
  id: string;
  name: string;
  theme: string;
  cardsCompared: number;
  cards: CardResult[];
  colours: ColourCounts;
  problems: string[];
}

interface ScaleResult {
  scale: number;
  viewport: { width: number; height: number };
  chromeVersion: string;
  stacks: StackResult[];
}

async function runCardPhase(
  chrome: string,
  outDir: string,
  scale: number,
  showcases: PresetsModule["SHOWCASE_STACKS"],
  server: PowerServer,
): Promise<ScaleResult> {
  const viewport = VIEWPORTS[scale];
  const preview = await startPreview(undefined);
  const profile = mkdtempSync(join(tmpdir(), "hexcard-chrome-profile-"));
  scratchFolders.push(profile);
  const running = await launchChrome(chrome, profile, viewport);
  const { cdp } = running;
  const result: ScaleResult = { scale, viewport, chromeVersion: running.version, stacks: [] };
  const shots = join(outDir, `scale-${scale}`);
  mkdirSync(join(shots, "screenshots"), { recursive: true });
  mkdirSync(join(shots, "server"), { recursive: true });
  try {
    await navigate(cdp, `${preview.origin}/`);
    await waitFor(cdp, `document.querySelector(${JSON.stringify(CANVAS_SELECTOR)})`, "the card canvas", 30_000);
    const box = await cdp.evaluate<{ width: number; height: number }>(
      `(() => { const b = document.querySelector(${JSON.stringify(CANVAS_SELECTOR)}).getBoundingClientRect(); return { width: b.width, height: b.height }; })()`,
    );
    if (box.width !== CARD_WIDTH * scale || box.height !== CARD_HEIGHT * scale) {
      throw new Error(`the card canvas is ${box.width} x ${box.height} CSS pixels, expected ${CARD_WIDTH * scale} x ${CARD_HEIGHT * scale} at UI scale ${scale}`);
    }
    for (let stackIndex = 0; stackIndex < showcases.length; stackIndex++) {
      const showcase = showcases[stackIndex];
      const created = showcase.create();
      const createdText = JSON.stringify(created);
      const stackResult: StackResult = {
        id: created.id,
        name: showcase.name,
        theme: created.themePalette.name,
        cardsCompared: 0,
        cards: [],
        colours: {},
        problems: [],
      };
      result.stacks.push(stackResult);
      const allowed = new Set([created.themePalette.lightBitHex.toUpperCase(), created.themePalette.darkBitHex.toUpperCase()]);
      try {
        if (stackIndex > 0) await openShowcase(cdp, showcase.name);
        await waitFor(cdp, `${canvasLabel} === ${JSON.stringify(`Card ${created.cards[0].name}`)}`, `the first card of ${showcase.name}`, 10_000);
      } catch (error) {
        stackResult.problems.push(`could not open the stack: ${describeError(error)}`);
        process.stdout.write(`  scale ${scale} ${showcase.name}: ${stackResult.problems[0]}\n`);
        continue;
      }
      for (let index = 0; index < created.cards.length; index++) {
        const position = index + 1;
        const card: CardResult = {
          position,
          name: created.cards[index].name,
          stackText: "create() output",
          stable: false,
          renderedAs: "",
          compared: scale === 1 ? "PNG against the canvas pixels" : "PNG against a canvas screenshot",
          pixelsCompared: 0,
          differingPixels: 0,
          uncoveredCharacters: [],
          screenshotColours: {},
          foreignColours: [],
          problems: [],
        };
        stackResult.cards.push(card);
        try {
          if (index > 0) await clickMenuItem(cdp, "Go", "Next");
          await waitFor(cdp, `${canvasLabel} === ${JSON.stringify(`Card ${card.name}`)}`, `card ${position} (${card.name})`, 10_000);
          await sleep(FIRST_READ_DELAY_MS);
          const canvasA = await cdp.evaluate<string>(READ_CANVAS);
          const recordA = await cdp.evaluate<string | null>(readRecordExpression(created.id));
          await sleep(SECOND_READ_DELAY_MS);
          const canvasB = await cdp.evaluate<string>(READ_CANVAS);
          const recordB = await cdp.evaluate<string | null>(readRecordExpression(created.id));
          card.stable = canvasA === canvasB && recordA === recordB;
          if (!card.stable) card.problems.push(`the two reads differ (canvas ${canvasA === canvasB ? "same" : "different"}, record ${recordA === recordB ? "same" : "different"})`);
          const stackText = recordB ?? createdText;
          card.stackText = recordB === null ? "create() output" : "auto-saved record";

          const label = `${created.id}-card${position}`;
          const rect = await cdp.evaluate<{ x: number; y: number; width: number; height: number }>(
            `(() => { const b = document.querySelector(${JSON.stringify(CANVAS_SELECTOR)}).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`,
          );
          const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
          const screenshotPng = Buffer.from(screenshot.data as string, "base64");
          writeFileSync(join(shots, "screenshots", `${label}.png`), screenshotPng);
          const shot = await decodePng(cdp, screenshotPng);
          card.screenshotColours = countColours(shot.rgba);
          card.foreignColours = Object.keys(card.screenshotColours).filter((hex) => !allowed.has(hex));
          addCounts(stackResult.colours, card.screenshotColours);
          if (shot.width !== CARD_WIDTH * scale || shot.height !== CARD_HEIGHT * scale) {
            card.problems.push(`the screenshot is ${shot.width} x ${shot.height}, expected ${CARD_WIDTH * scale} x ${CARD_HEIGHT * scale}`);
          }

          const rendered = await server.renderCard(stackText, position, scale);
          writeFileSync(join(shots, "server", `${label}.png`), rendered.png);
          const png = await decodePng(cdp, rendered.png);
          card.renderedAs = `${png.width} x ${png.height}`;
          card.uncoveredCharacters = (rendered.summary.uncoveredCharacters ?? []).map((entry) => `${entry.path} ${entry.character}`);

          let studio: Decoded;
          if (scale === 1) {
            studio = { width: CARD_WIDTH, height: CARD_HEIGHT, rgba: Buffer.from(canvasB, "base64") };
          } else {
            studio = shot;
          }
          if (png.width !== studio.width || png.height !== studio.height) {
            card.problems.push(`the PNG is ${png.width} x ${png.height}, the studio image ${studio.width} x ${studio.height}`);
          } else {
            const difference = comparePixels(png, studio);
            card.pixelsCompared = png.width * png.height;
            card.differingPixels = difference.differingPixels;
            if (difference.differingPixels > 0) {
              card.pixels = difference.pixels;
              const folder = join(shots, "differences");
              mkdirSync(folder, { recursive: true });
              writeFileSync(join(folder, `${label}-render_card.png`), encodeRgbaPng(png.width, png.height, png.rgba));
              writeFileSync(join(folder, `${label}-studio.png`), encodeRgbaPng(studio.width, studio.height, studio.rgba));
              card.images = [`scale-${scale}/differences/${label}-render_card.png`, `scale-${scale}/differences/${label}-studio.png`];
            }
          }
          stackResult.cardsCompared++;
        } catch (error) {
          card.problems.push(describeError(error));
        }
        const status = card.differingPixels === 0 && card.problems.length === 0 && card.foreignColours.length === 0 ? "equal" : "DIFFERS";
        process.stdout.write(`  scale ${scale} ${showcase.name} card ${position} (${card.name}): ${status}${card.problems.length > 0 ? ` - ${card.problems.join("; ")}` : ""}\n`);
      }
    }
    return result;
  } finally {
    await closeChrome(running);
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function parseArguments(argv: readonly string[]): { chrome: string } {
  let chrome = DEFAULT_CHROME;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--chrome") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--chrome needs a path");
      chrome = value;
    } else {
      throw new Error(`unknown argument ${argv[i]}; the only option is --chrome <path>`);
    }
  }
  return { chrome };
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
}

/** Runs the whole check; sets process.exitCode to 1 when anything differs or fails. */
export async function main(argv: readonly string[]): Promise<void> {
  const { chrome } = parseArguments(argv);
  if (!existsSync(chrome)) throw new Error(`no Chrome binary at ${chrome}; pass --chrome <path>`);
  if (!existsSync(join(REPO_ROOT, "dist", "index.html"))) throw new Error("dist/ is missing; run npm run build first");
  if (!existsSync(SERVER_FILE)) throw new Error("the server file is missing; run npm run build:power first");
  const started = new Date();
  const outDir = join(tmpdir(), `hexcard-power-check-${utcStamp(started)}`);
  mkdirSync(outDir, { recursive: true });
  process.stdout.write(`Output folder: ${outDir}\n`);

  const versionOutput = spawnSync(chrome, ["--version"], { encoding: "utf8" });
  const chromeVersionText = versionOutput.stdout.trim();

  let server: PowerServer | undefined;
  try {
    const textRaster = (await runnerImport<TextRasterModule>("./src/engine/graphics/textRaster.ts")).module;
    const nodeText = (await runnerImport<NodeTextModule>("./src/power/nodeTextBackend.ts")).module;
    const fontBytes = (await runnerImport<FontBytesModule>("./src/power/fontBytes.ts")).module;
    const presets = (await runnerImport<PresetsModule>("./src/presets/index.ts")).module;

    server = startPowerServer();
    await server.initialize();

    process.stdout.write("Text phase\n");
    const text = await runTextPhase(chrome, outDir, { textRaster, nodeText, fontBytes });

    const scales: ScaleResult[] = [];
    for (const scale of SCALES) {
      process.stdout.write(`Card phase, UI scale ${scale}\n`);
      scales.push(await runCardPhase(chrome, outDir, scale, presets.SHOWCASE_STACKS, server));
    }

    const colourTotals: Record<string, ColourCounts> = {};
    const differingCards: { scale: number; stack: string; position: number; name: string; differingPixels: number; uncoveredCharacters: string[]; problems: string[] }[] = [];
    let cardsCompared = 0;
    let failures = 0;
    for (const scaleResult of scales) {
      for (const stack of scaleResult.stacks) {
        const key = `scale ${scaleResult.scale} ${stack.name}`;
        colourTotals[key] = stack.colours;
        cardsCompared += stack.cardsCompared;
        if (stack.problems.length > 0) failures += stack.problems.length;
        for (const card of stack.cards) {
          const foreign = card.foreignColours.length > 0 ? [`colours outside the theme: ${card.foreignColours.join(", ")}`] : [];
          if (card.differingPixels > 0 || card.problems.length > 0 || foreign.length > 0) {
            differingCards.push({
              scale: scaleResult.scale,
              stack: stack.name,
              position: card.position,
              name: card.name,
              differingPixels: card.differingPixels,
              uncoveredCharacters: card.uncoveredCharacters,
              problems: [...card.problems, ...foreign],
            });
          }
        }
      }
    }
    const textDifferences = text.differences.length;
    const serverFileBytes = readFileSync(SERVER_FILE);
    const summary = {
      startedAt: started.toISOString(),
      outputFolder: outDir,
      chrome: { path: chrome, version: chromeVersionText, running: text.chromeVersion },
      node: process.version,
      serverFile: { path: "powers/hexcard/server/hexcard-mcp.mjs", bytes: serverFileBytes.length, sha256: createHash("sha256").update(serverFileBytes).digest("hex") },
      serverStderr: server.stderr,
      textPhase: {
        runLength: RUN_LENGTH,
        pairs: text.pairs,
        charactersCompared: text.pairs.reduce((sum, pair) => sum + pair.charactersCompared, 0),
        runsCompared: text.pairs.reduce((sum, pair) => sum + pair.runsCompared, 0),
        differingCases: textDifferences,
        differences: text.differences,
      },
      cardPhase: {
        scales: scales.map((scaleResult) => ({
          scale: scaleResult.scale,
          viewport: scaleResult.viewport,
          chromeVersion: scaleResult.chromeVersion,
          stacks: scaleResult.stacks.map((stack) => ({
            id: stack.id,
            name: stack.name,
            theme: stack.theme,
            cardsCompared: stack.cardsCompared,
            cards: stack.cards,
            colours: stack.colours,
            problems: stack.problems,
          })),
        })),
        cardsCompared,
        differingCards,
        colourCounts: colourTotals,
      },
    };
    writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

    const lines: string[] = [];
    lines.push("", "=== Summary ===", `Chrome: ${chromeVersionText}`, `Node: ${process.version}`);
    lines.push(`Server file: ${summary.serverFile.path}, ${summary.serverFile.bytes} bytes, sha256 ${summary.serverFile.sha256}`);
    lines.push("", "Text phase (characters alone / runs of 24 / differing cases), per font file and render size:");
    for (const pair of text.pairs) {
      lines.push(`  ${pair.file} @${pair.renderSize}px: ${pair.charactersCompared} / ${pair.runsCompared} / ${pair.differingCases}`);
    }
    lines.push(`  total: ${summary.textPhase.charactersCompared} characters, ${summary.textPhase.runsCompared} runs, ${textDifferences} differing cases`);
    lines.push("", "Card phase (cards compared / of cards in the stack), per stack and scale:");
    for (const scaleResult of scales) {
      for (const stack of scaleResult.stacks) {
        lines.push(`  scale ${scaleResult.scale} ${stack.name}: ${stack.cardsCompared} / ${stack.cards.length}`);
      }
    }
    lines.push(`  total: ${cardsCompared} cards compared`);
    lines.push("", "Screenshot colour counts (pixels per colour, all cards of the stack):");
    for (const [key, counts] of Object.entries(colourTotals)) {
      lines.push(`  ${key}: ${Object.entries(counts).map(([hex, count]) => `${hex} ${count}`).join(", ")}`);
    }
    lines.push("", `Differing text cases: ${textDifferences}`);
    for (const difference of text.differences.slice(0, 40)) {
      lines.push(`  ${difference.file} @${difference.renderSize}px ${difference.kind} ${difference.codePoints.slice(0, 3).join(" ")}${difference.codePoints.length > 3 ? " ..." : ""}: ${difference.differingPixels} pixels`);
    }
    if (text.differences.length > 40) lines.push(`  ... ${text.differences.length - 40} more in summary.json`);
    lines.push(`Differing or failed cards: ${differingCards.length}`);
    for (const card of differingCards) {
      lines.push(`  scale ${card.scale} ${card.stack} card ${card.position} (${card.name}): ${card.differingPixels} differing pixels${card.uncoveredCharacters.length > 0 ? `, uncovered ${card.uncoveredCharacters.join(", ")}` : ""}${card.problems.length > 0 ? `; ${card.problems.join("; ")}` : ""}`);
    }
    for (const scaleResult of scales) {
      for (const stack of scaleResult.stacks) for (const problem of stack.problems) lines.push(`  scale ${scaleResult.scale} ${stack.name}: ${problem}`);
    }
    lines.push("", `Summary written to ${join(outDir, "summary.json")}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    if (textDifferences > 0 || differingCards.length > 0 || failures > 0) process.exitCode = 1;
  } finally {
    if (server !== undefined) {
      server.child.stdin!.end();
      await stop(server.child);
    }
    for (const child of children) await stop(child);
    for (const folder of scratchFolders) rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
