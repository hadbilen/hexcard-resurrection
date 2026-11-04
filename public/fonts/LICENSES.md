# Bundled Font Licences

HexCard bundles only fonts licensed under OFL-1.1, CC0 or public-domain terms
(`hexcard_design_spec.md` §5.5). Apple's Chicago, Geneva, Monaco and New York font files are
never bundled or loaded. The logical font names and sizes map to these files in
`src/engine/graphics/textRaster.ts` (`TEXT_SIZE_TABLE`; native pixel sizes in `FONT_FILES`).

| File | Logical font (sizes) | Font | Author | Licence | Source |
|------|----------------------|------|--------|---------|--------|
| `PixelOperator-Bold.ttf` | `System` regular (12, 14, 24); `Sans` bold (12, 14, 24) | Pixel Operator Bold, version 2018.10.04-1 | Jayvee Enaguas (HarvettFox96) | CC0-1.0 | https://www.dafont.com/pixel-operator.font |
| `PixelOperator.ttf` | `Sans` regular (12, 14, 24) | Pixel Operator Regular, version 2018.10.04-1 | Jayvee Enaguas (HarvettFox96) | CC0-1.0 | https://www.dafont.com/pixel-operator.font |
| `PixelOperatorMono.ttf` | `Mono` regular (12, 14, 24) | Pixel Operator Mono Regular, version 2018.10.04-1 | Jayvee Enaguas (HarvettFox96) | CC0-1.0 | https://www.dafont.com/pixel-operator.font |
| `PixelOperatorMono-Bold.ttf` | `Mono` bold (12, 14, 24) | Pixel Operator Mono Bold, version 2018.10.04-1 | Jayvee Enaguas (HarvettFox96) | CC0-1.0 | https://www.dafont.com/pixel-operator.font |
| `PixelOperator8-Bold.ttf` | `System` regular (9, 10, 18); `Sans` bold (9, 10, 18) | Pixel Operator 8 Bold, version 2018.10.04-1 | Jayvee Enaguas (HarvettFox96) | CC0-1.0 | https://www.dafont.com/pixel-operator.font |
| `PixelOperator8.ttf` | `Sans` regular (9, 10, 18) | Pixel Operator 8 Regular, version 2018.10.04-1 | Jayvee Enaguas (HarvettFox96) | CC0-1.0 | https://www.dafont.com/pixel-operator.font |
| `PixelOperatorMono8.ttf` | `Mono` regular (9, 10, 18) | Pixel Operator Mono 8 Regular, version 2018.10.04-1 | Jayvee Enaguas (HarvettFox96) | CC0-1.0 | https://www.dafont.com/pixel-operator.font |
| `PixelOperatorMono8-Bold.ttf` | `Mono` bold (9, 10, 18) | Pixel Operator Mono 8 Bold, version 2018.10.04-1 | Jayvee Enaguas (HarvettFox96) | CC0-1.0 | https://www.dafont.com/pixel-operator.font |
| `FairfaxSerif-Latin.ttf` | `Serif` regular (all sizes) | Fairfax Serif, version 2026.09.21 (Latin subset) | Kreative Software (Rebecca G. Bettencourt) | OFL-1.1 | https://github.com/kreativekorp/open-relay/tree/master/Fairfax |

## Provenance

