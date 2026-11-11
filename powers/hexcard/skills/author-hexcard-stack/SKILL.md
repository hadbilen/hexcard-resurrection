---
name: author-hexcard-stack
description: "Build, check, draw, preview and fix HexCard stacks with the hexcard tools: plan the cards and backgrounds, add buttons and fields, draw their pictures with draw_layer, check every change with validate_stack, preview each card with render_card, and save the result as a .hexstack file."
---

# Author a HexCard stack

A HexCard stack is one JSON object in schema 2.0.0: backgrounds, cards that each sit on one background, and parts (buttons and fields) on either layer. This skill builds a stack with the five tools of the hexcard power and ends with a `.hexstack` file that the HexCard studio opens. Scripts are covered by the write-hextalk skill.

## Before you start

The power's tools need Node.js 22.13 or later, except 23.0 to 23.4. Kiro starts the tools' server with the `node` it finds on its PATH.

If the tools (`validate_stack`, `compile_hextalk`, `conjure_script`, `render_card`, `draw_layer`) are missing from the chat, check the Node version: `node --version`, run with the PATH that Kiro uses, must print `v22.13.0` or a later version, and the printed version must not start with `v23.0.`, `v23.1.`, `v23.2.`, `v23.3.` or `v23.4.`. If it does not, install a newer Node.js and restart Kiro.

## The steps

1. Plan the backgrounds and cards. For each card, write down its parts (buttons and fields), the text it shows and its pictures. Put what several cards share (a frame, a title, navigation buttons, fields whose text changes from card to card) on a background.
2. Start from the minimal valid stack below: one background, one card, no parts, `""` layers and no icons.
3. Add backgrounds, cards and parts. Give every object a new unique id.
4. Draw the background and card pictures with `draw_layer` (see "Drawing with draw_layer"). Paste each returned `rleData` into the `bitmap.rleData` of a background when `layer` was `background`, or of a card when `layer` was `card`.
5. Write the scripts with the write-hextalk skill, and store the canonical form that `compile_hextalk` returns in `scriptSource`.
6. Run `validate_stack` after every change to the stack.
7. Once `validate_stack` returns `ok` true, render every card with `render_card`.
8. Fix what the tools report and repeat from step 3 until all of these hold:
   - `validate_stack` returns `ok` true with no script error and no note;
   - neither the last `draw_layer` call of each picture nor the `render_card` of any card reports an uncovered character or text that does not fit;
   - every card's `render_card` image and summary show the parts, text and pictures planned for that card in step 1.
9. Call `validate_stack` with `hexstack` true, and save the returned `.hexstack` text with your file tools to a file whose name ends in `.hexstack`. The studio opens it with File > Open Stack File.

The minimal valid stack:

```json hexcard:stack
{
  "id": "stk_first",
  "schemaVersion": "2.0.0",
  "name": "My First Stack",
  "author": "",
  "createdAt": "2026-11-11T00:00:00.000Z",
  "updatedAt": "2026-11-11T00:00:00.000Z",
  "dimensions": {
    "width": 512,
    "height": 342
  },
  "themePalette": {
    "name": "ClassicPaper",
    "darkBitHex": "#000000",
    "lightBitHex": "#FFFFFF"
  },
  "backgrounds": [
    {
      "id": "bkg_main",
      "name": "Main",
      "bitmap": {
        "width": 512,
        "height": 342,
        "rleData": ""
      },
      "parts": [],
      "scriptSource": "",
      "cantDelete": false
    }
  ],
  "cards": [
    {
      "id": "crd_home",
      "name": "Home",
      "backgroundId": "bkg_main",
      "bitmap": {
        "width": 512,
        "height": 342,
        "rleData": ""
      },
      "parts": [],
      "bgFieldContents": {},
      "marked": false,
      "cantDelete": false,
      "dontSearch": false,
      "scriptSource": ""
    }
  ],
  "customIcons": {},
  "scriptSource": ""
}
```

## Schema rules the gate enforces

