---
name: write-hextalk
description: "Write, check and fix HexTalk scripts for HexCard buttons, fields, cards, backgrounds and stacks: the exact grammar, the VM's limits, common compile errors and their fixes, compile_hextalk for the canonical text and conjure_script for a first draft."
---

# Write HexTalk scripts

HexTalk is HexCard's scripting language, a strict subset of HyperCard's HyperTalk. A script is a list of handlers (`on <message>` ... `end <message>`) stored as the `scriptSource` of a stack, a background, a card or a part (a button or a field). HexCard parses the script into an AST and runs it in a step-limited VM; it never runs JavaScript. This skill covers writing a script, checking it with `compile_hextalk`, getting a first draft with `conjure_script`, and storing it in a stack. Building the stack itself is covered by the author-hexcard-stack skill.

## The grammar

The file `references/grammar.md` holds the HexTalk grammar: the lexical rules, the EBNF and the grammar notes, copied unchanged from the HexCard design spec. Read it before writing a script. Only what it lists is HexTalk; anything else from HyperTalk is a compile error.

A short script with a button handler:

```hextalk hexcard:hextalk
on mouseUp
  visual effect dissolve fast
  go to card "Hall"
end mouseUp

on openCard
  put the date into field "Date"
end openCard
```

## Rules and limits

**Step budget.** Each top-level dispatch (the delivery of one message, such as one click) has a budget of 10,000 steps, shared with its nested dispatches. Every evaluated statement and expression costs 1 step, and every loop iteration costs 1 more, so even a loop with an empty body uses up the budget. Running out stops the whole dispatch with the script error "Loop exceeded 10,000 steps" and keeps every change made before that point; nothing is rolled back. Keep loops short, and never use `repeat forever` without an `exit repeat`.

```hextalk hexcard:hextalk
on mouseUp
  put 0 into total
  repeat with i = 1 to 100
    add i to total
  end repeat
  put total into field "Total"
end mouseUp
```

**Nested dispatches.** `go` sends `closeCard` and `openCard` (and `closeBackground` and `openBackground` when the background changes) as nested dispatches inside the running one, not through the message queue. The statements after a `go` see the new card. Nesting deeper than 16 levels stops the dispatch with the script error "Too much recursion", for example an `openCard` handler that always runs `go next`.

**AST nesting.** A script may nest at most `HEX_MAX_DEPTH` (256) levels of statement blocks and expressions together, along any path from a handler. Beyond that, `compile_hextalk` reports "script is nested too deeply".

**String literals.** A string literal holds no `"`, no line break and no escape sequences. The constant `quote` gives a double quote and the constant `return` gives a line break; join them to other text with `&`:

```hextalk hexcard:hextalk
on mouseUp
  put "He said " & quote & "boo" & quote & return & "and left." into field "Story"
end mouseUp
```

**`play` and `answer`.** `play` takes a tempo from 20 to 400; the default is 120. `answer` shows at most 3 buttons; without a `with` part it shows one `OK` button. The clicked button's label goes into `it`.

```hextalk hexcard:hextalk
on mouseUp
  play flute tempo 90 "e5q d5e c5e b4h"
  answer "Open the door?" with "Yes" or "No"
  if it = "Yes" then go next
  answer "Goodbye"
end mouseUp
```

**`fetch`.** `fetch` allows https URLs only, GET only, with no credentials and no custom headers. It has an 8 s timeout, and the response body must be at most 256 KB and must be JSON. The `at` part is a JSON path: `Key { "." Key | "[" Digits "]" }`, where a key is a letter or `_` followed by letters, digits or `_` (for example `current.temperature_2m` or `daily.time[0]`); there are no wildcards or filters. On success the result goes into the destination and into `it`; a string, number or boolean becomes its text, an object or array becomes compact JSON. On failure the destination stays unchanged and `it` becomes `error: <reason>`, where the reason is one of `blocked url`, `timeout`, `http <status>`, `not json`, `too large` (a body over 256 KB), `network error` (no HTTP response at all, for example DNS, CORS or offline) and `path not found`.

```hextalk hexcard:hextalk
on mouseUp
  fetch "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m" at "current.temperature_2m" into field "Temperature"
  if it contains "error:" then answer "The oracle is silent: " & it
end mouseUp
```

**Variables.** A variable is local to the running handler. `get`, `answer`, `ask` and `fetch` write `it`, and an unset variable reads as empty (0 in arithmetic). `global x` makes `x` a runtime-wide global for the rest of the handler; every handler that uses the global declares it. Globals are kept in memory only and are never saved or exported, so a value that must survive a reload belongs in a field.

```hextalk hexcard:hextalk
on mouseUp
  global score
  add 10 to score
  put score into field "Score"
end mouseUp
```

