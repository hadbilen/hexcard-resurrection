Source: `hexcard_design_spec.md` §4.1, copied unchanged (the HexTalk grammar: the lexical rules, the EBNF and the grammar notes).

**Lexical rules**
- Keywords, identifiers and handler names are case-insensitive. Identifiers are stored lowercase in the AST; a handler keeps its original spelling in `eventName` and is keyed in lowercase.
- `--` starts a comment that runs to the end of the line. Blank lines are ignored. A newline ends a statement.
- `Identifier ::= Letter { Letter | Digit | "_" }` and must not be a reserved word (every quoted word in this grammar is reserved).
- `NumberLiteral ::= Digit { Digit } [ "." Digit { Digit } ]`
- `StringLiteral ::= '"' { any character except '"' and newline } '"'` — there are no escape sequences; the constant `quote` produces a double quote.

~~~ebnf
Script        ::= { Handler } ;
Handler       ::= "on" Identifier [ Identifier { "," Identifier } ] Newline
                  StatementList
                  "end" Identifier ;            (* closing name must equal the opening name *)
StatementList ::= { Statement Newline } ;

Statement     ::= GoCmd | VisualCmd | PutCmd | GetCmd | MathCmd | SetCmd | PlayCmd
                | AnswerCmd | AskCmd | WaitCmd | FetchCmd | GlobalCmd
                | IfStmt | RepeatBlock | PassCmd | ExitCmd | NextRepeatCmd ;

GoCmd         ::= "go" [ "to" ] ( ( "next" | "prev" | "previous" | "first" | "last" ) [ "card" ]
                                | "back"
                                | "card" "id" Primary
                                | "card" Primary ) ;      (* number => 1-based position, otherwise card name *)
VisualCmd     ::= "visual" [ "effect" ] EffectName [ SpeedName ] ;
PutCmd        ::= "put" Expression ( "into" | "after" | "before" ) Container ;
GetCmd        ::= "get" Expression ;                       (* writes the value into it *)
MathCmd       ::= "add" Expression "to" Container
                | "subtract" Expression "from" Container
                | "multiply" Container "by" Expression
                | "divide" Container "by" Expression ;
SetCmd        ::= "set" [ "the" ] PropertyName "of" ObjectRef "to" Expression ;
PlayCmd       ::= "play" ( VoiceName | '"' VoiceName '"' ) [ "tempo" NumberLiteral ] StringLiteral ;
AnswerCmd     ::= "answer" Expression [ "with" ConcatExpr [ "or" ConcatExpr [ "or" ConcatExpr ] ] ] ;
AskCmd        ::= "ask" Expression [ "with" Expression ] ;
WaitCmd       ::= "wait" Expression [ "tick" | "ticks" | "second" | "seconds" ] ;   (* default unit: ticks *)
FetchCmd      ::= "fetch" Expression [ "at" StringLiteral ] "into" Container ;     (* "at" = JSON path, §4.3 *)
GlobalCmd     ::= "global" Identifier { "," Identifier } ;
IfStmt        ::= "if" Expression "then"
                  ( Statement                                   (* single-line form, no else *)
                  | Newline StatementList [ "else" Newline StatementList ] "end" "if" ) ;
RepeatBlock   ::= "repeat" [ RepeatHead ] Newline StatementList "end" "repeat" ;
RepeatHead    ::= "with" Identifier "=" Expression ( "to" | "down" "to" ) Expression
                | "while" Expression
                | "until" Expression
                | "forever"
                | [ "for" ] Expression [ "times" ] ;      (* bare "repeat" = forever *)
