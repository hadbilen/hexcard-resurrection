/**
 * Spec 06 task 4.1: Message Box line classification and the runner (Requirements 3.1-3.8).
 */
import { describe, expect, it } from "vitest";
import {
  classifyMessageBoxLine,
  COMMAND_WORDS,
  createMessageBoxRunner,
  FIND_COMMAND_LABEL,
  FIND_USAGE,
  HANDLER_ONLY,
  MESSAGE_BOX_COMMAND,
  NOT_FOUND,
  messageBoxValueText,
  type MessageBoxIO,
} from "../messageBox.ts";
import { createMessageBus, resolveRelativeCard, type MessageBus } from "../messageBus.ts";
import { parseHexTalk } from "../parser.ts";
import type { HexFieldPart, HexStack } from "../schema.ts";
import { createHexStore, readFieldText, type HexStore } from "../store.ts";
import {
  createDispatchContext,
  MESSAGE_BOX_HANDLER,
  resolveObjectTarget,
  type DispatchContext,
  type EvaluatedCardTarget,
  type HexHost,
  type HexValue,
} from "../vm.ts";

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

describe("classifyMessageBoxLine", () => {
  it("treats blank and comment-only lines as empty (Requirement 3.1)", () => {
    for (const line of ["", "   ", "\t", "-- just a note", "  --x  "]) expect(classifyMessageBoxLine(line), JSON.stringify(line)).toEqual({ kind: "empty" });
  });

  it("parses one statement, after trimming the line (Requirement 3.2)", () => {
    const put = classifyMessageBoxLine('  put "brass lamp" into card field 1  ');
    expect(put.kind).toBe("statement");
    if (put.kind === "statement") expect(put.statement).toMatchObject({ kind: "PutValue", mode: "into", destination: { scope: "field", layer: "card" } });
    for (const line of ["go next", "get 3 * 4", "global x", "set the hilite of card button 1 to true", "put 1 into x -- note", "if x then put 1 into y", "exit repeat"]) {
      expect(classifyMessageBoxLine(line).kind, line).toBe("statement");
    }
  });

  it("parses one expression when the line is not a statement (Requirements 3.3, 3.8)", () => {
    const product = classifyMessageBoxLine("3 * 4");
    expect(product).toMatchObject({ kind: "expression", expression: { kind: "BinaryOp", op: "*" } });
    // A single word is a variable, never a message to send.
    expect(classifyMessageBoxLine("foo")).toMatchObject({ kind: "expression", expression: { kind: "Variable", name: "foo" } });
    expect(classifyMessageBoxLine("mouseUp")).toMatchObject({ kind: "expression", expression: { kind: "Variable" } });
    expect(classifyMessageBoxLine("the name of me").kind).toBe("expression");
    expect(classifyMessageBoxLine('"a" & "b"').kind).toBe("expression");
  });

  it("rejects pass and exit <handler>, which only work inside a handler", () => {
    for (const line of ["pass mouseUp", "pass hexmessagebox", "exit hexmessagebox", "exit mouseUp"]) {
      expect(classifyMessageBoxLine(line), line).toEqual({ kind: "error", message: HANDLER_ONLY, column: 1 });
    }
  });

  it("reports the expression error with its column in the line when the first word is not a command word (Requirement 3.5)", () => {
    expect(classifyMessageBoxLine("foo bar baz")).toEqual({ kind: "error", message: 'expected the end of the line but found "bar"', column: 5 });
    expect(classifyMessageBoxLine("  foo bar baz")).toMatchObject({ column: 5 }); // columns count from the trimmed line
    expect(classifyMessageBoxLine('"abc')).toMatchObject({ kind: "error", column: 1 });
  });

  it("reports the statement error for a command word, with the column mapped into the line", () => {
    expect(classifyMessageBoxLine("put 1 into")).toEqual({
      kind: "error", message: "expected a variable or a field but found the end of the line", column: 11,
    });
    expect(classifyMessageBoxLine("answer")).toMatchObject({ kind: "error", column: 7 });
    expect(classifyMessageBoxLine("put 1 into x put 2 into y")).toMatchObject({ kind: "error", column: 14 });
    // A block left open is reported at the end of the line, without naming the internal wrapper.
    const open = classifyMessageBoxLine("repeat 3");
    expect(open).toMatchObject({ kind: "error", column: 9 });
    if (open.kind === "error") expect(open.message).not.toContain("hexmessagebox");
  });

  it("classifies a line whose first word is find as a find command (Requirements 3.1, 4.2)", () => {
    expect(classifyMessageBoxLine('find "lamp"')).toEqual({ kind: "find", text: "lamp" });
    expect(classifyMessageBoxLine('  FIND   "brass lamp"   ')).toEqual({ kind: "find", text: "brass lamp" });
    expect(classifyMessageBoxLine('Find\t"x"')).toEqual({ kind: "find", text: "x" });
    expect(classifyMessageBoxLine('find ""')).toEqual({ kind: "find", text: "" });
    for (const line of ["find", "find lamp", 'find "lamp" x', 'find"lamp"', 'find "lamp', 'find "a"b"', "find 3 * 4", 'find whole "lamp"']) {
      expect(classifyMessageBoxLine(line), line).toEqual({ kind: "findUsage" });
    }
    // Only the whole first word counts.
    expect(classifyMessageBoxLine("finder").kind).toBe("expression");
  });

  it("never lets a line reach the wrapper's other lines", () => {
    // Line breaks count as spaces, so a second handler can never be declared.
    expect(classifyMessageBoxLine("put 1 into x\nend hexmessagebox\non mouseUp")).toMatchObject({ kind: "error" });
    expect(classifyMessageBoxLine("end hexmessagebox").kind).toBe("error");
    expect(classifyMessageBoxLine("on mouseUp")).toMatchObject({ kind: "error", column: 1 });
  });

  it("lists the command words of design spec §4.1", () => {
    expect([...COMMAND_WORDS].sort()).toEqual([
      "add", "answer", "ask", "divide", "exit", "fetch", "get", "global", "go", "if", "multiply", "next", "pass", "play",
      "put", "repeat", "set", "subtract", "visual", "wait",
    ]);
  });
});