**The message path.** A message goes first to its target part (a button, or a field with `lockText` true), then to the card, the background, the stack and finally the built-in handlers. The first object with a handler for the message handles it, and the message goes no further. `pass <message>` ends the handler at once (statements after it never run) and sends the same message with the same parameters to the next object on the path. Mouse messages go to the part under the pointer, or to the card when no part is hit. An unlocked field gets no mouse messages in Browse mode, because a click there places the text caret; set `lockText` true on a field that should react to clicks. `idle` and lifecycle messages such as `openCard` start at the card, so an `openCard` handler belongs in a card, background or stack script, never in a button or field.

```hextalk hexcard:hextalk
on mouseUp
  play click "c4q"
  pass mouseUp
end mouseUp
```

## Common mistakes

Each mistake below shows a wrong script, the one error that `compile_hextalk` returns for it (line, column and message exactly as the tool returns them), and the fixed script.

An `end` line must name the handler it closes:

```hextalk hexcard:mistake
on mouseUp
  go next
end mouseDown
```
compile_hextalk: line 3, column 5: expected "end mouseUp" but found "end mouseDown"

```hextalk hexcard:hextalk
on mouseUp
  go next
end mouseUp
```

`pass` must name the message of the enclosing handler:

```hextalk hexcard:mistake
on mouseUp
  pass mouseDown
end mouseUp
```
compile_hextalk: line 2, column 8: pass must name the enclosing handler "mouseUp", not "mouseDown"

```hextalk hexcard:hextalk
on mouseUp
  pass mouseUp
end mouseUp
```

`exit` must name the enclosing handler (or be `exit repeat` inside a loop):

```hextalk hexcard:mistake
on mouseUp
  if field "Answer" is empty then exit openCard
  go next
end mouseUp
```
compile_hextalk: line 2, column 40: exit must name the enclosing handler "mouseUp" or "repeat", not "openCard"

```hextalk hexcard:hextalk
on mouseUp
  if field "Answer" is empty then exit mouseUp
  go next
end mouseUp
```

There is no `else if` on one line. Put the second `if` on its own line inside the `else` block, with its own `end if`:

```hextalk hexcard:mistake
on mouseUp
  if field "Score" > 10 then
    go to card "Win"
  else if field "Score" > 5 then
    go to card "Draw"
  else
    go to card "Lose"
  end if
end mouseUp
```
compile_hextalk: line 4, column 8: "else" must be followed by a new line (a statement on the same line is not supported)

```hextalk hexcard:hextalk
on mouseUp
  if field "Score" > 10 then
    go to card "Win"
  else
    if field "Score" > 5 then
      go to card "Draw"
    else
      go to card "Lose"
    end if
  end if
end mouseUp
```

The one-line `if ... then <statement>` has no `else`. Use the block form when there is an `else`:

```hextalk hexcard:mistake
on mouseUp
  if the hilite of me then go next else go prev
end mouseUp
```
compile_hextalk: line 2, column 36: expected the end of the line but found "else"

```hextalk hexcard:hextalk
on mouseUp
  if the hilite of me then
    go next
  else
    go prev
  end if
end mouseUp
```

A `"` ends a string literal, so it cannot appear inside one. Join the constant `quote` instead:

```hextalk hexcard:mistake
on mouseUp
  put "Say "hello" to the ghost" into field "Message"
end mouseUp
```
compile_hextalk: line 2, column 13: expected "into", "after" or "before" but found "hello"

```hextalk hexcard:hextalk
on mouseUp
  put "Say " & quote & "hello" & quote & " to the ghost" into field "Message"
end mouseUp
```

There is no `send`. Write the statements of the other handler where they are needed, or let the message travel on with `pass`:

```hextalk hexcard:mistake
on mouseUp
  send mouseUp to button "Start"
end mouseUp
```
compile_hextalk: line 2, column 3: unknown command "send"

```hextalk hexcard:hextalk
on mouseUp
  set the hilite of button "Start" to true
  go next
end mouseUp
```

There is no `do`. Write the statement itself:

```hextalk hexcard:mistake
on mouseUp
  do "go next"
end mouseUp
```
compile_hextalk: line 2, column 3: unknown command "do"

```hextalk hexcard:hextalk
on mouseUp
  go next
end mouseUp
```

There are no user-defined functions. Only the built-in functions `random`, `round`, `trunc`, `abs`, `length`, `min` and `max` take arguments in parentheses; write any other computation inline. A `function ... end` block is rejected too, because every handler starts with `on`.

```hextalk hexcard:mistake
on mouseUp
  put double(21) into field "Result"
end mouseUp
```
compile_hextalk: line 2, column 13: expected "into", "after" or "before" but found "("

```hextalk hexcard:hextalk
on mouseUp
  put 21 * 2 into field "Result"
end mouseUp
```

There are no chunk expressions (`char`, `word`, `item` or `line ... of`). Keep each piece of text that a script needs in a field of its own:

