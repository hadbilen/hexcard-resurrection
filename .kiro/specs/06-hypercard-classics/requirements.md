# Requirements Document

## Introduction
**HyperCard Classics — Message Box, Find, Recent, Import Image, FatBits & Icons.**

Spec 05 left five menu items reserved: File > Import Image, Edit > Icon Editor, Go > Recent, Go > Find and Go > Message Box. This spec turns them into real items and adds Paint > FatBits. It also reverses the decision that button icons are not rendered (design spec §5.6, spec 03 design §3): buttons draw their 32x32 1-bit icon, and the Icon Editor creates and assigns icons.

The spec adds no persisted field. Schema 2.0.0 already has `HexStack.customIcons` and `HexButtonPart.iconId`; this spec fixes the format of their values. It reuses what exists:
- spec 01: the store and its two write paths, `history.execute` for every authoring change, `PaintStrokeCommand`, the message bus and its back history;
- spec 02: `parseHexTalk` and the gas-limited VM, the only way a Message Box line runs;
- spec 03: `composeFrame`, `partRenderer.ts` and `textRaster.ts` for everything drawn on the card, `importImageToBitmap` and `decodeImageBlobToRgba` (spec 03 task 5) for images, the paint controller for strokes;
- spec 04: the System 7 shell, studio windows, the modal manager, the Stack Graph thumbnails (`createCardThumbnail`), the synth's `click` voice, the script error reporter;
- spec 05: the menu model and handlers in `src/ui/menuCommands.ts`, command dispatches on the message bus (design spec §3.2 rule 10), the shortcut rules (spec 05 Requirements 2.4 and 16) and the selected part.

Canonical contracts: schema `hexcard_design_spec.md` §2.1, message path §3, concurrency model §3.2, grammar §4.1, VM semantics §4.3, composition §5.6.

