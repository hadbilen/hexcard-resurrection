/**
 * Deterministic HexTalk AST (HexScriptAST).
 * Canonical contract: hexcard_design_spec.md §4.2. Keep the AST types identical to that section;
 * on any conflict the design spec wins.
 *
 * ASTs are never persisted (see schema.ts). They are produced by `parseHexTalk` or by the AI tiers
 * (after `validateAst` in astValidator.ts) and live only in memory.
 */
import type { VisualEffectType, VisualEffectSpeed } from "./schema.ts";

/** A compile error reported by `parseHexTalk`; stored per object in the store's ScriptCache. */
export interface HexCompileError {
  line: number;   // 1-based
  column: number; // 1-based
  message: string;
}

export interface HexSourceLoc { line: number; column: number } // 1-based; ignored by AST equality

export interface HexScriptAST {
  handlers: Record<string, HexHandlerNode>; // keys are lowercase event names, e.g. "mouseup", "opencard"
}

export interface HexHandlerNode {
  eventName: string;                        // original spelling, e.g. "mouseUp"
  params: string[];                         // lowercase
  body: HexStatementNode[];
  loc?: HexSourceLoc;
}

export type HexVoice = "harpsichord" | "boing" | "flute" | "square8bit" | "click";

export type HexPropertyName =
  | "name" | "visible" | "enabled" | "hilite" | "title" | "showName" | "autoHilite"
  | "location" | "rect" | "style" | "lockText" | "textAlign" | "textFont" | "textSize"
  | "textStyle" | "marked";

/** number => 1-based position within the layer (or stack for cards), anything else => name */
export type HexPartSelector =
  | { by: "id"; value: HexExprNode }
  | { by: "auto"; value: HexExprNode };

export type HexCardTarget =
  | { type: "relative"; dir: "next" | "prev" | "first" | "last" | "back" }
  | { type: "id"; value: HexExprNode }
  | { type: "auto"; value: HexExprNode };

export type HexContainerTarget =
  | { scope: "variable"; name: string }     // lowercase; "it" is the handler-local result variable
  | { scope: "field"; layer: "card" | "background"; selector: HexPartSelector };

export type HexObjectTarget =
  | { objectType: "me" }
  | { objectType: "button" | "field"; layer: "card" | "background"; selector: HexPartSelector }
  | { objectType: "card"; selector?: HexPartSelector } // omitted selector = this card
  | { objectType: "background" }                      // this background
  | { objectType: "stack" };                          // this stack

export type HexRepeatHead =
  | { type: "forever" }
  | { type: "count"; times: HexExprNode }
  | { type: "while"; condition: HexExprNode }
  | { type: "until"; condition: HexExprNode }
  | { type: "range"; varName: string; start: HexExprNode; end: HexExprNode; direction: "up" | "down" };

export type HexStatementNode = (
  | { kind: "GoToCard"; target: HexCardTarget }
  | { kind: "QueueVisualEffect"; effect: VisualEffectType; speed: VisualEffectSpeed }
  | { kind: "PutValue"; mode: "into" | "after" | "before"; value: HexExprNode; destination: HexContainerTarget }
  | { kind: "GetValue"; value: HexExprNode }                                   // writes into "it"
  | { kind: "MathMutation"; op: "add" | "subtract" | "multiply" | "divide"; amount: HexExprNode; destination: HexContainerTarget }
  | { kind: "SetProperty"; property: HexPropertyName; target: HexObjectTarget; value: HexExprNode }
  | { kind: "PlaySound"; voice: HexVoice; tempo: number; notes: string }     // tempo defaults to 120
  | { kind: "ShowAnswerDialog"; prompt: HexExprNode; buttons: HexExprNode[] } // 0..3 buttons (none => "OK"); writes the clicked label into "it"
  | { kind: "ShowAskDialog"; prompt: HexExprNode; defaultAnswer?: HexExprNode } // writes the entered text (or empty on Cancel) into "it"
  | { kind: "Wait"; amount: HexExprNode; unit: "ticks" | "seconds" }          // 1 tick = 1/60 s
  | { kind: "FetchJson"; url: HexExprNode; jsonPath?: string; destination: HexContainerTarget }
  | { kind: "DeclareGlobal"; names: string[] }
  | { kind: "IfCondition"; condition: HexExprNode; thenBranch: HexStatementNode[]; elseBranch?: HexStatementNode[] }
  | { kind: "RepeatLoop"; head: HexRepeatHead; body: HexStatementNode[] }
  | { kind: "PassEvent"; eventName: string }
  | { kind: "ExitHandler" }
  | { kind: "ExitRepeat" }
  | { kind: "NextRepeat" }
) & { loc?: HexSourceLoc };

export type HexBinaryOp =
  | "or" | "and"
  | "=" | "<>" | "<" | ">" | "<=" | ">=" | "contains"
  | "&" | "&&"
  | "+" | "-" | "*" | "/" | "div" | "mod";

export type HexExprNode = (
  | { kind: "Literal"; value: string | number | boolean }
  | { kind: "Constant"; name: "empty" | "quote" | "return" | "space" | "tab" }
  | { kind: "Variable"; name: string }                  // user variable or "it" (lowercase)
  | { kind: "BuiltIn"; name: "date" | "time" | "ticks" | "seconds" | "mouseH" | "mouseV" | "numberOfCards" | "cardNumber" }
  | { kind: "FunctionCall"; name: "random" | "round" | "trunc" | "abs" | "length" | "min" | "max"; args: HexExprNode[] }
  | { kind: "ReadContainer"; source: Extract<HexContainerTarget, { scope: "field" }> } // variables use "Variable"
  | { kind: "ReadProperty"; property: HexPropertyName; target: HexObjectTarget }
  | { kind: "BinaryOp"; op: HexBinaryOp; left: HexExprNode; right: HexExprNode }
  | { kind: "UnaryOp"; op: "not" | "-"; operand: HexExprNode }
) & { loc?: HexSourceLoc };