`validate_stack` and `render_card` check a stack with the gate, the studio's own load check. The full schema is in `references/schema.md` (design spec §2.1, copied unchanged). The gate enforces these rules:

- `schemaVersion` is `"2.0.0"`.
- `dimensions` and every `bitmap` have `width` 512 and `height` 342.
- The ids of the stack, its backgrounds, its cards and their parts are all unique across the whole stack.
- Every card's `backgroundId` names a background of the stack. Every part in a background's `parts` has `layerScope` `background`, and every part in a card's `parts` has `layerScope` `card`.
- A rect's `x` and `y` are integers, and its `width` and `height` are non-negative integers. A rect may extend beyond the 512 x 342 card; `render_card` reports such a part as `outsideCard`.
- `themePalette.name` is one of `ClassicPaper`, `AmberCRT`, `GreenPhosphor` and `MidnightHex`, and `darkBitHex` and `lightBitHex` are `#RRGGBB` colours.
- Allowed values:
  - part `type`: `button` or `field`; `layerScope`: `card` or `background`;
  - button `style`: `transparent`, `opaque`, `rectangle`, `roundRect`, `shadow`, `checkBox`, `radioButton` or `default`;
  - field `style`: `transparent`, `opaque`, `rectangle`, `shadow` or `scrolling`;
  - `textAlign`: `left`, `center` or `right`; `textFont`: `System`, `Sans`, `Mono` or `Serif`; `textSize`: 9, 10, 12, 14, 18 or 24;
  - `textStyle` entries: `bold`, `italic`, `underline`, `outline`, `shadow` or `condense`;
  - a button `family`, when present: an integer from 1 to 15.
- Every object has every field of its type and no other key, so a stack never holds an AST. Only `naturalLanguagePrompt`, `iconId` and `family` may be left out.
- The stack has at least one background and at least one card.
- Every `customIcons` key is an icon name of 1 to 32 printable ASCII characters, with no space at either end and other than `__proto__`. Every value is 172 characters of padded standard Base64 (128 bytes). Every button `iconId` names a `customIcons` key.

Two conventions of design spec §2.1 that the gate does not check, and that you should still follow:

- ids start with `stk_` (the stack), `bkg_` (backgrounds), `crd_` (cards) or `prt_` (parts);
- `darkBitHex` and `lightBitHex` are copied from `THEME_PALETTES[name]` in `references/schema.md` (for example `#000000` and `#FFFFFF` for `ClassicPaper`).

## Which text a field shows

- A background field with `sharedText` false shows, on each card, that card's `bgFieldContents[<field id>]`, or empty text when the card has no entry for it. The field's own `content` is not shown.
- A background field with `sharedText` true shows its `content` on every card of its background. `bgFieldContents` entries for it are not shown.
- A card field shows its `content`, whatever its `sharedText` value.

In this stack, the background field `prt_title` has `sharedText` true, and the background field `prt_name` has `sharedText` false, with a different `bgFieldContents` entry on each of the two cards. The background button `prt_next` goes to the next card.