describe("messageBoxValueText", () => {
  it("uses the VM's text conversion and shows each line break as one space (Requirement 3.4)", () => {
    expect(messageBoxValueText(12)).toBe("12");
    expect(messageBoxValueText(0.1 + 0.2)).toBe("0.3");
    expect(messageBoxValueText(true)).toBe("true");
    expect(messageBoxValueText("a\nb\r\nc\rd")).toBe("a b c d");
  });
});

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function field(id: string, name: string): HexFieldPart {
  return {
    id, name, type: "field", layerScope: "card", rect: { x: 10, y: 40, width: 200, height: 100 }, visible: true, enabled: true,
    scriptSource: "", style: "rectangle", content: "", sharedText: false, lockText: false, dontWrap: false, showLines: false,
    textAlign: "left", textFont: "System", textSize: 12, textStyle: [],
  };
}

function makeStack(cardScript = ""): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{ id: "bkg_1", name: "Main", bitmap: emptyBitmap, parts: [], scriptSource: "", cantDelete: false }],
    cards: [
      {
        id: "crd_1", name: "First", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [field("prt_f1", "Notes")],
        bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      },
      {
        id: "crd_2", name: "Second", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [field("prt_f2", "Notes")],
        bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: cardScript,
      },
    ],
    customIcons: {}, scriptSource: "",
  };
}

/** `go next` / `go prev` / ... or `go card id "..."` (enough for these tests). */
function cardTarget(store: HexStore, target: EvaluatedCardTarget): string {
  if (target.type !== "relative") return String(target.value);
  if (target.dir === "back") throw new Error("go back is not used here");
  return resolveRelativeCard(store.getSnapshot(), target.dir);
}

/** A store-backed VM host; `go` goes through the bus when one is given. */
function createHost(store: HexStore, bus?: () => MessageBus): HexHost {
  return {
    readField: (ref) => readFieldText(store.getSnapshot().stack, ref.cardId, ref.layer, ref.partId),
    applyRuntime: (m) => store.applyRuntime(m),
    resolveObject: (t, me) => resolveObjectTarget(store.getSnapshot(), t, me),
    goToCard: async (target, _effect, ctx) => {
      if (!bus) throw new Error("no bus");
      await bus().changeCard(cardTarget(store, target), ctx);
    },
    playSound: () => undefined,
    showAnswer: (_prompt, buttons) => Promise.resolve(buttons[0]),
    showAsk: (_prompt, answer) => Promise.resolve(answer),
    fetchJson: () => Promise.resolve({ ok: false, reason: "blocked url" }),
    now: () => ({ date: "1/1/26", time: "12:00 PM", ticks: 0, seconds: 0, mouseH: 0, mouseV: 0 }),
  };
}

