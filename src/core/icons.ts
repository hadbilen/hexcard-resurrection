/**
 * 32x32 1-bit button icons: data format, names and the icon history commands.
 * Design: .kiro/specs/06-hypercard-classics/design.md §icons.ts. Requirements 8.1–8.5, 10.4–10.10.
 *
 * Icon data (Requirement 8.1): 128 bytes, 32 rows of 4 bytes, row-major from the top row, the most
 * significant bit of each byte the leftmost of its 8 pixels, 1 = dark, as padded standard Base64:
 * 172 characters, the last data character with its two unused bits zero, then one "=".
 *
 * Commands:
 * - Names are fixed when a factory runs, so Redo recreates the same names.
 * - `apply` throws `HexMutationError` when its precondition fails on the stack it receives, so the
 *   history does not record the command. A command that would change nothing returns its input.
 * - `apply` records the `customIcons` object and every button it replaces; `revert` puts back
 *   exactly those objects. A button changed since (by a runtime mutation) only gets its `iconId` back.
 * - `customIcons` keys keep their order; `iconId` is removed as a key, never set to undefined.
 * - Lookups use `Object.hasOwn`, so names like `constructor` never reach `Object.prototype`.
 *
 * Pure TypeScript: no React, DOM or `src/engine/` imports. `btoa` / `atob` exist in Node 16+.
 */
import type { HexCommand } from "./history.ts";
import type { HexButtonPart, HexID, HexPart, HexStack } from "./schema.ts";
import { HexMutationError } from "./store.ts";

export const ICON_SIZE = 32;
export const ICON_PIXELS = 1024;          // 32 x 32
export const ICON_BYTES = 128;            // 32 rows x 4 bytes
export const ICON_DATA_LENGTH = 172;      // padded standard Base64 of 128 bytes
/** Requirement 8.1: 171 Base64 characters, the last with its 2 unused bits zero, then one "=". */
export const ICON_DATA_PATTERN = /^[A-Za-z0-9+/]{170}[AEIMQUYcgkosw048]=$/;
export const ICON_NAME_MAX = 32;

const ICON_NAME_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]{0,30}[\x21-\x7e])?$/;

export const ICON_NAME_INVALID =
  "Icon names have 1 to 32 letters, digits, spaces or ASCII punctuation, without spaces at the ends.";
export const iconNameTaken = (name: string): string => `An icon named "${name}" already exists.`;

export function isIconData(value: string): boolean {
  return ICON_DATA_PATTERN.test(value);
}

/** Requirement 8.2: 1-32 chars of U+0020-U+007E, no leading/trailing space, not "__proto__". */
export function isIconName(name: string): boolean {
  return ICON_NAME_PATTERN.test(name) && name !== "__proto__";
}