```json hexcard:stack
{
  "id": "stk_people",
  "schemaVersion": "2.0.0",
  "name": "Address Book",
  "author": "",
  "createdAt": "2026-11-11T00:00:00.000Z",
  "updatedAt": "2026-11-11T00:00:00.000Z",
  "dimensions": {
    "width": 512,
    "height": 342
  },
  "themePalette": {
    "name": "ClassicPaper",
    "darkBitHex": "#000000",
    "lightBitHex": "#FFFFFF"
  },
  "backgrounds": [
    {
      "id": "bkg_people",
      "name": "People",
      "bitmap": {
        "width": 512,
        "height": 342,
        "rleData": ""
      },
      "parts": [
        {
          "id": "prt_title",
          "name": "Title",
          "type": "field",
          "layerScope": "background",
          "rect": {
            "x": 16,
            "y": 12,
            "width": 480,
            "height": 24
          },
          "visible": true,
          "enabled": true,
          "scriptSource": "",
          "style": "transparent",
          "content": "Address Book",
          "sharedText": true,
          "lockText": true,
          "dontWrap": true,
          "showLines": false,
          "textAlign": "center",
          "textFont": "System",
          "textSize": 12,
          "textStyle": []
        },
        {
          "id": "prt_name",
          "name": "Name",
          "type": "field",
          "layerScope": "background",
          "rect": {
            "x": 16,
            "y": 60,
            "width": 480,
            "height": 24
          },
          "visible": true,
          "enabled": true,
          "scriptSource": "",
          "style": "rectangle",
          "content": "",
          "sharedText": false,
          "lockText": false,
          "dontWrap": false,
          "showLines": false,
          "textAlign": "left",
          "textFont": "Sans",
          "textSize": 12,
          "textStyle": []
        },
        {
          "id": "prt_next",
          "name": "Next",
          "type": "button",
          "layerScope": "background",
          "rect": {
            "x": 416,
            "y": 304,
            "width": 80,
            "height": 24
          },
          "visible": true,
          "enabled": true,
          "scriptSource": "on mouseUp\n  go to next card\nend mouseUp\n",
          "style": "roundRect",
          "title": "Next",
          "showName": true,
          "autoHilite": true,
          "hilite": false
        }
      ],
      "scriptSource": "",
      "cantDelete": false
    }
  ],
  "cards": [
    {
      "id": "crd_ada",
      "name": "Ada",
      "backgroundId": "bkg_people",
      "bitmap": {
        "width": 512,
        "height": 342,
        "rleData": ""
      },
      "parts": [],
      "bgFieldContents": {
        "prt_name": "Ada Lovelace"
      },
      "marked": false,
      "cantDelete": false,
      "dontSearch": false,
      "scriptSource": ""
    },
    {
      "id": "crd_alan",
      "name": "Alan",
      "backgroundId": "bkg_people",
      "bitmap": {
        "width": 512,
        "height": 342,
        "rleData": ""
      },
      "parts": [],
      "bgFieldContents": {
        "prt_name": "Alan Turing"
      },
      "marked": false,
      "cantDelete": false,
      "dontSearch": false,
      "scriptSource": ""
    }
  ],
  "customIcons": {},
  "scriptSource": ""
}
```

The `render_card` summaries of the two cards give the same text for `prt_title` and different text for `prt_name`. These are the `parts` entries of both fields in the summary for `card` 1:

```text
{"path":"backgrounds[0].parts[0]","layer":"background","type":"field","id":"prt_title","name":"Title","rect":{"x":16,"y":12,"width":480,"height":24},"style":"transparent","hidden":false,"disabled":false,"outsideCard":false,"text":"Address Book","textLength":12,"textSource":"sharedBackgroundContent"}
{"path":"backgrounds[0].parts[1]","layer":"background","type":"field","id":"prt_name","name":"Name","rect":{"x":16,"y":60,"width":480,"height":24},"style":"rectangle","hidden":false,"disabled":false,"outsideCard":false,"text":"Ada Lovelace","textLength":12,"textSource":"cardBgFieldContents"}
```

and in the summary for `card` `"Alan"`:

```text
{"path":"backgrounds[0].parts[0]","layer":"background","type":"field","id":"prt_title","name":"Title","rect":{"x":16,"y":12,"width":480,"height":24},"style":"transparent","hidden":false,"disabled":false,"outsideCard":false,"text":"Address Book","textLength":12,"textSource":"sharedBackgroundContent"}
{"path":"backgrounds[0].parts[1]","layer":"background","type":"field","id":"prt_name","name":"Name","rect":{"x":16,"y":60,"width":480,"height":24},"style":"rectangle","hidden":false,"disabled":false,"outsideCard":false,"text":"Alan Turing","textLength":11,"textSource":"cardBgFieldContents"}
```

## Pictures and rleData

Each background and card has one 512 x 342 bitmap layer, stored as text in `bitmap.rleData`. A card's picture is drawn over its background's picture.