/** Message Box I/O that records the alerts. */
function recordingIO(initial = ""): MessageBoxIO & { alerts: [string, readonly string[] | undefined][]; current: string } {
  const io = {
    current: initial,
    alerts: [] as [string, readonly string[] | undefined][],
    line: () => io.current,
    setLine: (line: string) => void (io.current = line),
    alert: (message: string, details?: readonly string[]) => void io.alerts.push([message, details]),
  };
  return io;
}

/** A bus that queues command tasks; `drain` runs them in order on fresh dispatch contexts. */
function recordingBus(globals: Map<string, HexValue>, store?: HexStore) {
  const queued: { label: string; task: (ctx: DispatchContext) => Promise<void> }[] = [];
  const changes: string[] = [];
  return {
    queued,
    changes,
    runCommand: (label: string, task: (ctx: DispatchContext) => Promise<void>) => void queued.push({ label, task }),
    changeCard: async (target: unknown) => {
      if (typeof target !== "string") throw new Error("go back is not used here");
      changes.push(target);
      store?.applyRuntime({ type: "goToCard", cardId: target });
    },
    async drain(): Promise<DispatchContext[]> {
      const contexts: DispatchContext[] = [];
      for (let entry = queued.shift(); entry; entry = queued.shift()) {
        const ctx = createDispatchContext({ abortSignal: new AbortController().signal, globals });
        contexts.push(ctx);
        await entry.task(ctx);
      }
      return contexts;
    },
  };
}

function recordingSetup(initialLine = "") {
  const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
  const globals = new Map<string, HexValue>();
  const bus = recordingBus(globals, store);
  const io = recordingIO(initialLine);
  const sounds: [string, number, string][] = [];
  const host: HexHost = { ...createHost(store), playSound: (voice, tempo, notesText) => void sounds.push([voice, tempo, notesText]) };
  const run = createMessageBoxRunner({ store, bus, host, io });
  return { store, globals, bus, io, run, sounds };
}

const notes = (store: HexStore, cardId: string, partId: string): string => readFieldText(store.getSnapshot().stack, cardId, "card", partId);

describe("createMessageBoxRunner", () => {
  it("runs nothing for an empty line and alerts the parser message with its column for an invalid one", async () => {
    const { bus, io, run } = recordingSetup("foo bar baz");
    run("   ");
    run("-- note");
    expect(bus.queued).toEqual([]);
    run("foo bar baz");
    expect(bus.queued).toEqual([]);
    expect(io.alerts).toEqual([['expected the end of the line but found "bar"', ["Column 5"]]]);
    expect(io.current).toBe("foo bar baz"); // the line is kept
    run("pass mouseUp");
    expect(io.alerts[1]).toEqual([HANDLER_ONLY, ["Column 1"]]);
  });

  it("runs a statement in one queued command dispatch and keeps the line (Requirement 3.2)", async () => {
    const line = 'put "brass lamp" into card field 1';
    const { store, bus, io, run } = recordingSetup(line);
    run(line);
    expect(bus.queued.map((entry) => entry.label)).toEqual([MESSAGE_BOX_COMMAND]);
    expect(notes(store, "crd_1", "prt_f1")).toBe(""); // nothing runs before the dispatch starts
    await bus.drain();
    expect(notes(store, "crd_1", "prt_f1")).toBe("brass lamp");
    expect(io.current).toBe(line);
    expect(io.alerts).toEqual([]);
  });

  it("runs against the card that is current when the dispatch starts, not when Return was pressed", async () => {
    const { store, bus, run } = recordingSetup();
    run('put "here" into card field 1');
    run("the name of this card");
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    await bus.drain();
    expect(notes(store, "crd_1", "prt_f1")).toBe("");
    expect(notes(store, "crd_2", "prt_f2")).toBe("here");
  });

  it("replaces the line with the value of an expression unless the user changed it meanwhile (Requirement 3.4)", async () => {
    const changed = recordingSetup("3 * 4");
    changed.run("3 * 4");
    await changed.bus.drain();
    expect(changed.io.current).toBe("12");

    const card = recordingSetup("the name of this card");
    card.run("the name of this card");
    card.store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    await card.bus.drain();
    expect(card.io.current).toBe("Second");

    const edited = recordingSetup("3 * 4");
    edited.run("3 * 4");
    edited.io.current = "3 * 5"; // typed after Return, before the dispatch ran
    await edited.bus.drain();
    expect(edited.io.current).toBe("3 * 5");

    // The comparison is with the untrimmed line that was submitted.
    const padded = recordingSetup("  1 + 1 ");
    padded.run("  1 + 1 ");
    await padded.bus.drain();
    expect(padded.io.current).toBe("2");
  });

  it("keeps variables as globals across lines (Requirement 3.7)", async () => {
    const { globals, bus, io, run } = recordingSetup();
    run("put 5 into x");
    run("get x * 2");
    await bus.drain();
    expect(globals.get("x")).toBe(5);
    expect(globals.get("it")).toBe(10);
    io.current = "x + it";
    run("x + it");
    await bus.drain();
    expect(io.current).toBe("15");
  });
});