- **Pixel Operator:** the eight `.ttf` files are byte-identical copies from the official archive
  `https://dl.dafont.com/dl/?f=pixel_operator` (archive SHA-256
  `95b33667e4884f5714db33d8324472df28f9d5ffed49108824c5819c1a217dad`). The archive ships the
  CC0 1.0 legal code as `LICENSE.txt` (reproduced below), and every font's `name` table states
  "licensed under a Creative Commons Zero (CC0) 1.0" (name IDs 0, 13 and 14). File SHA-256:

  | File | SHA-256 |
  |------|---------|
  | `PixelOperator.ttf` | `8d805274eaf227855147153182a96a86ff395ddbc7d2d378095af8831b764a3e` |
  | `PixelOperator-Bold.ttf` | `c1963fa21043a357212e0a9e8ae1986bc375c1759e68bd3533c4f71b164614b0` |
  | `PixelOperatorMono.ttf` | `e171000f12d196e7a8a1a91c1a429ef3264a0ff007d5f62fa3dc44ef8df51226` |
  | `PixelOperatorMono-Bold.ttf` | `7b8a5f6cfd5fdb06ddac7d976935babf05afa5ef7bf6b8c1b8cf919b481d33e1` |
  | `PixelOperator8.ttf` | `5cccb9ef6cf18977b6e5721d49a1a6e78dd6a6f1c4f69537470f7dc1dc829ffc` |
  | `PixelOperator8-Bold.ttf` | `b46a109cdac6c2f7acb4a57451dc3c8f7e2d391b871500270eadf139f0ac906e` |
  | `PixelOperatorMono8.ttf` | `b627505e178c0c51b0ce7d432f2974fdc2064339f17fb5242b7237becad3c467` |
  | `PixelOperatorMono8-Bold.ttf` | `11704bf2bddcde0996909166ad9d10a7ff38eb311a59cb07991f63e5f0185f76` |
- **Fairfax Serif:** `FairfaxSerif-Latin.ttf` is a Modified Version (OFL-1.1 §1) of
  `Fairfax/FairfaxSerif.ttf` from `https://github.com/kreativekorp/open-relay` at commit
  `e4b81241e8c7269a91c0bd865cf5c9e7208fbada` (original SHA-256
  `56682d928aab782b4baeefd85453bdbc571240a54105a2125aac8652945df349`). The only change is a
  glyph subset that cuts the file from 4.4 MB to 59 KB, made with fontTools 4.62.1:

  ```
  python3 -m fontTools.subset FairfaxSerif.ttf \
    --unicodes="U+0020-007E,U+00A0-017F,U+2010-2027,U+2030-203A,U+20AC,U+2122" \
    --layout-features='*' --name-IDs='*' --name-languages='*' --notdef-outline \
    --output-file=FairfaxSerif-Latin.ttf
  ```

  The upstream licence declares no Reserved Font Name, so the subset keeps the name
  "Fairfax Serif". It remains under OFL-1.1 (reproduced below, verbatim from upstream `OFL.txt`).

## Pixel Operator: Creative Commons Zero 1.0 Universal