- `""` is the empty layer: transparent on a card, so the background shows through, and light on a background.
- Every other `rleData` is text that HexCard's encoder (`encodeBitmapRLE`) produced: either returned by `draw_layer`, or copied unchanged from a layer that `validate_stack` gives no note for (for example from a stack the studio saved, or from HexCard's own build-time scripts). Never write or edit `rleData` by hand.
- `validate_stack` rejects `rleData` that does not decode, with a gate error at the layer's path. For `rleData` that decodes but is not canonical, it adds a note that names the layer, without changing `ok`.

## Drawing with draw_layer

`draw_layer` draws one whole 512 x 342 layer from a list of drawing commands and returns its canonical `rleData`.

- `layer` is `card` or `background`. On a card layer, every pixel that no command paints stays transparent and shows the background. On a background layer it stays light.
- `commands` holds 1 to 256 commands. They are drawn in list order, and each command draws over the commands before it: a pixel takes the state of the last command that set it.
- One call draws a whole layer from its command list alone, never over existing `rleData`. To change a picture, call `draw_layer` again with the full, changed list.
- Every coordinate, `width` and `height` is an integer. Every point lies inside the layer: `x`, `x1` and `x2` from 0 to 511, `y`, `y1` and `y2` from 0 to 341. Every rectangle, sprite and text box has a width and height of at least 1 and lies wholly inside the layer: `x + width` is at most 512 and `y + height` is at most 342.
- The sprite rows and texts of one call add up to at most 65,536 characters. Lengths are counted in UTF-16 code units.

The commands:

- `rect`: `x`, `y`, `width`, `height`; `pattern` (optional, default 1); `filled` (optional, default false). With `filled` false it draws the 1-pixel frame of the box (columns `x` and `x + width - 1`, rows `y` and `y + height - 1`); with `filled` true, every pixel of the box. It sets the pixels the studio's Rect tool sets.
- `line`: `x1`, `y1`, `x2`, `y2`; `pattern` (optional, default 1). Both ends are included, and it sets the pixels the studio's Line tool sets for a drag from (`x1`, `y1`) to (`x2`, `y2`). Swapping the two ends can set different pixels.
- `sprite`: `x`, `y`, `rows`. `rows` holds 1 to 64 rows of the same length, each of 1 to 64 characters, every character `#` (dark) or `.` (light). The cell at `rows[row][column]` sets the pixel at (`x + column`, `y + row`). The sprite's width is the length of its rows and its height the number of rows.
- `text`: `x`, `y`, `text` (1 to 256 characters); `width` (optional, default `512 - x`); `height` (optional, default `342 - y`); `font` (optional, default `Sans`): `System`, `Sans`, `Mono` or `Serif`; `size` (optional, default 12): 9, 10, 12, 14, 18 or 24; `style` (optional, default an empty list): each of `bold`, `italic`, `underline`, `outline`, `shadow` and `condense` at most once; `align` (optional, default `left`): `left`, `center` or `right`; `wrap` (optional, default true); `ink` (optional, default `dark`): `dark` or `light`. The text is laid out in the box (`x`, `y`, `width`, `height`) with no inset, the first line's top at `y`, like the text of a field. With `wrap` true, lines wrap at the box width; with `wrap` false, they break only at line breaks. Ink pixels are set to the `ink` state, and every other pixel is left unchanged. At size 12 a line is 16 pixels high.

Patterns: `pattern` is a pattern index from 0 to 37. 0 is solid light and 1 is solid dark. A pixel takes the pattern's state at the pixel's own layer coordinates. `references/patterns.md` shows all 38 patterns.

After a call, paste the returned `rleData` into a layer of the same kind as the `layer` argument (a background's `bitmap.rleData` for `background`, a card's for `card`), then run `validate_stack` and `render_card`.

This call draws a background with a grey title band, a framed title, a rule and a small house:

```json hexcard:draw id=title-band
{
  "layer": "background",
  "commands": [
    {"op":"rect","x":0,"y":0,"width":512,"height":32,"pattern":3,"filled":true},
    {"op":"rect","x":168,"y":6,"width":176,"height":20,"pattern":0,"filled":true},
    {"op":"rect","x":168,"y":6,"width":176,"height":20},
    {"op":"text","x":170,"y":8,"width":172,"height":16,"text":"My First Stack","font":"System","align":"center"},
    {"op":"line","x1":0,"y1":32,"x2":511,"y2":32},
    {"op":"sprite","x":16,"y":304,"rows":["...##...","..####..",".######.","########",".#....#.",".#.##.#.",".#.##.#.",".######."]}
  ]
}
```

