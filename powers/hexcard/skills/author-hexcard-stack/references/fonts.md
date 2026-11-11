# Fonts

The bundled fonts that `TEXT_SIZE_TABLE` selects, one section per font file. `Selected by` lists the field settings that draw text with the file: the `textFont`, `regular` (no `bold` in `textStyle`) or `bold` (`bold` in `textStyle`), and the `textSize` values. A `draw_layer` text command selects a file the same way with its `font`, `style` and `size`. Button titles always use `System regular 12`. Where `System` or `Serif` text is bold but the file is the regular one, HexCard draws the bold style in pixels.

Every file covers printable ASCII (U+0020 to U+007E). `Covered beyond printable ASCII` lists the other covered characters of the file: the code points its cmap maps, plus U+0009, U+000B and U+000C (drawn as a space) and U+00AD and U+200B (drawn as nothing). Any other character is uncovered: `render_card` and `draw_layer` draw it as the font's `.notdef` glyph and list it, and the studio draws it with a system fallback font.

## PixelOperator8-Bold.ttf

Selected by: System regular 9, 10, 18; System bold 9, 10, 18; Sans bold 9, 10, 18

Covered beyond printable ASCII: U+0009, U+000B-U+000C, U+00A0-U+00A3, U+00A5-U+00A6, U+00A8-U+00A9, U+00AB-U+00AE, U+00B0-U+00B1, U+00B4-U+00B8, U+00BB, U+00BF-U+00FF, U+0108-U+0109, U+010C-U+010F, U+011A-U+011D, U+0124-U+0125, U+0131, U+0134-U+0135, U+0147-U+0148, U+0152-U+0153, U+0158-U+0159, U+015C-U+015D, U+0160-U+0161, U+0164-U+0165, U+016C-U+016F, U+0178, U+017D-U+017E, U+02C6-U+02C7, U+02D8, U+02DA, U+02DC, U+200B, U+2013-U+2014, U+2018-U+201A, U+201C-U+201E, U+2020-U+2022, U+2026, U+2030, U+2039-U+203A, U+20AC, U+20B1, U+20B7, U+2117, U+2122

## PixelOperator-Bold.ttf

Selected by: System regular 12, 14, 24; System bold 12, 14, 24; Sans bold 12, 14, 24

Covered beyond printable ASCII: U+0009, U+000B-U+000C, U+00A0-U+00A3, U+00A5-U+00A6, U+00A8-U+00A9, U+00AB-U+00AE, U+00B0-U+00B1, U+00B4-U+00B8, U+00BB, U+00BF-U+00FF, U+0108-U+0109, U+010C-U+010F, U+011A-U+011D, U+0124-U+0125, U+0131, U+0134-U+0135, U+0147-U+0148, U+0152-U+0153, U+0158-U+0159, U+015C-U+015D, U+0160-U+0161, U+0164-U+0165, U+016C-U+016F, U+0178, U+017D-U+017E, U+02C6-U+02C7, U+02D8, U+02DA, U+02DC, U+200B, U+2013-U+2014, U+2018-U+201A, U+201C-U+201E, U+2020-U+2022, U+2026, U+2030, U+2039-U+203A, U+20AC, U+20B1, U+20B7, U+2117, U+2122

## PixelOperator8.ttf

Selected by: Sans regular 9, 10, 18

Covered beyond printable ASCII: U+0009, U+000B-U+000C, U+00A0-U+00A3, U+00A5-U+00A6, U+00A8-U+00A9, U+00AB-U+00AE, U+00B0-U+00B1, U+00B4-U+00B8, U+00BB, U+00BF-U+00FF, U+0108-U+0109, U+010C-U+010F, U+011A-U+011D, U+0124-U+0125, U+0131, U+0134-U+0135, U+0147-U+0148, U+0152-U+0153, U+0158-U+0159, U+015C-U+015D, U+0160-U+0161, U+0164-U+0165, U+016C-U+016F, U+0178, U+017D-U+017E, U+02C6-U+02C7, U+02D8, U+02DA, U+02DC, U+200B, U+2013-U+2014, U+2018-U+201A, U+201C-U+201E, U+2020-U+2022, U+2026, U+2030, U+2039-U+203A, U+20AC, U+20B1, U+20B7, U+2117, U+2122

## PixelOperator.ttf

Selected by: Sans regular 12, 14, 24

Covered beyond printable ASCII: U+0009, U+000B-U+000C, U+00A0-U+00A3, U+00A5-U+00A6, U+00A8-U+00A9, U+00AB-U+00AE, U+00B0-U+00B1, U+00B4-U+00B8, U+00BB, U+00BF-U+00FF, U+0108-U+0109, U+010C-U+010F, U+011A-U+011D, U+0124-U+0125, U+0131, U+0134-U+0135, U+0147-U+0148, U+0152-U+0153, U+0158-U+0159, U+015C-U+015D, U+0160-U+0161, U+0164-U+0165, U+016C-U+016F, U+0178, U+017D-U+017E, U+02C6-U+02C7, U+02D8, U+02DA, U+02DC, U+200B, U+2013-U+2014, U+2018-U+201A, U+201C-U+201E, U+2020-U+2022, U+2026, U+2030, U+2039-U+203A, U+20AC, U+20B1, U+20B7, U+2117, U+2122

