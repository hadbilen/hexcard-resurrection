/**
 * Studio start-up order: fonts settle, then the UI mounts, then the stack is opened with
 * openStack, openBackground, openCard (spec 04 Requirement 2.7, spec 01 Requirement 2.9).
 */
import { describe, expect, it } from "vitest";
import { createMessageBus } from "../../core/messageBus.ts";
import { parseHexTalk } from "../../core/parser.ts";
import { createHexStore } from "../../core/store.ts";
import type { HexValue } from "../../core/vm.ts";
import { createStarterStack } from "../starterStack.ts";
import { startStudio } from "../startup.ts";
import { createModalManager } from "../System7Shell.tsx";
import { createVmHost } from "../vmHost.ts";

const logger = (name: string): string => [`on ${name}`, "  global log", `  put "${name}," after log`, `end ${name}`].join("\n");

function setup() {
  const stack = createStarterStack();
  stack.scriptSource = logger("openStack");
  stack.backgrounds[0].scriptSource = logger("openBackground");
  stack.cards[0].scriptSource = logger("openCard");
  const store = createHexStore({ stack, compile: parseHexTalk });
  const globals = new Map<string, HexValue>();
  let bus: ReturnType<typeof createMessageBus> | undefined;
  const host = createVmHost({ store, bus: () => bus!, dialogs: createModalManager() });
  bus = createMessageBus({
    store, host, globals,
    isPageVisible: () => true, isModalOpen: () => false,
    scheduleInterval: () => () => undefined,
    onError: () => undefined, warn: () => undefined,
  });
  const idle = async (): Promise<void> => {
    do await new Promise((resolve) => setTimeout(resolve, 0));
    while (bus!.isRunning() || bus!.pendingCount() > 0);
  };
  const steps: string[] = [];
  const log = (): string => String(globals.get("log") ?? "");
  return { bus, idle, steps, log };
}

describe("startStudio", () => {
  it("opens the stack only after the fonts have loaded and the UI has mounted", async () => {
    const { bus, idle, steps, log } = setup();
    let releaseFonts!: () => void;
    const started = startStudio({
      loadFonts: () => new Promise<void>((resolve) => {
        releaseFonts = () => {
          steps.push("fonts");
          resolve();
        };
      }),
      onFontError: () => steps.push("font error"),
      mount: async () => {
        steps.push(`mount (log "${log()}")`);
      },
      bus,
    });
    await idle();
    expect(steps).toEqual([]);
    expect(log()).toBe("");
    releaseFonts();
    await started;
    await idle();
    expect(steps).toEqual(["fonts", 'mount (log "")']);
    expect(log()).toBe("openStack,openBackground,openCard,");
  });

  it("still mounts and opens the stack when font loading rejects", async () => {
    const { bus, idle, steps, log } = setup();
    const failure = new Error("no fonts");
    const reported: unknown[] = [];
    await startStudio({
      loadFonts: () => Promise.reject(failure),
      onFontError: (error) => reported.push(error),
      mount: async () => {
        steps.push("mount");
      },
      bus,
    });
    await idle();
    expect(reported).toEqual([failure]);
    expect(steps).toEqual(["mount"]);
    expect(log()).toBe("openStack,openBackground,openCard,");
  });
});