describe("find commands in the Message Box (Requirements 4.2, 4.3, 4.6-4.11)", () => {
  const setText = (store: HexStore, cardId: string, partId: string, text: string): void =>
    store.applyRuntime({ type: "setFieldText", cardId, layer: "card", partId, text });

  it("alerts the usage for a malformed find command and queues nothing", () => {
    const { bus, io, run } = recordingSetup('find lamp');
    run("find lamp");
    expect(io.alerts).toEqual([[FIND_USAGE, undefined]]);
    expect(bus.queued).toEqual([]);
    expect(io.current).toBe("find lamp");
  });

  it("searches nothing for an empty text: card, found text and line unchanged (Requirement 4.3)", () => {
    const { store, bus, io, run } = recordingSetup('find ""');
    const before = store.getSnapshot();
    run('find ""');
    expect(bus.queued).toEqual([]);
    expect(io.alerts).toEqual([]);
    expect(io.current).toBe('find ""');
    expect(store.getSnapshot()).toBe(before);
  });

  it("goes to the match on another card in one Find dispatch and sets the found text (Requirements 4.7, 4.8)", async () => {
    const { store, bus, io, run, sounds } = recordingSetup('find "lamp"');
    setText(store, "crd_2", "prt_f2", "a brass lamp");
    const stackBefore = store.getSnapshot().stack;
    run('find "lamp"');
    expect(bus.queued.map((entry) => entry.label)).toEqual([FIND_COMMAND_LABEL]);
    expect(store.getSnapshot().currentCardId).toBe("crd_1"); // nothing before the dispatch starts
    await bus.drain();
    expect(bus.changes).toEqual(["crd_2"]);
    expect(store.getSnapshot()).toMatchObject({
      currentCardId: "crd_2",
      found: { cardId: "crd_2", layer: "card", partId: "prt_f2", start: 8, end: 12, text: "a brass lamp" },
    });
    expect(store.getSnapshot().stack).toBe(stackBefore); // Requirement 4.12
    expect(io.current).toBe('find "lamp"');
    expect(sounds).toEqual([]);
  });

  it("finds on the current card without a card change, then the next match, wrapping around (Requirement 4.6)", async () => {
    const { store, bus, run } = recordingSetup();
    setText(store, "crd_1", "prt_f1", "lamp oil");
    setText(store, "crd_2", "prt_f2", "Lamp");
    const found = () => store.getSnapshot().found && [store.getSnapshot().found!.cardId, store.getSnapshot().found!.start];
    run('find "lamp"');
    await bus.drain();
    expect(bus.changes).toEqual([]);
    expect(found()).toEqual(["crd_1", 0]);
    run('find "LAMP"');
    await bus.drain();
    expect(found()).toEqual(["crd_2", 0]);
    run('find "lamp"');
    await bus.drain();
    expect(found()).toEqual(["crd_1", 0]);
    expect(bus.changes).toEqual(["crd_2", "crd_1"]);
  });

  it("plays one click, shows Not found., clears the found text and stays on the card when nothing matches (Requirement 4.11)", async () => {
    const { store, bus, io, run, sounds } = recordingSetup('find "zzz"');
    setText(store, "crd_1", "prt_f1", "brass lamp");
    run('find "lamp"');
    await bus.drain();
    expect(store.getSnapshot().found).not.toBeNull();
    io.current = 'find "zzz"';
    run('find "zzz"');
    await bus.drain();
    expect(sounds).toEqual([["click", 120, ""]]);
    expect(io.current).toBe(NOT_FOUND);
    expect(store.getSnapshot()).toMatchObject({ currentCardId: "crd_1", found: null });

    // The line is not replaced when the user changed it meanwhile.
    io.current = 'find "zzz"';
    run('find "zzz"');
    io.current = "something else";
    await bus.drain();
    expect(io.current).toBe("something else");
  });

  it("sets no found text when the field changed while the dispatch went to the card", async () => {
    const { store, bus, run } = recordingSetup();
    setText(store, "crd_2", "prt_f2", "lamp");
    bus.changeCard = async (target: unknown) => {
      store.applyRuntime({ type: "goToCard", cardId: target as string });
      setText(store, "crd_2", "prt_f2", "an openCard handler wrote this"); // as an openCard handler could
    };
    run('find "lamp"');
    await bus.drain();
    expect(store.getSnapshot()).toMatchObject({ currentCardId: "crd_2", found: null });
  });
});