/** `pixels`: 1024 entries, row-major from the top-left, 1 = dark, 0 = clear. Throws on other lengths or values. */
export function encodeIcon(pixels: Uint8Array): string {
  if (pixels.length !== ICON_PIXELS) throw new RangeError(`An icon has ${ICON_PIXELS} pixels, got ${pixels.length}`);
  const bytes = new Uint8Array(ICON_BYTES);
  for (let i = 0; i < ICON_PIXELS; i++) {
    const value = pixels[i];
    if (value === 1) bytes[i >> 3] |= 0x80 >> (i & 7);
    else if (value !== 0) throw new RangeError(`Icon pixel ${i} must be 0 or 1, got ${value}`);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Inverse of encodeIcon. Throws on a value that is not icon data. */
export function decodeIcon(data: string): Uint8Array {
  if (!isIconData(data)) throw new RangeError("Not icon data: expected 172 characters of canonical padded Base64");
  const binary = atob(data);
  const pixels = new Uint8Array(ICON_PIXELS);
  for (let i = 0; i < ICON_PIXELS; i++) pixels[i] = (binary.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
  return pixels;
}

/** 32 rows of 32 characters, "#" = dark, "." = clear (built-in icon art). Throws on any other shape. */
export function iconFromRows(rows: readonly string[]): string {
  if (rows.length !== ICON_SIZE) throw new RangeError(`An icon has ${ICON_SIZE} rows, got ${rows.length}`);
  const pixels = new Uint8Array(ICON_PIXELS);
  rows.forEach((row, y) => {
    if (!/^[#.]{32}$/.test(row)) throw new RangeError(`Icon row ${y} must be 32 characters of "#" and "."`);
    for (let x = 0; x < ICON_SIZE; x++) pixels[y * ICON_SIZE + x] = row[x] === "#" ? 1 : 0;
  });
  return encodeIcon(pixels);
}

export const BLANK_ICON: string = "A".repeat(ICON_DATA_LENGTH - 1) + "=";

function lowerSet(names: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const name of names) set.add(name.toLowerCase());
  return set;
}

/** `${base} N` shortened to at most 32 characters. */
function numbered(base: string, n: number): string {
  const suffix = ` ${n}`;
  return base.slice(0, Math.max(0, ICON_NAME_MAX - suffix.length)) + suffix;
}

/** `base` if free, else `${base} N` with the lowest free N >= first, base shortened to fit 32 chars; case-insensitive. */
export function freeIconName(base: string, taken: Iterable<string>, first = 2): string {
  const used = lowerSet(taken);
  if (!used.has(base.toLowerCase())) return base;
  for (let n = first; ; n++) {
    const candidate = numbered(base, n);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** Why `name` cannot become a stack icon name (Requirement 10.6), or undefined. `except` is the icon being renamed. */
export function iconNameError(stack: HexStack, name: string, except?: string): string | undefined {
  if (!isIconName(name)) return ICON_NAME_INVALID;
  const lower = name.toLowerCase();
  const clash = Object.keys(stack.customIcons).some((key) => key !== except && key.toLowerCase() === lower);
  return clash ? iconNameTaken(name) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Icon commands (Requirements 8.4, 10.3–10.10)
// ---------------------------------------------------------------------------------------------

/** Every icon command. `name` is the stack icon to select after apply. */
export interface IconCommand extends HexCommand { readonly name?: string }

type Icons = Record<string, string>;

/** What one icon command does to a stack: the new icon table and the new iconId of each button. */
interface IconChange {
  icons: Icons;
  /** The button's new iconId (undefined removes it); return `button.iconId` to keep it. */
  iconIdOf?: (button: HexButtonPart) => string | undefined;
}

interface Applied {
  icons: { before: Icons; after: Icons };
  buttons: Map<HexID, { before: HexButtonPart; after: HexButtonPart }>;
}

function hasIcon(icons: Icons, name: string): boolean {
  return Object.hasOwn(icons, name);
}

function hasIconIgnoringCase(icons: Icons, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(icons).some((key) => key.toLowerCase() === lower);
}

/** A null-safe icon table built from entries (no prototype setter is ever involved). */
function iconTable(entries: Iterable<readonly [string, string]>): Icons {
  return Object.fromEntries(entries);
}

function withIconId(button: HexButtonPart, iconId: string | undefined): HexButtonPart {
  if (iconId === undefined) {
    const { iconId: _removed, ...rest } = button;
    return rest;
  }
  return { ...button, iconId };
}

/** Maps every part of every card and background; keeps untouched arrays and owners. */
function mapParts(stack: HexStack, map: (part: HexPart) => HexPart): HexStack {
  const mapOwner = <T extends { parts: HexPart[] }>(owner: T): T => {
    let changed = false;
    const parts = owner.parts.map((part) => {
      const next = map(part);
      if (next !== part) changed = true;
      return next;
    });
    return changed ? { ...owner, parts } : owner;
  };
  const backgrounds = stack.backgrounds.map(mapOwner);
  const cards = stack.cards.map(mapOwner);
  const backgroundsChanged = backgrounds.some((b, i) => b !== stack.backgrounds[i]);
  const cardsChanged = cards.some((c, i) => c !== stack.cards[i]);
  if (!backgroundsChanged && !cardsChanged) return stack;
  return {
    ...stack,
    ...(backgroundsChanged ? { backgrounds } : {}),
    ...(cardsChanged ? { cards } : {}),
  };
}

function iconCommand(label: string, name: string | undefined, change: (stack: HexStack) => IconChange | null): IconCommand {
  let applied: Applied | undefined;
  return {
    label,
    ...(name === undefined ? {} : { name }),
    apply(target) {
      const result = change(target);
      if (result === null) return target;
      const buttons: Applied["buttons"] = new Map();
      const { iconIdOf } = result;
      let next = iconIdOf
        ? mapParts(target, (part) => {
          if (part.type !== "button") return part;
          const iconId = iconIdOf(part);
          if (iconId === part.iconId) return part;
          const after = withIconId(part, iconId);
          buttons.set(part.id, { before: part, after });
          return after;
        })
        : target;
      if (result.icons !== target.customIcons) next = { ...next, customIcons: result.icons };
      if (next === target) return target;
      applied = { icons: { before: target.customIcons, after: result.icons }, buttons };
      return next;
    },
    revert(target) {
      if (!applied) throw new HexMutationError(`${label} has not been applied`);
      const { icons, buttons } = applied;
      let next = buttons.size === 0
        ? target
        : mapParts(target, (part) => {
          const record = part.type === "button" ? buttons.get(part.id) : undefined;
          if (!record || part.type !== "button") return part;
          if (part === record.after) return record.before;
          return part.iconId === record.before.iconId ? part : withIconId(part, record.before.iconId);
        });
      if (target.customIcons !== icons.before) next = { ...next, customIcons: icons.before };
      return next;
    },
  };
}

function requireIcon(icons: Icons, name: string): void {
  if (!hasIcon(icons, name)) throw new HexMutationError(`No icon named "${name}" in customIcons`);
}

function requireFreeName(icons: Icons, name: string): void {
  if (!isIconName(name)) throw new HexMutationError(`"${name}" is not an icon name`);
  if (hasIconIgnoringCase(icons, name)) throw new HexMutationError(`An icon named "${name}" already exists`);
}

function requireIconData(data: string): void {
  if (!isIconData(data)) throw new HexMutationError("Not icon data");
}

/** Requirement 10.4: "Icon N", the lowest N >= 1 whose name is free (case-insensitive). */
export function createNewIconCommand(stack: HexStack): IconCommand {
  const used = lowerSet(Object.keys(stack.customIcons));
  let n = 1;
  while (used.has(`icon ${n}`)) n++;
  const name = `Icon ${n}`;
  return iconCommand("New Icon", name, (target) => {
    requireFreeName(target.customIcons, name);
    return { icons: iconTable([...Object.entries(target.customIcons), [name, BLANK_ICON]]) };
  });
}

/** Requirements 10.5, 10.8: a copy of `data` under `freeIconName(base, keys, first)`. */
export function createCopyIconCommand(
  stack: HexStack,
  base: string,
  data: string,
  label: "Duplicate Icon" | "Add Icon",
  first: 1 | 2,
): IconCommand {
  requireIconData(data);
  const name = freeIconName(base, Object.keys(stack.customIcons), first);
  if (!isIconName(name)) throw new HexMutationError(`"${name}" is not an icon name`);
  return iconCommand(label, name, (target) => {
    requireFreeName(target.customIcons, name);
    return { icons: iconTable([...Object.entries(target.customIcons), [name, data]]) };
  });
}

/** Requirement 10.6: renames the icon in place and every iconId that names it. */
export function createRenameIconCommand(stack: HexStack, from: string, to: string): IconCommand {
  requireIcon(stack.customIcons, from);
  const error = iconNameError(stack, to, from);
  if (error) throw new HexMutationError(error);
  return iconCommand("Rename Icon", to, (target) => {
    requireIcon(target.customIcons, from);
    if (from === to) return null;
    if (iconNameError(target, to, from)) throw new HexMutationError(`"${to}" cannot be used as an icon name`);
    return {
      icons: iconTable(Object.entries(target.customIcons).map(([key, value]) => [key === from ? to : key, value] as const)),
      iconIdOf: (button) => (button.iconId === from ? to : button.iconId),
    };
  });
}

/** Requirement 10.7: removes the icon and the iconId of every button that names it. */
export function createDeleteIconCommand(stack: HexStack, name: string): IconCommand {
  requireIcon(stack.customIcons, name);
  return iconCommand("Delete Icon", undefined, (target) => {
    requireIcon(target.customIcons, name);
    return {
      icons: iconTable(Object.entries(target.customIcons).filter(([key]) => key !== name)),
      iconIdOf: (button) => (button.iconId === name ? undefined : button.iconId),
    };
  });
}

/** Requirement 10.3: replaces the data of `name`, which must still be `before`. */
export function createEditIconCommand(name: string, before: string, after: string): IconCommand {
  requireIconData(before);
  requireIconData(after);
  return iconCommand("Edit Icon", name, (target) => {
    requireIcon(target.customIcons, name);
    if (target.customIcons[name] !== before) throw new HexMutationError(`Icon "${name}" has changed since the edit began`);
    if (before === after) return null;
    return { icons: iconTable(Object.entries(target.customIcons).map(([key, value]) => [key, key === name ? after : value] as const)) };
  });
}

function findButton(stack: HexStack, partId: HexID): HexButtonPart | undefined {
  for (const owner of [...stack.backgrounds, ...stack.cards]) {
    const part = owner.parts.find((candidate) => candidate.id === partId);
    if (part) return part.type === "button" ? part : undefined;
  }
  return undefined;
}

/** "Set Icon" (iconId, copying `add` into customIcons first when given) or "Remove Icon" (iconId undefined). */
export function createButtonIconCommand(
  stack: HexStack,
  partId: HexID,
  iconId: string | undefined,
  add?: { name: string; data: string },
): IconCommand {
  if (!findButton(stack, partId)) throw new HexMutationError(`No button with id "${partId}"`);
  if (add) {
    if (iconId !== add.name) throw new HexMutationError("The added icon must be the icon that is set");
    requireIconData(add.data);
    requireFreeName(stack.customIcons, add.name);
  } else if (iconId !== undefined) {
    requireIcon(stack.customIcons, iconId);
  }
  return iconCommand(iconId === undefined ? "Remove Icon" : "Set Icon", iconId, (target) => {
    const button = findButton(target, partId);
    if (!button) throw new HexMutationError(`No button with id "${partId}"`);
    let icons = target.customIcons;
    if (add) {
      requireFreeName(icons, add.name);
      icons = iconTable([...Object.entries(icons), [add.name, add.data]]);
    } else if (iconId !== undefined) {
      requireIcon(icons, iconId);
      if (button.iconId === iconId) return null;
    } else if (button.iconId === undefined) {
      return null;
    }
    return { icons, iconIdOf: (part) => (part.id === partId ? iconId : part.iconId) };
  });
}
