// Checks tool arguments against a tool's inputSchema (spec 07 Requirements 4.3, 4.5, 5.3, 11.10;
// design §argumentCheck.ts). The inputSchema objects are both what tools/list sends and what this
// checker interprets, so the listed schema and the enforced rules cannot drift apart.
// Pure TypeScript: no Node module, no DOM.

import { quoteText } from "./results.ts";

/** The JSON Schema subset the inputSchemas use. Unknown keywords are a programming error (the module throws). */
export type ArgSchema =
  | { type: "object"; properties: Record<string, ArgSchema>; required?: string[]; additionalProperties: false; description?: string }
  | { type: "array"; items: ArgSchema; minItems?: number; maxItems?: number; uniqueItems?: boolean; description?: string }
  | { type: "string"; minLength?: number; maxLength?: number; pattern?: string; enum?: string[]; const?: string; default?: string; description?: string }
  | { type: "integer"; minimum?: number; maximum?: number; enum?: number[]; default?: number; description?: string }
  | { type: "boolean"; default?: boolean; description?: string }
  | { anyOf: ArgSchema[]; description?: string } // branches of different JSON types
  | { oneOf: ArgSchema[]; description?: string }; // object branches told apart by a const "op"

export interface CheckOptions {
  /** Arguments whose maxLength is enforced by the tool as a read error instead. */
  readLimited?: readonly string[];
}

type ObjectSchema = Extract<ArgSchema, { type: "object" }>;
type ArraySchema = Extract<ArgSchema, { type: "array" }>;
type StringSchema = Extract<ArgSchema, { type: "string" }>;
type IntegerSchema = Extract<ArgSchema, { type: "integer" }>;
type Path = readonly (string | number)[];

/** The field that tells the object branches of a oneOf apart (design §Tool input schemas). */
const DISCRIMINATOR = "op";

const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  object: ["type", "properties", "required", "additionalProperties", "description"],
  array: ["type", "items", "minItems", "maxItems", "uniqueItems", "description"],
  string: ["type", "minLength", "maxLength", "pattern", "enum", "const", "default", "description"],
  integer: ["type", "minimum", "maximum", "enum", "default", "description"],
  boolean: ["type", "default", "description"],
  anyOf: ["anyOf", "description"],
  oneOf: ["oneOf", "description"],
};

/** `^[<literal characters>]+$`, the only pattern form the subset allows. */
const PATTERN_FORM = /^\^\[([^\]\\\-^]+)\]\+\$$/;

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaError(where: string, problem: string): Error {
  return new Error(`argumentCheck: schema at ${where} ${problem}`);
}

function kindOf(schema: ArgSchema): string {
  if ("anyOf" in schema) return "anyOf";
  if ("oneOf" in schema) return "oneOf";
  return schema.type;
}

const validatedSchemas = new WeakSet<object>();

/** Throws on any keyword or form outside the subset, at every depth (a programming error). */
function assertSchema(schema: ArgSchema, where: string): void {
  if (!isPlainObject(schema)) throw schemaError(where, "is not an object");
  const kind = kindOf(schema);
  const allowed = KEYWORDS[kind];
  if (allowed === undefined) throw schemaError(where, `has the unknown type ${String(kind)}`);
  for (const keyword of Object.keys(schema)) {
    if (!allowed.includes(keyword)) throw schemaError(where, `uses the unknown keyword ${keyword}`);
  }
  if ("anyOf" in schema) {
    schema.anyOf.forEach((branch, i) => assertSchema(branch, `${where}.anyOf[${i}]`));
  } else if ("oneOf" in schema) {
    schema.oneOf.forEach((branch, i) => {
      assertSchema(branch, `${where}.oneOf[${i}]`);
      if (discriminatorOf(branch) === undefined) {
        throw schemaError(`${where}.oneOf[${i}]`, `is not an object branch with a const ${DISCRIMINATOR}`);
      }
    });
  } else if (schema.type === "object") {
    if (schema.additionalProperties !== false) throw schemaError(where, "must set additionalProperties to false");
    for (const [name, property] of Object.entries(schema.properties)) assertSchema(property, `${where}.${name}`);
    for (const name of schema.required ?? []) {
      if (!hasOwn(schema.properties, name)) throw schemaError(where, `requires the undeclared property ${name}`);
    }
  } else if (schema.type === "array") {
    assertSchema(schema.items, `${where}.items`);
  } else if (schema.type === "string" && schema.pattern !== undefined && !PATTERN_FORM.test(schema.pattern)) {
    throw schemaError(where, `uses the unsupported pattern ${schema.pattern}`);
  }
}