```hextalk hexcard:mistake
on mouseUp
  put word 2 of field "Name" into field "Last Name"
end mouseUp
```
compile_hextalk: line 2, column 12: expected "into", "after" or "before" but found "2"

```hextalk hexcard:hextalk
on mouseUp
  put field "Name" into field "Last Name"
end mouseUp
```

Every word that appears in quotes in the grammar is reserved and cannot be a variable name, for example `name`, `time`, `date`, `number`, `length`, `title`, `next` and `card`. Pick another name:

```hextalk hexcard:mistake
on mouseUp
  put field "Name" into name
  answer "Hello " & name
end mouseUp
```
compile_hextalk: line 2, column 25: expected a variable or a field but found "name"

```hextalk hexcard:hextalk
on mouseUp
  put field "Name" into playerName
  answer "Hello " & playerName
end mouseUp
```

A script may define each handler name only once (names compare case-insensitively). The first handler is kept and the second is an error at its `on` line. Merge the two bodies into one handler:

```hextalk hexcard:mistake
on mouseUp
  go next
end mouseUp

on mouseUp
  play boing "c e g"
end mouseUp
```
compile_hextalk: line 5, column 4: handler "mouseUp" is already defined in this script

```hextalk hexcard:hextalk
on mouseUp
  play boing "c e g"
  go next
end mouseUp
```

## `field N` and `button N` without a layer word

As in HyperCard, `field N` without a layer word means a background field, and `button N` without a layer word means a card button. This gives no compile error, so a script that means a card field or a background button must say `card field N` or `bg button N`. The canonical form that `compile_hextalk` returns always shows the layer word of each reference. This script:

```hextalk hexcard:hextalk id=layer-words
on mouseUp
  put "Hello" into field 1
  set the hilite of button 1 to true
end mouseUp
```

has this canonical form:

```hextalk hexcard:canonical of=layer-words
on mouseUp
  put "Hello" into bg field 1
  set the hilite of card button 1 to true
end mouseUp
```

A number selects a part by its 1-based position within that layer; any other value selects it by name, and `id` selects it by its id.

## Checking a script

Check every script with `compile_hextalk` before it goes into a stack:

1. Pass the whole script, at most 65,536 characters, as `source`.
2. Read each error's line and column. Both count from 1, from the start of the script you sent.
3. Fix the script and call `compile_hextalk` again until it returns `ok` true. The parser reports only the first error of each handler and skips to that handler's `end` line, so one fix can reveal the next error in the same handler.
4. Store the returned canonical form as the `scriptSource`, not the text you sent. The canonical form can differ from the sent text in synonyms (`is` becomes `=`, `go next` becomes `go to next card`), in `if` blocks (a one-line `if` becomes a block), in layer words and in indentation; identifiers become lowercase. It parses to the same AST as the sent text.
5. `ok` true with the note `The script has no handlers.` means that the script responds to no message. That is right only for an empty script.

`validate_stack` reports the same errors for a script stored in a stack, written `<path> line L, column C: <message>`, where `<path>` is the path of its `scriptSource`, for example `cards[0].scriptSource line 3, column 5: expected "end openCard" but found "end openCrd"`. Array indexes in the path count from 0. The line and column count from 1 inside that one script; fix it with `compile_hextalk`, then store the new canonical form.

## A first draft with conjure_script

`conjure_script` turns an English prompt into a HexTalk draft with HexCard's built-in Spellcaster, which needs no API key and no network:

- The `prompt` has at most 600 characters.
- `objectKind` is one of `button`, `field`, `card`, `background` and `stack`; the default is `button`. Give the kind of object that will hold the script: it picks the handler used when the prompt names no message (for example `mouseUp` in a button), and the object that `me` names.
- A note in `notes` (the `handlerHint` note) means that the handler never runs in that kind of object, for example an `openCard` handler conjured for a button. Conjure it again for the card, background or stack, or store it there.
- A refusal (`ok` false) gives a `reason` and, in `suggestions`, the prompts of 1 to 3 Grimoire spells that the Spellcaster knows. Rephrase the prompt or start from a suggestion.
- The returned `hexTalk` is a draft. Read it, check it with `compile_hextalk` like any other script, and change it until it does what the card needs, before storing it.

## Putting a script into a stack

A script enters a stack only as the `scriptSource` string of the stack, a background, a card or a part. Write it as a JSON string: each line break as `\n` and each `"` as `\"`. For example, the canonical form of the fixed `quote` script above is stored as:

```json
"scriptSource": "on mouseUp\n  put \"Say \" & quote & \"hello\" & quote & \" to the ghost\" into bg field \"Message\"\nend mouseUp\n"
```

Never store a script as an AST or under any other key: `validate_stack` rejects an object with an unknown key. HexCard rebuilds the AST from `scriptSource` every time it loads the stack. After storing a script, run `validate_stack` and fix every script error it reports.