It returns `ok` true, `notes` `[]` and `uncoveredCharacters` `[]`, and this stack holds its `rleData` in the background's bitmap:

```json hexcard:stack rle-from=title-band
{
  "id": "stk_picture",
  "schemaVersion": "2.0.0",
  "name": "Picture Demo",
  "author": "",
  "createdAt": "2026-11-11T00:00:00.000Z",
  "updatedAt": "2026-11-11T00:00:00.000Z",
  "dimensions": {
    "width": 512,
    "height": 342
  },
  "themePalette": {
    "name": "ClassicPaper",
    "darkBitHex": "#000000",
    "lightBitHex": "#FFFFFF"
  },
  "backgrounds": [
    {
      "id": "bkg_main",
      "name": "Main",
      "bitmap": {
        "width": 512,
        "height": 342,
        "rleData": "gZmBZoGZgWaBmYFm15nVqteZ12YAlddVAFbXZteZAJXXVQBW15nXZgCV11UAVtdm15kAlddVAFbXmddmAJXXVQBW12bXmQCV+VUIWlaVVVVWqpWl+lUBapX8VQFWlfhVAFbXmddmAJX5VQZaVpVVVVaV+1UFWlVVpaVp/VUBVpX4VQBW12bXmQCV+VUZWpqWlpVWlVWlaWlapWqlVaVVqpWqVapWlpX5VQBW15nXZgCV+VUTWqqWlpVWlVWlaalpaVpVVaVVaVb9lgCa+FUAVtdm15kAlflVGFpmlpaVVqlVpWpVaVVaVVVqlWlVVpaVVqn4VQBW15nXZgCV+VUNWlaWlpVWlVWlaVVapVr+VQelaVWqlpVWpfhVAFbXZteZAJX5VQ1aVpaWlVaVVaVpVVVpWv5VB6VpVpaWlVap+FUAVteZ12YAlflVE1pWlaqVVpVVpWlVaWlaVVWlpWlW/ZYAmvhVAFbXZteZAJX5VRlaVpVWlVaVVaVpVVqlVqVVapValaqVqlaWlflVAFbXmddmAJX3VQJWlpXkVQBW12bXmQCV9lUAquNVAFbXmddmAJXXVQBW12bXmQCV11UAVteZ12bVqtdmgZmBZoGZgWaBmYFmgaqBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVf1VAVaVg1UBWqWDVQFqqYNV/6qDVQFlWYNVAWaZg1UBZpmDVQFqqYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYFVgVWBVYdV"
      },
      "parts": [],
      "scriptSource": "",
      "cantDelete": false
    }
  ],
  "cards": [
    {
      "id": "crd_home",
      "name": "Home",
      "backgroundId": "bkg_main",
      "bitmap": {
        "width": 512,
        "height": 342,
        "rleData": ""
      },
      "parts": [],
      "bgFieldContents": {},
      "marked": false,
      "cantDelete": false,
      "dontSearch": false,
      "scriptSource": ""
    }
  ],
  "customIcons": {},
  "scriptSource": ""
}
```

## Reading the tools' output