## PixelOperatorMono8.ttf

Selected by: Mono regular 9, 10, 18

Covered beyond printable ASCII: U+0009, U+000B-U+000C, U+00A0-U+00A3, U+00A5-U+00A6, U+00A8-U+00A9, U+00AB-U+00AE, U+00B0-U+00B1, U+00B4-U+00B8, U+00BB, U+00BF-U+00FF, U+0108-U+0109, U+010C-U+010F, U+011A-U+011D, U+0124-U+0125, U+0131, U+0134-U+0135, U+0147-U+0148, U+0152-U+0153, U+0158-U+0159, U+015C-U+015D, U+0160-U+0161, U+0164-U+0165, U+016C-U+016F, U+0178, U+017D-U+017E, U+02C6-U+02C7, U+02D8, U+02DA, U+02DC, U+200B, U+2013-U+2014, U+2018-U+201A, U+201C-U+201E, U+2020-U+2022, U+2026, U+2030, U+2039-U+203A, U+20AC, U+20B1, U+20B7, U+2117, U+2122

## PixelOperatorMono8-Bold.ttf

Selected by: Mono bold 9, 10, 18

Covered beyond printable ASCII: U+0009, U+000B-U+000C, U+00A0-U+00A3, U+00A5-U+00A6, U+00A8-U+00A9, U+00AB-U+00AE, U+00B0-U+00B1, U+00B4-U+00B8, U+00BB, U+00BF-U+00FF, U+0108-U+0109, U+010C-U+010F, U+011A-U+011D, U+0124-U+0125, U+0131, U+0134-U+0135, U+0147-U+0148, U+0152-U+0153, U+0158-U+0159, U+015C-U+015D, U+0160-U+0161, U+0164-U+0165, U+016C-U+016F, U+0178, U+017D-U+017E, U+02C6-U+02C7, U+02D8, U+02DA, U+02DC, U+200B, U+2013-U+2014, U+2018-U+201A, U+201C-U+201E, U+2020-U+2022, U+2026, U+2030, U+2039-U+203A, U+20AC, U+20B1, U+20B7, U+2117, U+2122

## PixelOperatorMono.ttf

Selected by: Mono regular 12, 14, 24

Covered beyond printable ASCII: U+0009, U+000B-U+000C, U+00A0-U+00A3, U+00A5-U+00A6, U+00A8-U+00A9, U+00AB-U+00AE, U+00B0-U+00B1, U+00B4-U+00B8, U+00BB, U+00BF-U+00FF, U+0108-U+0109, U+010C-U+010F, U+011A-U+011D, U+0124-U+0125, U+0131, U+0134-U+0135, U+0147-U+0148, U+0152-U+0153, U+0158-U+0159, U+015C-U+015D, U+0160-U+0161, U+0164-U+0165, U+016C-U+016F, U+0178, U+017D-U+017E, U+02C6-U+02C7, U+02D8, U+02DA, U+02DC, U+200B, U+2013-U+2014, U+2018-U+201A, U+201C-U+201E, U+2020-U+2022, U+2026, U+2030, U+2039-U+203A, U+20AC, U+20B1, U+20B7, U+2117, U+2122

## PixelOperatorMono-Bold.ttf

Selected by: Mono bold 12, 14, 24

Covered beyond printable ASCII: U+0009, U+000B-U+000C, U+00A0-U+00A3, U+00A5-U+00A6, U+00A8-U+00A9, U+00AB-U+00AE, U+00B0-U+00B1, U+00B4-U+00B8, U+00BB, U+00BF-U+00FF, U+0108-U+0109, U+010C-U+010F, U+011A-U+011D, U+0124-U+0125, U+0131, U+0134-U+0135, U+0147-U+0148, U+0152-U+0153, U+0158-U+0159, U+015C-U+015D, U+0160-U+0161, U+0164-U+0165, U+016C-U+016F, U+0178, U+017D-U+017E, U+02C6-U+02C7, U+02D8, U+02DA, U+02DC, U+200B, U+2013-U+2014, U+2018-U+201A, U+201C-U+201E, U+2020-U+2022, U+2026, U+2030, U+2039-U+203A, U+20AC, U+20B1, U+20B7, U+2117, U+2122

## FairfaxSerif-Latin.ttf

Selected by: Serif regular 9, 10, 12, 14, 18, 24; Serif bold 9, 10, 12, 14, 18, 24

Covered beyond printable ASCII: U+0009, U+000B-U+000C, U+00A0-U+017F, U+200B, U+2010-U+2027, U+2030-U+203A, U+20AC, U+2122
