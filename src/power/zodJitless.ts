// The first import of main.ts (spec 07 Requirement 3.3; design §zodJitless.ts). Zod 4 decides
// when a schema is constructed whether it may generate code from strings, and stackValidator.ts and
// astValidator.ts build their schemas when they are evaluated. In the server bundle modules
// evaluate in import order, so this module runs after Zod's core and before every HexCard module:
// no schema ever takes the code-generating path, and Zod's `new Function("")` probe is skipped.

import { z } from "zod";

z.config({ jitless: true });