- A gate error, `<path>: <message>`, for example `cards[1].backgroundId: references missing background "bkg_missing"`. The path points at the value to fix. Array indexes in a path count from 0, so `cards[1]` is the second card, while the integer `card` argument of `render_card` counts from 1 (`card` 2 is `cards[1]`). `validate_stack` returns every gate error it finds in one pass; fix them all, then call it again.
- A script error, `<path> line L, column C: <message>`, for example `backgrounds[0].parts[2].scriptSource line 3, column 5: expected "end mouseUp" but found "end mouseDown"`. The path is the path of a `scriptSource`. The line and column count from 1 inside that one script. Fix the script, check the fixed script with `compile_hextalk`, and store its canonical form.
- A non-canonical-layer note, for example `cards[0].bitmap.rleData: this rleData decodes but is not canonical; replace it with draw_layer output or ""`. Replace the layer's `rleData` with `draw_layer` output or `""`.
- An uncovered-character entry, `{"path":"backgrounds[0].parts[1]","character":"U+2603"}` from `render_card` or `{"path":"commands[1]","character":"U+2603"}` from `draw_layer`. The character at that code point is not covered by the font of that part or drawing command. Replace it with a character the font covers (see "Text and fonts").
- A `draw_layer` note on text that does not fit, for example `commands[0]: 1 line of the text does not fit in its box; make the box larger, the text shorter or the size smaller`. It names the command's path and the number of its lines that do not fit, and those lines are cut off at the box. Make the box larger, the text shorter or the size smaller.
- The `render_card` image: 512k x 342k pixels for `scale` k (1 or 2), each card pixel shown as a k x k block in the theme's two colours (`lightBitHex` and `darkBitHex`). It matches the studio only within the pixel-match limit below.
- The `render_card` summary, for when you are not shown the image:
  - `card`: the card's 1-based `position`, the number of cards (`count`), its `id` and `name`; `background`: the `id` and `name` of its background;
  - `cardSize`: always 512 by 342; `image`: the image's `width`, `height`, `scale` and `mimeType`;
  - `theme`: the theme's `name`, `lightBitHex` and `darkBitHex` as the stack stores them, the two colours of the image;
  - `parts`: every part in drawing order, the background's parts then the card's, hidden parts included. Each entry has the part's `path`, `layer`, `type`, `id`, `name`, `rect` and `style`; `hidden` (`visible` is false, so it is not drawn), `disabled` (`enabled` is false) and `outsideCard` (the rect extends beyond the 512 x 342 card). A button entry has its `title` when `showName` is true and its `iconId` when it has one. A field entry has the `text` it shows on this card, the `textLength` of the full text, and the `textSource`: `cardContent` (a card field's `content`), `sharedBackgroundContent` (a background field with `sharedText` true) or `cardBgFieldContents` (this card's `bgFieldContents` entry; a missing entry gives empty text);
  - `uncoveredCharacters`: the uncovered characters in the text of the card's visible parts, each once per part with the part's path, and then `uncoveredNote`, which says that the studio draws them with a system fallback font, so the studio's pixels of those parts can differ from the preview.
  Ids, names, titles and texts longer than 80 characters are shown as their first 77 characters followed by `...`.
- An error result (MCP `isError` true), for example `{"ok":false,"errors":["commands[0]: the rectangle must lie inside the 512 x 342 layer"]}` or `{"ok":false,"errors":["card: no card matches 3; the stack has 2 cards"]}`. The call returned no verdict, no image and no `rleData`. Each entry of `errors` names the argument and the rule it breaks, or is a gate error of the stack; fix them and call again. `render_card` returns the gate errors of a stack that `validate_stack` rejects as an error result.
- A list cut at 100 entries: a list with more than 100 entries shows its first 100, followed by a field with the number of entries not shown (`errorsNotShown`, `scriptErrorsNotShown`, `notesNotShown`, `partsNotShown`, `uncoveredCharactersNotShown`). Fix the entries shown, then call the tool again to see the rest.

## Text and fonts

Use printable ASCII (U+0020 to U+007E) for all text a card shows: field text, button titles and the text of `draw_layer` text commands. Every bundled font covers it.

`references/fonts.md` lists, for each font file, the `textFont`, `textSize` and bold settings that select it and the characters it covers beyond printable ASCII. Button titles always use `System` 12. A character outside a font's list is an uncovered character: the tools draw the font's `.notdef` glyph for it and list it, and the studio draws it with a system fallback font.

## Pixel-match limit

The `render_card` image matches the studio's card pixel for pixel only for covered characters: when the text of every visible part consists only of characters that its font covers. This was measured only in headless Chrome 157 on Linux; other browsers and operating systems were not checked.