**Shortcut findings.** Before Cmd/Ctrl+M, +F and +R were assigned, they were checked against the reserved list of spec 05 Requirement 2.1 (none of them is on it) and against what each browser lets a page prevent:
- Chrome: the commands a page cannot prevent are listed in `kReservedCommandIds` in [Chromium `chrome/browser/ui/accelerator_table.cc`](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/accelerator_table.cc) (close tab, close window, new tab, new window, new incognito window, restore tab, tab switching, exit). Find (Ctrl/Cmd+F) and Reload (Ctrl/Cmd+R) are not on it, so a page can prevent them. Chrome has no Ctrl+M accelerator on Linux or Windows.
- Firefox: in [`browser/base/content/browser-sets.inc.xhtml`](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/browser/base/content/browser-sets.inc.xhtml) (changed 2026-11-04) new window, new tab and close are marked `reserved="true"`; Find (`key_find`, accel+F), Reload (`key_reload`, accel+R) and Mute Tab (`key_toggleMute`, Control+M on every platform) are not reserved, so a page can prevent them.
- macOS: Command-M minimizes the front window ([Apple, Mac keyboard shortcuts](https://support.apple.com/en-gb/102650)). Chrome's source sends main-menu key equivalents to the page first, but that cannot be tested here and Safari's source is not public, so Go > Message Box gets no shortcut on macOS. Safari is not covered for Cmd+F and Cmd+R either.
- Headless Chrome 157 (a CDP probe run for this spec, `--headless=new`): every combination tried, including the reserved Ctrl+T, Ctrl+W and Ctrl+N, reached the page, and Chrome ran no browser shortcut for injected keys even when the page did not prevent them (Ctrl+R did not reload, Ctrl+T opened no tab). Headless Chrome can therefore check that HexCard receives a shortcut, prevents it and runs the item (Requirement 15.4), but not that a browser honours the prevention. That part rests on the browser sources above.

Out of scope: sending a typed message name from the Message Box to the current card (HyperCard does this; see Requirement 3.8), the `find` variants `whole`, `string`, `chars`, `word` and `in field`, FatBits for paint tools other than the Pencil and the Eraser, a `set the icon of` property in HexTalk, Export Paint, and AI Conjure > Conjure Stack and Oracle Settings, which stay reserved.

## Glossary
Terms of spec 05 (menu item, enabled, disabled, reserved item, observable effect, platform modifier, text input, studio shortcut, command dispatch, edit layer, edit target, selected part, back history, dimmed) keep their meaning. This spec adds:
- **Message Box:** the floating one-line window of Go > Message Box. Its **line** is the text in its text box.
- **Floating window:** a window that stays open while the user works on the card, like the Tools palette. The Message Box is a floating window. It is not a studio window: it does not block the menu bar, the card or studio shortcuts.
- **Studio window:** a modal System 7 window of the studio (Object Inspector, Stack Graph, showcase chooser, and in this spec Recent and Icon Editor). While one is open, no studio shortcut fires (spec 05 Requirement 16.3).
- **Find command:** a Message Box line whose first word is `find` (Requirement 4.2).
- **Searchable field:** a field with `visible` true on a card whose `dontSearch` is false (Requirement 4.4).
- **Match:** a range of characters of a searchable field's text on one card that matches the search text (Requirement 4.5).
- **Found text:** the match that Find went to last. It is UI state in the store and is drawn as a box until it is cleared (Requirement 4.9).
- **Recent list:** the cards that most recently became current, newest first (Requirement 5.1).
- **Miniature:** a card's 1-bit thumbnail as the Stack Graph draws it (`createCardThumbnail`, 128 x 86 pixels at UI scale k).
- **Paint tool:** Select, Lasso, Pencil, Brush, Eraser, Line, Spray, Rectangle or Paint Bucket.
- **FatBits view:** the 8x zoomed view of part of the card (Requirement 7). Its **origin** is the card pixel shown in its top-left cell. A **cell** is the 8 x 8 block that shows one card pixel. The **inset** is the small actual-size picture of the zoomed region.
- **Icon data:** a `customIcons` value (Requirement 8.1). **Icon name:** a `customIcons` key (Requirement 8.2).
- **Stack icon:** an entry of the current stack's `customIcons`. **Built-in icon:** an icon shipped in HexCard's source code (Requirement 11), never referenced by a stack.
- **Icon command:** a history command made by the Icon Editor (Requirement 10).

## Requirements

### Requirement 1: Menu Items, Enabling Rules and Shortcuts
**User Story:** As a HyperCard user, I want Message Box, Find, Recent, Import Image, Icon Editor and FatBits in the menus with the classic shortcuts where the browser allows them, so that I can use HyperCard's everyday tools.

#### Acceptance Criteria
1. THE SYSTEM SHALL turn the reserved items File > Import Image, Edit > Icon Editor, Go > Recent, Go > Find and Go > Message Box into menu items connected to menu handlers, keep their labels (`Import Image...`, `Icon Editor...`, `Recent...`, `Find...`, `Message Box...`), and keep AI Conjure > Conjure Stack and AI Conjure > Oracle Settings reserved.
2. THE SYSTEM SHALL add the menu item Paint > FatBits, labelled `FatBits` without a trailing `...`, below Show / Hide Tools Palette and a separator, and SHALL show it checked WHILE the FatBits view is on.
3. THE SYSTEM SHALL keep Go > Message Box, Go > Find, Go > Recent and Edit > Icon Editor enabled at all times; enable File > Import Image only WHILE a paint tool is active, as HyperCard offers Import Paint only with a paint tool; and enable Paint > FatBits only WHILE the Pencil or the Eraser tool is active.
4. THE SYSTEM SHALL offer platform modifier + F for Go > Find and platform modifier + R for Go > Recent on every platform, and platform modifier + M for Go > Message Box on every platform except macOS.
5. WHILE the platform is macOS, THE SYSTEM SHALL give Go > Message Box no shortcut and no shortcut label, and SHALL leave Cmd+M and Ctrl+M to the browser and the operating system without preventing them.
6. THE SYSTEM SHALL label the new shortcuts `Cmd+F` and `Cmd+R` on macOS and `Ctrl+F`, `Ctrl+R` and `Ctrl+M` on every other platform, and SHALL accept both the Command and the Control key as the modifier wherever the shortcut exists, as spec 05 Requirement 2.3 does.
7. THE SYSTEM SHALL handle the new shortcuts by spec 05 Requirement 2.4 (outside a text input: prevent the default action, run the item's menu handler only if the item is enabled) and spec 05 Requirement 16 (no studio shortcut in a text input or WHILE a dialog or studio window is open); the Message Box text box is a text input for spec 05 Requirement 16.
8. THE SYSTEM SHALL prevent the default action of platform modifier + R without Shift in every focus state and WHILE a dialog or studio window is open, without running Go > Recent there, so that the Recent shortcut never reloads the studio.
9. THE SYSTEM SHALL keep every combination of spec 05 Requirement 2.1 unassigned.
10. FOR spec 05 Requirements 1.2 and 15.3, THE SYSTEM SHALL count a change of the Message Box (opened, closed, focused, or its line changed) and a change of the FatBits view or the found text as an observable effect.

### Requirement 2: Message Box Window
**User Story:** As a stack author, I want a one-line Message Box that stays open while I work, so that I can try commands and inspect values without writing a handler.

#### Acceptance Criteria
1. WHEN the user chooses Go > Message Box WHILE the Message Box is closed, THE SYSTEM SHALL open it as a floating one-line System 7 window and put the keyboard focus in its text box, with the caret at the end of the line.
2. WHEN the user chooses Go > Message Box WHILE the Message Box is open, THE SYSTEM SHALL put the keyboard focus in its text box and select the whole line.
3. WHEN the user clicks the Message Box's close box, or presses Escape WHILE the focus is in its text box, THE SYSTEM SHALL close the Message Box.
4. THE SYSTEM SHALL keep the line, in memory only, when the Message Box is closed and opened again, when a line runs (except where Requirements 3.4, 4.1 and 4.11 replace it) and when another stack is loaded, and SHALL NOT write it to any stack, IndexedDB record, URL, `.hexstack` file or export.
5. WHILE the Message Box is open, THE SYSTEM SHALL keep the menu bar, the card, the Tools palette and the studio shortcuts working, and SHALL keep sending `idle` under design spec §3.2 rule 4, because the Message Box is not modal.
6. THE SYSTEM SHALL let the user drag the Message Box by its title bar, keep its title bar reachable inside the browser window, draw it at the studio's UI scale k, and open it at its last position or, the first time, near the bottom left of the desktop.
7. THE SYSTEM SHALL keep the line to one line: line breaks in pasted text are removed, as an HTML one-line text box does.
8. WHEN the user presses on the card WHILE the focus is in the Message Box, THE SYSTEM SHALL move the focus out of the Message Box, so that Browse-mode keys reach the card again.
9. THE SYSTEM SHALL label the Message Box text box `Message Box` for assistive technology.

### Requirement 3: Running a Message Box Line
**User Story:** As a stack author, I want Return in the Message Box to run a statement or show the value of an expression against the current card, with the same sandbox as scripts, so that experiments are safe.

#### Acceptance Criteria
1. WHEN the user presses Return in the Message Box, THE SYSTEM SHALL take the line without leading and trailing spaces; IF it is empty, THEN THE SYSTEM SHALL do nothing; IF its first word is `find` (compared case-insensitively), THEN THE SYSTEM SHALL handle it as a find command (Requirement 4).
2. OTHERWISE, IF the line parses as one HexTalk statement of design spec §4.1, THEN THE SYSTEM SHALL run it in one command dispatch through the message bus queue, as the current card at the moment the dispatch starts (`me` is that card; field and card references resolve as design spec §3.2 rule 6 says), and SHALL keep the line in the Message Box.
3. OTHERWISE, IF the line parses as one HexTalk expression of design spec §4.1, THEN THE SYSTEM SHALL evaluate it in one command dispatch as the current card at the moment the dispatch starts.
4. WHEN an expression of Requirement 3.3 has been evaluated, THE SYSTEM SHALL replace the line with the value as text (the text conversion of design spec §4.3), each line break shown as one space, unless the user has changed the line since pressing Return.
5. IF the line is neither a find command, nor a statement, nor an expression, THEN THE SYSTEM SHALL run nothing, keep the line and show a System 7 alert with the parser's message and its column in the line: the statement error when the first word is a command word of §4.1 (`go`, `visual`, `put`, `get`, `add`, `subtract`, `multiply`, `divide`, `set`, `play`, `answer`, `ask`, `wait`, `fetch`, `global`, `if`, `repeat`, `pass`, `exit`, `next`), otherwise the expression error.
6. THE SYSTEM SHALL run a Message Box line only through the VM of design spec §4.3, with the 10,000-step gas limit shared with its nested dispatches, the `fetch` policy, the abort shortcut and every other sandbox rule that applies to script handlers, and SHALL NOT use `eval`, `new Function` or any other dynamic code execution.
7. WHEN a Message Box line runs, THE SYSTEM SHALL bind every variable it uses, `it` included, to the runtime global of that name, as HyperCard's message box does, so that a value put into `x` on one line can be read on the next line and by handlers that declare `global x`; globals stay in memory only (design spec §4.3).
8. THE SYSTEM SHALL NOT send the line as a message: a line that is a single word is evaluated as an expression (a variable), not delivered to a handler of that name.
9. IF a Message Box line raises a script error or exceeds the gas limit, THEN THE SYSTEM SHALL show the dialog of spec 04 Requirements 3.3 and 3.4; WHEN the error happened in the line itself, the dialog SHALL name the handler `Message Box` and SHALL have no **Script** button; WHEN it happened in a handler that the line triggered (for example `openCard` after `go next`), the dialog SHALL keep its **Script** button for that handler.
10. THE SYSTEM SHALL NOT add `find` or any other word to the HexTalk grammar of design spec §4.1, its reserved words, the AST or the parser.

### Requirement 4: Find
**User Story:** As a user of a card database, I want to type a word and jump to the next card that contains it, so that I can find records quickly.

#### Acceptance Criteria
1. WHEN the user chooses Go > Find, THE SYSTEM SHALL open the Message Box if it is closed, replace its line with `find ""` and put the focus in its text box with the caret between the two quotes, as HyperCard does.
2. THE SYSTEM SHALL accept a find command of the form `find "<text>"`: the word `find` in any case, at least one space, a double-quoted text without `"`, and nothing but spaces after the closing quote; IF a line whose first word is `find` has any other form, THEN THE SYSTEM SHALL show the alert `Type find "text", for example find "lamp".` and search nothing.
3. WHEN a find command with an empty text runs, THE SYSTEM SHALL search nothing and leave the current card, the found text and the line unchanged.
4. THE SYSTEM SHALL search the searchable fields of every card, skipping every card whose `dontSearch` is true (the current card included) and every field whose `visible` is false; on each card it SHALL search the background fields in the order of their background's `parts`, then the card's own fields in the order of its `parts` (the drawing order of design spec §5.6), reading a background field's text as `sharedText ? content : bgFieldContents[id] ?? ""`.
5. THE SYSTEM SHALL count as a match every occurrence of the whole search text, compared case-insensitively (locale-independent lower case), that starts at the start of a word: at index 0 of the field text, or right after a character that is not a Unicode letter or digit.
6. THE SYSTEM SHALL order matches by card position, then by field order (Requirement 4.4), then by start index, and SHALL go to the first match after the found text, or, WHILE there is no found text, the first match at or after the start of the current card; the search SHALL wrap around from the last card to the first, so that a lone match is found again.
7. THE SYSTEM SHALL run each find command as one command dispatch through the message bus queue, resolve the match from the store snapshot at the moment the dispatch starts, and, WHEN the match is on another card, go to that card as `go` does (`closeCard`, `closeBackground` if the background changes, the card change, `openBackground` if it changed, `openCard`), recording the departed card in the back history.
8. WHEN the dispatch has reached the match's card and that card is still current, THE SYSTEM SHALL make the match the found text and draw it as a box: a 1-pixel rectangle around the matched characters (one rectangle per line when the match wraps), drawn into the 1-bit frame by the part renderer by inverting pixels, with no DOM element.
9. THE SYSTEM SHALL clear the found text WHEN the current card changes, WHEN the text of the matched field on that card changes, and WHEN another stack is loaded, and SHALL keep it otherwise (tool changes, Edit Background, menus).
10. WHEN the match lies in a `scrolling` field outside its visible lines, THE SYSTEM SHALL scroll that field so that the match's first line is visible.
11. IF no searchable field of any card has a match, THEN THE SYSTEM SHALL play one short sound with the synth's `click` voice, replace the line with `Not found.`, clear the found text and leave the current card unchanged.
12. THE SYSTEM SHALL NOT change the stack or the undo history when it finds text.

### Requirement 5: Recent
**User Story:** As a user browsing a large stack, I want to see miniatures of the cards I visited last and go back to any of them with one click.

#### Acceptance Criteria
1. THE SYSTEM SHALL keep a Recent list of at most 12 cards, newest first, each card at most once, whose first entry is always the current card: WHEN a card becomes current by any means (`go`, `go back`, the Go menu, the arrow keys, Find, Recent, New Card, New Background, Delete Card, Undo, Redo), THE SYSTEM SHALL move it to the front, dropping the oldest entry beyond 12.
2. WHEN another stack is loaded, THE SYSTEM SHALL reset the Recent list to the new current card; THE SYSTEM SHALL leave out cards that no longer exist.
3. THE SYSTEM SHALL keep the Recent list in memory only and SHALL NOT save it.
4. WHEN the user chooses Go > Recent, THE SYSTEM SHALL open a studio window titled `Recent` that shows the miniature of every card of the Recent list in list order, four per row, each with the card's name (or `Card N` when it has none) below it, the current card's name inverted as in the Stack Graph.
5. WHEN the user clicks a miniature, or presses Return or Space on a focused miniature, THE SYSTEM SHALL close the Recent window and go to that card in one command dispatch through the message bus queue, with the lifecycle messages of `go`; IF it is the current card, THEN THE SYSTEM SHALL only close the window; IF the card no longer exists when the dispatch starts, THEN THE SYSTEM SHALL do nothing.
6. WHEN the user closes the Recent window with its close box or Escape, THE SYSTEM SHALL leave the current card unchanged.

### Requirement 6: Import Image
**User Story:** As a creator, I want to import a photo or drawing onto the card or the background as 1-bit art, safely, and undo it if I do not like it.

#### Acceptance Criteria
1. WHEN the user chooses File > Import Image, THE SYSTEM SHALL open the browser's file chooser offering PNG, JPEG, GIF, WebP and BMP files, and import the chosen file.
2. WHEN the user drops files on the card WHILE a paint tool is active and no dialog or studio window is open, THE SYSTEM SHALL import the first dropped file.
3. WHEN the user drops files on the card WHILE no paint tool is active, THE SYSTEM SHALL import nothing and show the alert `Choose a paint tool to import an image.`; WHEN files are dropped anywhere else in the studio, THE SYSTEM SHALL import nothing; in both cases THE SYSTEM SHALL prevent the browser from opening the dropped file in place of the studio.
4. THE SYSTEM SHALL accept only a file whose MIME type is `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/bmp` (SVG and every other type are rejected) and whose size is at most 16 MiB (16,777,216 bytes).
5. BEFORE decoding, THE SYSTEM SHALL read the image's width and height from the file header and accept only images whose width and height are each at most 8,192 pixels and whose pixel count is at most 16,777,216; after decoding THE SYSTEM SHALL check the same limits on the decoded size.
6. THE SYSTEM SHALL decode the image from the file's bytes inside the page, without any network request and without loading it through a URL.
7. THE SYSTEM SHALL scale the image to fit 512 x 342 with its aspect ratio kept and centred, convert it to luminance and dither it with Atkinson error diffusion, as spec 03 Requirement 5.1 and `importImageToBitmap` do.
8. THE SYSTEM SHALL write the result into the edit target's bitmap (the current card's layer, or its background's layer in Edit Background mode), resolved when the pixels are written: inside the image rectangle every dark pixel becomes state 2 and every light pixel state 1, on the card layer too, so the imported picture covers the background inside its rectangle like an opaque pasted picture; pixels outside the image rectangle SHALL keep their state, and the import SHALL produce no transparent (state 0) pixel.
9. THE SYSTEM SHALL apply an import as exactly one `history.execute` command labelled `Import Image` that holds the before and after pixels of the image rectangle, so Edit > Undo Import Image restores the layer's `rleData` exactly and Redo applies the import again; an import that changes no pixel SHALL NOT be recorded.
10. IF the file type, the file size, the header, the pixel limits or the decoding fail, THEN THE SYSTEM SHALL leave the stack unchanged and show a System 7 alert naming the reason: `HexCard can import PNG, JPEG, GIF, WebP and BMP images.`, `This image file is larger than 16 MB.`, `This image is larger than 8192 x 8192 pixels or 16 megapixels.` or `This image could not be read.`
11. THE SYSTEM SHALL send no message for an import; it is an authoring change outside the message bus queue.

### Requirement 7: FatBits
**User Story:** As a pixel artist, I want an 8x zoomed view for the pencil and the eraser, so that I can place single pixels precisely.

#### Acceptance Criteria
1. WHEN the user chooses Paint > FatBits WHILE the FatBits view is off, THE SYSTEM SHALL turn it on with its origin at card pixel (224, 149), which centres the view on the card.
2. WHILE the FatBits view is on, THE SYSTEM SHALL show in the card viewport, instead of the normal frame, the 64 x 43 card pixels starting at the origin of the frame the viewport shows today (bottom row partly visible), each card pixel as one 8 x 8 cell: a dark pixel as a dark 7 x 7 square whose right column and bottom row stay light, a light pixel as an all-light cell.
3. WHILE the FatBits view is on, THE SYSTEM SHALL draw the inset: the same 64 x 43 region at actual size with a 1-pixel dark frame and a 1-pixel light margin, in the top-left corner of the viewport, or in the top-right corner WHILE the origin's x is below 9 and its y below 6, so that every card pixel can be reached.
4. THE SYSTEM SHALL draw the FatBits view and the inset into the 1-bit frame with only the stack theme's two colours.
5. WHILE the FatBits view is on, THE SYSTEM SHALL map a Pencil or Eraser press on a cell to the card pixel that the cell shows and every later pointer position of that stroke to the card pixel of the cell under it; a press inside the inset SHALL start no stroke.
6. WHILE the FatBits view is on, THE SYSTEM SHALL make the Eraser erase exactly one card pixel per pointer position (the Pencil already draws one pixel), keep the layer rules of spec 03 Requirements 7.1 and 7.3, and submit every press, drag and release as one `PaintStrokeCommand`, so each stroke is one Undo step as today.
7. WHILE the FatBits view is on, WHEN the user presses an arrow key without modifiers WHILE the focus is not in a text input and no dialog or studio window is open, THE SYSTEM SHALL move the origin 8 card pixels in that direction, clamped to x 0..448 and y 0..299, and prevent the browser's default action.
8. THE SYSTEM SHALL turn the FatBits view off WHEN the user chooses Paint > FatBits again, WHEN the user presses Escape WHILE the focus is not in a text input and no dialog or studio window is open, WHEN a tool other than the Pencil or the Eraser becomes active, and WHEN another stack is loaded; card changes and Edit Background changes SHALL keep it on.
9. WHILE a stroke is in progress in the FatBits view, THE SYSTEM SHALL show it live in the cells and the inset.
10. THE SYSTEM SHALL keep the FatBits view as UI state in the store: never saved and never undoable.

### Requirement 8: Icon Data and Validation
**User Story:** As a stack author sharing stacks, I want icons stored in one exact format and checked on load, so that every stack with icons opens anywhere and a damaged icon cannot break the app.

#### Acceptance Criteria
1. THE SYSTEM SHALL store each icon as icon data: 128 bytes, 32 rows of 4 bytes, row-major from the top row, the most significant bit of each byte being the leftmost of its 8 pixels, 1 = dark and 0 = clear, encoded as standard Base64 (alphabet `A-Z a-z 0-9 + /`) with padding: exactly 172 characters ending in exactly one `=`, the last data character carrying zero in its two unused bits (canonical form).
2. THE SYSTEM SHALL accept as an icon name 1 to 32 printable ASCII characters (U+0020 to U+007E), not starting or ending with a space, other than `__proto__`.
3. WHEN a stack is validated, THE SYSTEM SHALL reject it whole, with the path in the error message, IF a `customIcons` value is not icon data (Requirement 8.1), IF a `customIcons` key is not an icon name (Requirement 8.2), or IF a button's `iconId` is not a key of its stack's `customIcons`.
4. THE SYSTEM SHALL keep every stack it produces valid: deleting an icon SHALL remove the `iconId` of every button that names it, and renaming an icon SHALL rename the `iconId` of every button that names it, in the same history command.
5. FOR every 32 x 32 1-bit image `P`, THE SYSTEM SHALL satisfy `decodeIcon(encodeIcon(P))` equal to `P`, and FOR every icon data string `S`, `encodeIcon(decodeIcon(S))` equal to `S`.
6. THE SYSTEM SHALL keep schema 2.0.0 unchanged, and every existing preset and the starter stack SHALL pass `validateStack` unchanged.

### Requirement 9: Icon Rendering
**User Story:** As a stack author, I want buttons to show their icons in the 1-bit frame, so that I can build classic HyperCard navigation buttons.

#### Acceptance Criteria
1. WHEN a visible button whose style is not `checkBox` or `radioButton` has an `iconId`, THE SYSTEM SHALL draw that stack icon into the frame, horizontally centred in the button's inside area; WHILE `showName` is true and the title is not empty, the icon and one title line directly below it SHALL be centred vertically as one block, so the icon sits near the top with the title under it (HyperCard layout); WHILE `showName` is false, the icon alone SHALL be centred.
2. THE SYSTEM SHALL draw the set bits of an icon dark (state 2) and leave the pixels of its clear bits unchanged, so they show the button face, or what lies under a `transparent` button.
3. THE SYSTEM SHALL clip the icon and the title to the button's inside area, as titles are clipped today.
4. WHEN the button is highlighted (`hilite`, or `autoHilite` while pressed), THE SYSTEM SHALL invert the icon with the rest of the inside area; WHILE the button's `enabled` is false, THE SYSTEM SHALL draw the icon's dark pixels through the 50% checkerboard of spec 03 Requirement 3.4.
5. THE SYSTEM SHALL draw no icon for `checkBox` and `radioButton` buttons, which keep their `iconId`.
6. THE SYSTEM SHALL draw buttons without an `iconId` exactly as today, pixel for pixel.
7. THE SYSTEM SHALL draw icons wherever parts are rasterized: the card viewport, visual effects, the Stack Graph and Recent miniatures, and the standalone player.

### Requirement 10: Icon Editor
**User Story:** As a stack author, I want a 32x32 pixel editor for my stack's icons and a way to put an icon on the selected button, so that I can make my own icons without other tools.

#### Acceptance Criteria
1. WHEN the user chooses Edit > Icon Editor, THE SYSTEM SHALL open a studio window titled `Icon Editor` that lists the stack icons in `customIcons` key order and the built-in icons, each with a 32 x 32 1-bit preview and its name, and shows the selected icon in a 32 x 32 editing grid with 8 x 8 cells drawn like FatBits cells.
2. WHEN the Icon Editor opens, THE SYSTEM SHALL select the selected button's icon if it has one, otherwise the first stack icon, otherwise the first built-in icon.
3. WHEN the user presses a cell of a stack icon, THE SYSTEM SHALL give that pixel the opposite colour and, while the pointer stays pressed, give every cell the pointer passes over that same colour; on release, THE SYSTEM SHALL apply the change as one icon command labelled `Edit Icon` if any pixel changed; built-in icons SHALL be read-only in the grid.
4. WHEN the user clicks **New**, THE SYSTEM SHALL add a blank stack icon named `Icon N`, N being the lowest positive integer for which no stack icon has that name (compared case-insensitively), select it, and record one icon command labelled `New Icon`.
5. WHEN the user clicks **Duplicate**, THE SYSTEM SHALL add a copy of the selected icon named `<name> N`, N being the lowest integer from 2 for which the name is free (compared case-insensitively), with `<name>` shortened so the result has at most 32 characters, select it, and record one icon command labelled `Duplicate Icon`.
6. WHEN the user clicks **Rename...** on a stack icon, THE SYSTEM SHALL ask for the new name with the `ask` dialog; IF the answer is not an icon name (Requirement 8.2) or equals another stack icon's name compared case-insensitively, THEN THE SYSTEM SHALL show an alert and change nothing; otherwise THE SYSTEM SHALL rename the icon in place (same position in `customIcons`) and every `iconId` that names it, as one icon command labelled `Rename Icon`.
7. WHEN the user clicks **Delete** on a stack icon, THE SYSTEM SHALL remove it and the `iconId` of every button on every card and background that names it, as one icon command labelled `Delete Icon`.
8. WHEN the user clicks **Add to Stack** on a built-in icon, THE SYSTEM SHALL copy its icon data into `customIcons` under its name, or under `<name> N` (Requirement 10.5) when that name is taken, select the new stack icon, and record one icon command labelled `Add Icon`.
9. WHILE the selected part (spec 05 Requirement 10) is a button, WHEN the user clicks **Use for Button**, THE SYSTEM SHALL set that button's `iconId` to the selected icon, first copying a built-in icon into `customIcons` as Requirement 10.8 does, as one icon command labelled `Set Icon`; WHEN the user clicks **No Icon**, THE SYSTEM SHALL remove the button's `iconId` as one icon command labelled `Remove Icon`; THE SYSTEM SHALL disable both buttons WHILE no button is selected or the click would change nothing.
10. THE SYSTEM SHALL apply every icon command through `history.execute`, so that Undo restores a stack deep-equal to the stack before it and Redo the stack after it, and SHALL keep the Icon Editor's list and grid in step with the store after Undo and Redo.
11. THE SYSTEM SHALL offer an **Undo** button in the Icon Editor that runs Edit > Undo, enabled WHILE the history can undo, because the menu bar and the studio shortcuts are unavailable while a studio window is open.
12. THE SYSTEM SHALL disable **Rename...** and **Delete** WHILE a built-in icon is selected, and **Duplicate**, **Rename...**, **Delete** and **Use for Button** WHILE no icon is selected.

### Requirement 11: Built-in Icons
**User Story:** As a stack author, I want a few ready-made icons, so that I can give a button an icon at once, and as the maintainer I want them to be HexCard's own art.

#### Acceptance Criteria
1. THE SYSTEM SHALL ship at least 12 built-in icons drawn originally for HexCard, pixel by pixel, and SHALL NOT copy, trace or adapt Apple's HyperCard icon artwork or any other icon set.
2. THE SYSTEM SHALL name every built-in icon with the prefix `hex-` followed by lowercase words joined by `-` (for example `hex-arrow-right`), so that no built-in name copies an Apple icon name; every name SHALL be an icon name (Requirement 8.2) and unique.
3. THE SYSTEM SHALL keep built-in icons in source code only; a stack SHALL refer only to its own `customIcons`, so that `.hexstack` files, share links and standalone HTML exports with icons keep working without HexCard's built-in set.
4. THE SYSTEM SHALL make every built-in icon valid icon data (Requirement 8.1), not blank, and different in its bits from every other built-in icon.

### Requirement 12: State Ownership and Persistence
**User Story:** As a developer, I want the new features to keep the spec 01 write paths and add no persisted data, so that undo, auto-save and validation stay consistent.

#### Acceptance Criteria
1. THE SYSTEM SHALL add no persisted field; every stack produced by the features of this spec SHALL be a schema 2.0.0 `HexStack` that passes `validateStack`.
2. THE SYSTEM SHALL keep the found text and the FatBits view in the store snapshot as UI state, next to the tool, the edit layer and the selected part: never saved, never undoable, set only through store methods, and cleared by the store under Requirements 4.9 and 7.8.
3. THE SYSTEM SHALL keep the Message Box (open state, line, position) and the Recent list in memory outside the stack and SHALL NOT save them.
4. THE SYSTEM SHALL apply Import Image and every icon command only through `history.execute`, change cards for Find and Recent only through the message bus, and let Message Box lines write the stack only through the VM's `store.applyRuntime` path.
5. WHEN Undo or Redo reverts or reapplies an Import Image or icon command, THE SYSTEM SHALL send no message.

### Requirement 13: 1-Bit Fidelity of the New Interface
**User Story:** As a retro computing enthusiast, I want the new windows and views to look like the rest of HexCard's 1-bit System 7 interface.

#### Acceptance Criteria
1. THE SYSTEM SHALL draw the Message Box, the Recent window, the Icon Editor, the FatBits view, the inset and the found-text box with only the stack theme's `darkBitHex` and `lightBitHex`, following the 1-Bit Fidelity Rules of steering `tech.md` (no blurred shadows, gradients, opacity, rounded corners, dashed or dotted lines, or glyphs missing from the bundled fonts; `image-rendering: pixelated` on every canvas; fonts only at multiples of their native size).
2. THE SYSTEM SHALL write every new label, button text, alert text and window title in printable ASCII.
3. THE SYSTEM SHALL show selected text and the caret in the Message Box and the Icon Editor in the theme's two colours.

### Requirement 14: Specification Documents
**User Story:** As the maintainer, I want the shared documents to match the new behaviour, so that no spec contradicts another.

#### Acceptance Criteria
1. THE SYSTEM SHALL update `hexcard_design_spec.md` §5.6 to say that button icons are rendered, with the layout of Requirement 9, replacing the line that says they are not rendered in schema 2.0.0.
2. THE SYSTEM SHALL update the `customIcons` comment in `hexcard_design_spec.md` §2.1 (and the matching comment in `src/core/schema.ts`) to state the icon data layout of Requirement 8.1 and that an `iconId` names a `customIcons` key.
3. THE SYSTEM SHALL replace the line of `.kiro/specs/03-1bit-canvas-dither/design.md` §3 that says button icons are not rendered with a pointer to this spec.
4. THE SYSTEM SHALL add to `.kiro/specs/05-authoring-loop/requirements.md` Requirements 1.5 and 2.2 a note that spec 06 turns Message Box, Find, Recent, Import Image and Icon Editor into real items and adds Cmd/Ctrl+F, Cmd/Ctrl+R and, except on macOS, Ctrl+M.
5. THE SYSTEM SHALL list every new module of this spec in `.kiro/steering/structure.md` with the spec number `[06]`, add `06-hypercard-classics` to its list of specs, and add `06` to every existing module this spec changes.
6. THE SYSTEM SHALL add `06-hypercard-classics` to the spec list of `hexcard_design_spec.md` §8, with a one-line summary of its modules, as the entries for specs 01 to 05 have.
7. THE SYSTEM SHALL make the changes of Requirements 14.1 to 14.6 in one task, and only those changes to documents outside this spec.

### Requirement 15: Verification
**User Story:** As the maintainer, I want every feature covered by unit, property and browser checks, so that regressions are caught before release.

#### Acceptance Criteria
1. THE SYSTEM SHALL ship unit tests for: the new menu items, enabling rules, labels and shortcuts on both platforms (including no Message Box shortcut on macOS and the reload guard of Requirement 1.8); Message Box line handling (find command, statement, expression, error, globals, error dialogs); Find matching, order, wrap-around and clearing; the Recent list; Import Image file checks, header sizes, pixel mapping on both layers and the history command; FatBits rendering, inset placement, pointer mapping, panning and turning off; icon data, names and validation; icon rendering; every icon command and its Undo and Redo.
2. THE SYSTEM SHALL ship fast-check property tests that check: icon data round-trips in both directions of Requirement 8.5 and is accepted by the validator, while strings that are not canonical 172-character icon data are rejected; repeated find commands over random stacks never make a card with `dontSearch` current and never box a field with `visible` false, and visit the matches in the order of Requirement 4.6, returning to the first after the last; Import Image followed by Undo restores the edit target layer's `rleData` exactly, for random layers and images on both edit layers.
3. THE SYSTEM SHALL extend the tests of spec 05 Requirement 16.5 to the Message Box text box and to the new shortcuts.
4. THE SYSTEM SHALL be checked in headless Chrome with `--disable-lcd-text`, at UI scale 1 and 2: open the Message Box, run a statement, an expression and an invalid line; find text on another card and get `Not found.`; open Recent and go to a miniature; drop a generated PNG on the card with a paint tool and undo it; draw in FatBits, pan with the arrow keys and leave with Escape; add a built-in icon to a button in the Icon Editor; export that stack with File > Export Standalone HTML, open the exported file with the network disabled, and confirm that the button's icon is drawn and that the screenshot contains only the two theme colours; press Ctrl+M, Ctrl+F and Ctrl+R, and with the platform emulated as macOS Cmd+F, Cmd+R and Cmd+M, and confirm that each shortcut item runs with its default action prevented and that Cmd+M on macOS is neither handled nor prevented; take a screenshot after every step and confirm that every screenshot contains only `#000000` and `#FFFFFF` and that the auto-saved stack passes `validateStack` and matches each step.