```
Creative Commons Legal Code

CC0 1.0 Universal

    CREATIVE COMMONS CORPORATION IS NOT A LAW FIRM AND DOES NOT PROVIDE
    LEGAL SERVICES. DISTRIBUTION OF THIS DOCUMENT DOES NOT CREATE AN
    ATTORNEY-CLIENT RELATIONSHIP. CREATIVE COMMONS PROVIDES THIS
    INFORMATION ON AN "AS-IS" BASIS. CREATIVE COMMONS MAKES NO WARRANTIES
    REGARDING THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS
    PROVIDED HEREUNDER, AND DISCLAIMS LIABILITY FOR DAMAGES RESULTING FROM
    THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS PROVIDED
    HEREUNDER.

Statement of Purpose

The laws of most jurisdictions throughout the world automatically confer
exclusive Copyright and Related Rights (defined below) upon the creator
and subsequent owner(s) (each and all, an "owner") of an original work of
authorship and/or a database (each, a "Work").

Certain owners wish to permanently relinquish those rights to a Work for
the purpose of contributing to a commons of creative, cultural and
scientific works ("Commons") that the public can reliably and without fear
of later claims of infringement build upon, modify, incorporate in other
works, reuse and redistribute as freely as possible in any form whatsoever
and for any purposes, including without limitation commercial purposes.
These owners may contribute to the Commons to promote the ideal of a free
culture and the further production of creative, cultural and scientific
works, or to gain reputation or greater distribution for their Work in
part through the use and efforts of others.

For these and/or other purposes and motivations, and without any
expectation of additional consideration or compensation, the person
associating CC0 with a Work (the "Affirmer"), to the extent that he or she
is an owner of Copyright and Related Rights in the Work, voluntarily
elects to apply CC0 to the Work and publicly distribute the Work under its
terms, with knowledge of his or her Copyright and Related Rights in the
Work and the meaning and intended legal effect of CC0 on those rights.

1. Copyright and Related Rights. A Work made available under CC0 may be
protected by copyright and related or neighboring rights ("Copyright and
Related Rights"). Copyright and Related Rights include, but are not
limited to, the following:

  i. the right to reproduce, adapt, distribute, perform, display,
     communicate, and translate a Work;
 ii. moral rights retained by the original author(s) and/or performer(s);
iii. publicity and privacy rights pertaining to a person's image or
     likeness depicted in a Work;
 iv. rights protecting against unfair competition in regards to a Work,
     subject to the limitations in paragraph 4(a), below;
  v. rights protecting the extraction, dissemination, use and reuse of data
     in a Work;
 vi. database rights (such as those arising under Directive 96/9/EC of the
     European Parliament and of the Council of 11 March 1996 on the legal
     protection of databases, and under any national implementation
     thereof, including any amended or successor version of such
     directive); and
vii. other similar, equivalent or corresponding rights throughout the
     world based on applicable law or treaty, and any national
     implementations thereof.

2. Waiver. To the greatest extent permitted by, but not in contravention
of, applicable law, Affirmer hereby overtly, fully, permanently,
irrevocably and unconditionally waives, abandons, and surrenders all of
Affirmer's Copyright and Related Rights and associated claims and causes
of action, whether now known or unknown (including existing as well as
future claims and causes of action), in the Work (i) in all territories
worldwide, (ii) for the maximum duration provided by applicable law or
treaty (including future time extensions), (iii) in any current or future
medium and for any number of copies, and (iv) for any purpose whatsoever,
including without limitation commercial, advertising or promotional
purposes (the "Waiver"). Affirmer makes the Waiver for the benefit of each
member of the public at large and to the detriment of Affirmer's heirs and
successors, fully intending that such Waiver shall not be subject to
revocation, rescission, cancellation, termination, or any other legal or
equitable action to disrupt the quiet enjoyment of the Work by the public
as contemplated by Affirmer's express Statement of Purpose.

3. Public License Fallback. Should any part of the Waiver for any reason
be judged legally invalid or ineffective under applicable law, then the
Waiver shall be preserved to the maximum extent permitted taking into
account Affirmer's express Statement of Purpose. In addition, to the
extent the Waiver is so judged Affirmer hereby grants to each affected
person a royalty-free, non transferable, non sublicensable, non exclusive,
irrevocable and unconditional license to exercise Affirmer's Copyright and
Related Rights in the Work (i) in all territories worldwide, (ii) for the
maximum duration provided by applicable law or treaty (including future
time extensions), (iii) in any current or future medium and for any number
of copies, and (iv) for any purpose whatsoever, including without
limitation commercial, advertising or promotional purposes (the
"License"). The License shall be deemed effective as of the date CC0 was
applied by Affirmer to the Work. Should any part of the License for any
reason be judged legally invalid or ineffective under applicable law, such
partial invalidity or ineffectiveness shall not invalidate the remainder
of the License, and in such case Affirmer hereby affirms that he or she
will not (i) exercise any of his or her remaining Copyright and Related
Rights in the Work or (ii) assert any associated claims and causes of
action with respect to the Work, in either case contrary to Affirmer's
express Statement of Purpose.

4. Limitations and Disclaimers.

 a. No trademark or patent rights held by Affirmer are waived, abandoned,
    surrendered, licensed or otherwise affected by this document.
 b. Affirmer offers the Work as-is and makes no representations or
    warranties of any kind concerning the Work, express, implied,
    statutory or otherwise, including without limitation warranties of
    title, merchantability, fitness for a particular purpose, non
    infringement, or the absence of latent or other defects, accuracy, or
    the present or absence of errors, whether or not discoverable, all to
    the greatest extent permissible under applicable law.
 c. Affirmer disclaims responsibility for clearing rights of other persons
    that may apply to the Work or any use thereof, including without
    limitation any person's Copyright and Related Rights in the Work.
    Further, Affirmer disclaims responsibility for obtaining any necessary
    consents, permissions or other rights required for any use of the
    Work.
 d. Affirmer understands and acknowledges that Creative Commons is not a
    party to this document and has no duty or obligation with respect to
    this CC0 or use of the Work.
```

## Fairfax Serif: SIL Open Font License 1.1

```
Copyright (c) 2008-2020 Kreative Software.

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