PassCmd       ::= "pass" Identifier ;                      (* must equal the enclosing handler's name *)
ExitCmd       ::= "exit" ( "repeat" | Identifier ) ;       (* "exit <handlerName>" ends the handler *)
NextRepeatCmd ::= "next" "repeat" ;

Container     ::= Identifier                               (* local variable, declared global, or it *)
                | FieldRef ;
FieldRef      ::= [ CardWord | BgWord ] ( "field" | "fld" ) PartSelector ;   (* no layer word = background field, as in HyperCard *)
ButtonRef     ::= [ CardWord | BgWord ] ( "button" | "btn" ) PartSelector ;  (* no layer word = card button, as in HyperCard *)
PartSelector  ::= "id" Primary | Primary ;                 (* number => 1-based position within that layer, otherwise name *)
ObjectRef     ::= "me" | ButtonRef | FieldRef
                | "this" "card" | "card" PartSelector
                | "this" ( "background" | "bg" ) | "this" "stack" ;
CardWord      ::= "card" | "cd" ;
BgWord        ::= "background" | "bkgnd" | "bg" ;

Expression    ::= AndExpr { "or" AndExpr } ;
AndExpr       ::= CompareExpr { "and" CompareExpr } ;
CompareExpr   ::= ConcatExpr [ CompareOp ConcatExpr ] ;     (* non-associative *)
CompareOp     ::= "=" | "is" | "<>" | "is" "not" | "<" | ">" | "<=" | ">=" | "contains" ;
ConcatExpr    ::= AddExpr { ( "&" | "&&" ) AddExpr } ;      (* "&&" inserts a space *)
AddExpr       ::= MulExpr { ( "+" | "-" ) MulExpr } ;
MulExpr       ::= UnaryExpr { ( "*" | "/" | "div" | "mod" ) UnaryExpr } ;
UnaryExpr     ::= ( "not" | "-" ) UnaryExpr | Primary ;
Primary       ::= NumberLiteral | StringLiteral | Constant
                | "(" Expression ")"
                | FunctionName "(" [ Expression { "," Expression } ] ")"
                | "the" FunctionName "of" Primary           (* one-argument form, e.g. "the random of 6" *)
                | "the" BuiltInName
                | "the" PropertyName "of" ObjectRef
                | FieldRef                                  (* reads the field's text on the current card *)
                | Identifier ;                              (* variable; an unset variable evaluates to empty *)

Constant      ::= "empty" | "true" | "false" | "quote" | "return" | "space" | "tab" ;
FunctionName  ::= "random" | "round" | "trunc" | "abs" | "length" | "min" | "max" ;
BuiltInName   ::= "date" | "time" | "ticks" | "seconds" | "mouseH" | "mouseV"
                | "number" "of" "cards" | "number" "of" "this" "card" ;
PropertyName  ::= "name" | "visible" | "enabled" | "hilite" | "title" | "showName" | "autoHilite"
                | "location" | "rect" | "style" | "lockText" | "textAlign" | "textFont" | "textSize"
                | "textStyle" | "marked" ;
EffectName    ::= "cut" | "dissolve" | "venetian" "blinds" | "checkerboard" | "iris" ( "open" | "close" )
                | "wipe" ( "left" | "right" | "up" | "down" ) | "barn" "door" ( "open" | "close" ) ;
SpeedName     ::= "very" "slow" | "slow" | "normal" | "fast" ;
VoiceName     ::= "harpsichord" | "boing" | "flute" | "square8bit" | "click" ;
~~~

**Grammar notes**
- In `answer ... with A or B or C`, the button expressions are parsed at `ConcatExpr` level, so the word `or` separates buttons instead of acting as the boolean operator. Use parentheses for a boolean button label.
- `the PropertyName of ...` and `the FunctionName of ...` never collide because the two name sets are disjoint.
- `visual effect` without a `SpeedName` uses the speed `normal`.
- A script may define each handler name only once (names compare case-insensitively). A second handler with the same name is a compile error at its `on` line; the first handler is kept.
- `exit Identifier` follows the same rule as `pass`: the name must equal the enclosing handler's name, otherwise it is a compile error at that line.
- Inside `ObjectRef`, `card field N` (or `card fld N`) is the card-layer field (`CardWord FieldRef`), not a card selected by the field's text (`"card" PartSelector`). To select a card by a field's text, write `card bg field N`.
- Not supported in v2.0.0 (deliberate scope limits): `else if` chains on one line, single-line `if ... then ... else ...`, `send`, `do`, user-defined functions, chunk expressions (`word 2 of ...`).