describe("Message Box lines on the real message bus", () => {
  function realSetup(cardScript: string) {
    const store = createHexStore({ stack: makeStack(cardScript), compile: parseHexTalk });
    const errors: { error: unknown; name: string }[] = [];
    let bus: MessageBus | undefined;
    const host = createHost(store, () => bus!);
    bus = createMessageBus({
      store, host, isPageVisible: () => true, isModalOpen: () => false, scheduleInterval: () => () => {}, warn: () => {},
      onError: (error, message) => void errors.push({ error, name: message.name }),
    });
    const io = recordingIO();
    const run = createMessageBoxRunner({ store, bus, host, io });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { store, bus, io, run, errors, settle };
  }

  it("shares globals with handlers that declare them, in both directions (Requirement 3.7)", async () => {
    const script = ["on openCard", "  global x, seen", "  put x into seen", "  put \"from handler\" into x", "end openCard"].join("\n");
    const { store, io, run, errors, settle } = realSetup(script);
    run("put 7 into x");
    run("go next");
    await settle();
    expect(errors).toEqual([]);
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    io.current = "seen && x";
    run("seen && x");
    await settle();
    expect(io.current).toBe("7 from handler");
  });

  it("reports an error in the line as a Message Box error, and one in a triggered handler with that handler's location (Requirement 3.9)", async () => {
    const script = ["on openCard", "  put 1 / 0 into y", "end openCard"].join("\n");
    const { run, errors, settle } = realSetup(script);
    run('put "x" + 1 into y');
    await settle();
    run("go next");
    await settle();
    expect(errors.map(({ name }) => name)).toEqual([MESSAGE_BOX_COMMAND, MESSAGE_BOX_COMMAND]);
    expect(errors[0].error).toMatchObject({ objectId: "crd_1", handler: MESSAGE_BOX_HANDLER, line: 1 });
    expect(errors[1].error).toMatchObject({ objectId: "crd_2", handler: "openCard", line: 2, message: "Division by zero" });
  });

  it("is aborted like any dispatch: Cmd/Ctrl+. stops a waiting line (Requirement 3.6)", async () => {
    const { bus, io, run, errors, settle } = realSetup("");
    run("repeat forever");
    expect(io.alerts).toHaveLength(1); // an open block on one line: an alert, no dispatch
    expect(bus.isRunning()).toBe(false);
    run("wait 10 seconds");
    expect(bus.isRunning()).toBe(true);
    bus.abort();
    await settle();
    expect(bus.isRunning()).toBe(false);
    expect(errors).toEqual([]);
  });
});