function discriminatorOf(branch: ArgSchema): string | undefined {
  if ("anyOf" in branch || "oneOf" in branch || branch.type !== "object") return undefined;
  const op = branch.properties[DISCRIMINATOR];
  return op !== undefined && "type" in op && op.type === "string" ? op.const : undefined;
}

/** "commands[3].rows[1]" from ["commands", 3, "rows", 1]; "arguments" for the empty path. */
export function formatArgPath(path: readonly (string | number)[]): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out === "" ? key : `.${key}`;
  }
  return out === "" ? "arguments" : out;
}

/** "a", "a and b", "a, b and c". */
function listWords(words: readonly string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function rangeRule(min: number | undefined, max: number | undefined, unit: string): string | undefined {
  const suffix = unit === "" ? "" : ` ${unit}`;
  if (min !== undefined && max !== undefined) return `${min} to ${max}${suffix}`;
  if (max !== undefined) return `at most ${max}${suffix}`;
  if (min !== undefined) return `at least ${min}${suffix}`;
  return undefined;
}

/** A noun phrase for an anyOf branch, e.g. "an integer from 1 to 100000". */
function describe(schema: ArgSchema): string {
  if ("anyOf" in schema || "oneOf" in schema) return "a value";
  switch (schema.type) {
    case "integer": {
      if (schema.minimum !== undefined && schema.maximum !== undefined) {
        return `an integer from ${schema.minimum} to ${schema.maximum}`;
      }
      return "an integer";
    }
    case "string": {
      const length = rangeRule(schema.minLength, schema.maxLength, "characters");
      return length === undefined ? "a string" : `a string of ${length}`;
    }
    case "boolean":
      return "a boolean";
    case "array":
      return "an array";
    case "object":
      return "an object";
  }
}

class Checker {
  readonly errors: string[] = [];
  private readonly readLimited: ReadonlySet<string>;

  constructor(options: CheckOptions | undefined) {
    this.readLimited = new Set(options?.readLimited ?? []);
  }

  /**
   * The only argument text a message can hold is an unknown key, which checkObject quotes with
   * quoteText (Requirement 5.7). The rest is fixed text, so no shortenMessage pass is applied: its
   * rule (2) would cut a run such as "<77 characters>...:" and drop the ": " separator.
   */
  private push(path: Path, rule: string): void {
    this.errors.push(`${formatArgPath(path)}: ${rule}`);
  }

  check(schema: ArgSchema, value: unknown, path: Path, skipMaxLength = false): void {
    if ("anyOf" in schema) return this.checkAnyOf(schema.anyOf, value, path);
    if ("oneOf" in schema) return this.checkOneOf(schema.oneOf, value, path);
    switch (schema.type) {
      case "object":
        return this.checkObject(schema, value, path);
      case "array":
        return this.checkArray(schema, value, path);
      case "string":
        return this.checkString(schema, value, path, skipMaxLength);
      case "integer":
        return this.checkInteger(schema, value, path);
      case "boolean":
        if (typeof value !== "boolean") this.push(path, "must be a boolean");
        return;
    }
  }

  private checkObject(schema: ObjectSchema, value: unknown, path: Path): void {
    if (!isPlainObject(value)) return this.push(path, "must be an object");
    const unknownRule = path.length === 0 ? "is not an allowed argument" : "is not an allowed field";
    for (const key of Object.keys(value)) {
      // The key is argument text (Requirement 5.7).
      if (!hasOwn(schema.properties, key)) this.push([...path, quoteText(key)], unknownRule);
    }
    const required = schema.required ?? [];
    for (const [name, property] of Object.entries(schema.properties)) {
      if (hasOwn(value, name)) {
        const skip = path.length === 0 && this.readLimited.has(name);
        this.check(property, value[name], [...path, name], skip);
      } else if (required.includes(name)) {
        this.push([...path, name], "is required");
      }
    }
  }

  private checkArray(schema: ArraySchema, value: unknown, path: Path): void {
    if (!Array.isArray(value)) return this.push(path, "must be an array");
    const { minItems, maxItems } = schema;
    if ((minItems !== undefined && value.length < minItems) || (maxItems !== undefined && value.length > maxItems)) {
      this.push(path, `must have ${rangeRule(minItems, maxItems, "entries")}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<unknown>();
      let repeated = false;
      for (const item of value) {
        const key = typeof item === "object" && item !== null ? JSON.stringify(item) : item;
        if (seen.has(key)) repeated = true;
        seen.add(key);
      }
      if (repeated) {
        const last = path[path.length - 1];
        this.push(path, `must list each ${typeof last === "string" ? last : "entry"} at most once`);
      }
    }
    value.forEach((item, i) => this.check(schema.items, item, [...path, i]));
  }

  private checkString(schema: StringSchema, value: unknown, path: Path, skipMaxLength: boolean): void {
    if (typeof value !== "string") return this.push(path, "must be a string");
    if (schema.const !== undefined && value !== schema.const) this.push(path, `must be ${schema.const}`);
    if (schema.enum !== undefined && !schema.enum.includes(value)) this.push(path, `must be one of ${schema.enum.join(", ")}`);
    const maxLength = skipMaxLength ? undefined : schema.maxLength;
    const { minLength } = schema;
    // String.prototype.length: UTF-16 code units (requirements Glossary, "Characters").
    if ((minLength !== undefined && value.length < minLength) || (maxLength !== undefined && value.length > maxLength)) {
      this.push(path, `must have ${rangeRule(minLength, maxLength, "characters")}`);
    }
    if (schema.pattern !== undefined) {
      const allowed = [...(PATTERN_FORM.exec(schema.pattern)?.[1] ?? "")];
      let matches = value.length > 0;
      for (let i = 0; i < value.length && matches; i++) matches = allowed.includes(value[i]);
      if (!matches) this.push(path, `must contain only ${listWords(allowed)}`);
    }
  }

  private checkInteger(schema: IntegerSchema, value: unknown, path: Path): void {
    if (typeof value !== "number" || !Number.isInteger(value)) return this.push(path, "must be an integer");
    if (schema.enum !== undefined && !schema.enum.includes(value)) this.push(path, `must be one of ${schema.enum.join(", ")}`);
    const { minimum, maximum } = schema;
    if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
      const both = minimum !== undefined && maximum !== undefined;
      this.push(path, `must be ${both ? "from " : ""}${rangeRule(minimum, maximum, "")}`);
    }
  }

  private checkAnyOf(branches: readonly ArgSchema[], value: unknown, path: Path): void {
    for (const branch of branches) {
      const trial = new Checker(undefined);
      trial.check(branch, value, path);
      if (trial.errors.length === 0) return;
    }
    this.push(path, `must be ${branches.map(describe).join(" or ")}`);
  }

  private checkOneOf(branches: readonly ArgSchema[], value: unknown, path: Path): void {
    if (!isPlainObject(value)) return this.push(path, "must be an object");
    const names = branches.map((branch) => discriminatorOf(branch) as string);
    const op = value[DISCRIMINATOR];
    const index = typeof op === "string" && hasOwn(value, DISCRIMINATOR) ? names.indexOf(op) : -1;
    if (index < 0) return this.push([...path, DISCRIMINATOR], `must be one of ${names.join(", ")}`);
    this.check(branches[index], value, path);
  }
}

/** Every broken rule as "<path>: <rule>", in schema order. Empty when the value conforms. */
export function checkArguments(schema: ArgSchema, value: unknown, options?: CheckOptions): string[] {
  if (!validatedSchemas.has(schema)) {
    assertSchema(schema, "inputSchema");
    validatedSchemas.add(schema);
  }
  const checker = new Checker(options);
  checker.check(schema, value, []);
  return checker.errors;
}
