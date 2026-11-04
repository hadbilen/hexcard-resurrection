import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BITMAP_HEIGHT,
  BITMAP_WIDTH,
  PACKED_BYTES,
  TOTAL_PIXELS,
  decodeBitmapRLE,
  encodeBitmapRLE,
} from "../rleCodec";

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Deterministic xorshift32 so the fuzz cases are reproducible. */
function rng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function filled(v: number): Uint8Array {
  return new Uint8Array(TOTAL_PIXELS).fill(v);
}

/** 8x8 checkerboard cells in states 1/2. */
function checkerboard(): Uint8Array {
  const p = new Uint8Array(TOTAL_PIXELS);
  for (let y = 0; y < BITMAP_HEIGHT; y++) {
    for (let x = 0; x < BITMAP_WIDTH; x++) p[y * BITMAP_WIDTH + x] = ((x ^ y) & 1) + 1;
  }
  return p;
}

/** Ordered-dither-like noise of 1/2 pixels. */
function dithered(seed: number): Uint8Array {
  const r = rng(seed);
  const p = new Uint8Array(TOTAL_PIXELS);
  for (let i = 0; i < TOTAL_PIXELS; i++) p[i] = r() < 0.5 ? 1 : 2;
  return p;
}

function random3State(seed: number): Uint8Array {
  const r = rng(seed);
  const p = new Uint8Array(TOTAL_PIXELS);
  for (let i = 0; i < TOTAL_PIXELS; i++) p[i] = Math.floor(r() * 3);
  return p;
}

describe("rleCodec constants", () => {
  it("matches the 512x342 layer geometry", () => {
    expect(TOTAL_PIXELS).toBe(175_104);
    expect(PACKED_BYTES).toBe(43_776);
  });
});

describe("encodeBitmapRLE", () => {
  it("encodes an all-transparent layer to the empty string", () => {
    expect(encodeBitmapRLE(filled(0))).toBe("");
  });

  it("packs MSB-first, 4 pixels per byte", () => {
    const p = new Uint8Array(TOTAL_PIXELS);
    p[0] = 1; // 01 00 00 00 = 0x40
    p[1] = 2; // 01 10 00 00 = 0x60
    p[2] = 2; // 01 10 10 00 = 0x68
    p[3] = 1; // 01 10 10 01 = 0x69
    const decoded = atob(encodeBitmapRLE(p));
    // First PackBits item is a literal that starts with the packed byte 0x69,
    // followed by a run of zero bytes.
    expect(decoded.charCodeAt(0)).toBe(0); // literal of 1 byte
    expect(decoded.charCodeAt(1)).toBe(0x69);
  });

  it("compresses solid fills far below the packed size", () => {
    expect(encodeBitmapRLE(filled(1)).length).toBe(912);
    expect(encodeBitmapRLE(filled(2)).length).toBe(912);
  });

  it("stays below the packed size for dithered content (literal runs)", () => {
    const encoded = encodeBitmapRLE(dithered(7));
    // Base64 of at most packed bytes plus one header per 128 literal bytes.
    expect(encoded.length).toBeLessThan(Math.ceil(((PACKED_BYTES * 129) / 128 + 2) / 3) * 4 + 4);
  });

  it("throws on a wrong buffer length", () => {
    expect(() => encodeBitmapRLE(new Uint8Array(TOTAL_PIXELS - 1))).toThrow(/length/);
    expect(() => encodeBitmapRLE(new Uint8Array(TOTAL_PIXELS + 1))).toThrow(/length/);
    expect(() => encodeBitmapRLE(new Uint8Array(0))).toThrow(/length/);
  });

  it("throws on a state above 2", () => {
    const p = filled(1);
    p[1234] = 3;
    expect(() => encodeBitmapRLE(p)).toThrow(/state/);
    p[1234] = 255;
    expect(() => encodeBitmapRLE(p)).toThrow(/state/);
  });
});

describe("round trip", () => {
  const cases: Array<[string, () => Uint8Array]> = [
    ["blank", () => filled(0)],
    ["solid light", () => filled(1)],
    ["solid dark", () => filled(2)],
    ["checkerboard", checkerboard],
    ["dithered", () => dithered(42)],
    ["random 3-state", () => random3State(99)],
  ];
  for (const [name, make] of cases) {
    it(`restores ${name} exactly`, () => {
      const p = make();
      expect(decodeBitmapRLE(encodeBitmapRLE(p))).toEqual(p);
    });
  }

  it("restores a single non-transparent pixel at the first and last index", () => {
    for (const idx of [0, TOTAL_PIXELS - 1]) {
      const p = new Uint8Array(TOTAL_PIXELS);
      p[idx] = 2;
      expect(decodeBitmapRLE(encodeBitmapRLE(p))).toEqual(p);
    }
  });

  it("restores 40 seeded fuzz layers with varying run structure", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 7919);
      const p = new Uint8Array(TOTAL_PIXELS);
      let i = 0;
      while (i < TOTAL_PIXELS) {
        const len = 1 + Math.floor(r() * (r() < 0.5 ? 6 : 3000));
        const v = Math.floor(r() * 3);
        const noisy = r() < 0.3;
        for (let k = 0; k < len && i < TOTAL_PIXELS; k++, i++) {
          p[i] = noisy ? Math.floor(r() * 3) : v;
        }
      }
      expect(decodeBitmapRLE(encodeBitmapRLE(p))).toEqual(p);
    }
  });

  it("property: decode(encode(P)) equals P for any valid buffer", () => {
    // **Validates: Requirements 1.1, 1.2**
    const runs = fc.array(
      fc.record({
        len: fc.integer({ min: 1, max: 5000 }),
        state: fc.constantFrom(0, 1, 2),
        noisy: fc.boolean(),
        seed: fc.integer({ min: 1, max: 2 ** 30 }),
      }),
      { minLength: 1, maxLength: 60 },
    );
    fc.assert(
      fc.property(runs, (segments) => {
        const p = new Uint8Array(TOTAL_PIXELS);
        let i = 0;
        for (const s of segments) {
          const r = rng(s.seed);
          for (let k = 0; k < s.len && i < TOTAL_PIXELS; k++, i++) {
            p[i] = s.noisy ? Math.floor(r() * 3) : s.state;
          }
        }
        const encoded = encodeBitmapRLE(p);
        expect(decodeBitmapRLE(encoded)).toEqual(p);
        // An all-transparent buffer is the only one that encodes to "".
        expect(encoded === "").toBe(p.every((v) => v === 0));
      }),
      { numRuns: 25 },
    );
  });
});

describe("decodeBitmapRLE empty layer", () => {
  it('decodes "" to all 0 by default (card layer)', () => {
    const p = decodeBitmapRLE("");
    expect(p.length).toBe(TOTAL_PIXELS);
    expect(p.every((v) => v === 0)).toBe(true);
  });

  it('decodes "" to all 1 for a background layer', () => {
    const p = decodeBitmapRLE("", 1);
    expect(p.length).toBe(TOTAL_PIXELS);
    expect(p.every((v) => v === 1)).toBe(true);
  });
});

describe("decodeBitmapRLE corruption", () => {
  const valid = (): number[] => {
    const bin = atob(encodeBitmapRLE(checkerboard()));
    return Array.from(bin, (c) => c.charCodeAt(0));
  };

  it("rejects truncated data", () => {
    const bytes = valid();
    expect(() => decodeBitmapRLE(toBase64(bytes.slice(0, bytes.length - 1)))).toThrow(/Corrupt/);
    expect(() => decodeBitmapRLE(toBase64(bytes.slice(0, Math.floor(bytes.length / 2))))).toThrow(/Corrupt/);
  });

  it("rejects a repeat header with its byte missing", () => {
    // 129 = repeat next byte 128 times, but no byte follows.
    expect(() => decodeBitmapRLE(toBase64([129]))).toThrow(/Corrupt/);
  });

  it("rejects a literal that runs past the end of the data", () => {
    expect(() => decodeBitmapRLE(toBase64([5, 1, 2]))).toThrow(/Corrupt/);
  });

  it("rejects a run that overflows the packed size", () => {
    // PACKED_BYTES = 342 * 128: fill all but one byte, then add a full run.
    const bytes: number[] = [];
    for (let n = 0; n < PACKED_BYTES / 128 - 1; n++) bytes.push(129, 0x55);
    bytes.push(257 - 127, 0x55); // 127 of the last 128 bytes
    bytes.push(129, 0x55); // 128 more, only 1 byte of room left
    expect(() => decodeBitmapRLE(toBase64(bytes))).toThrow(/run overflow/);
  });

  it("rejects a literal that overflows the packed size", () => {
    const bytes: number[] = [];
    for (let n = 0; n < PACKED_BYTES / 128 - 1; n++) bytes.push(129, 0x55);
    bytes.push(257 - 127, 0x55); // 127 of the last 128 bytes
    bytes.push(1, 0x55, 0x55); // literal of 2 bytes, only 1 byte of room left
    expect(() => decodeBitmapRLE(toBase64(bytes))).toThrow(/literal overflow/);
  });

  it("rejects trailing bytes after a complete layer", () => {
    expect(() => decodeBitmapRLE(toBase64([...valid(), 0, 0x55]))).toThrow(/Corrupt/);
    expect(() => decodeBitmapRLE(toBase64([...valid(), 128]))).toThrow(/Corrupt/);
  });

  it("rejects data that decodes to state 3", () => {
    const bytes: number[] = [];
    for (let n = 0; n < PACKED_BYTES / 128; n++) bytes.push(129, n === 0 ? 0xff : 0x55);
    expect(() => decodeBitmapRLE(toBase64(bytes))).toThrow(/state 3/);
    // A single 0b11 pair in the middle of a byte.
    const mid: number[] = [0, 0b01110100];
    let remaining = PACKED_BYTES - 1;
    while (remaining > 0) {
      const n = Math.min(128, remaining);
      mid.push(257 - n, 0x55);
      remaining -= n;
    }
    expect(() => decodeBitmapRLE(toBase64(mid))).toThrow(/state 3/);
  });

  it("accepts the PackBits no-op header 128", () => {
    const bytes: number[] = [];
    for (let n = 0; n < PACKED_BYTES / 128; n++) bytes.push(128, 129, 0x55);
    const p = decodeBitmapRLE(toBase64(bytes));
    expect(p.every((v) => v === 1)).toBe(true);
  });

  it("rejects invalid Base64", () => {
    expect(() => decodeBitmapRLE("!!!not base64!!!")).toThrow();
  });

  it("fuzz: random single-byte mutations either throw or decode to valid states", () => {
    const base = valid();
    const r = rng(2024);
    for (let n = 0; n < 200; n++) {
      const bytes = base.slice();
      bytes[Math.floor(r() * bytes.length)] = Math.floor(r() * 256);
      try {
        const p = decodeBitmapRLE(toBase64(bytes));
        expect(p.length).toBe(TOTAL_PIXELS);
        expect(p.every((v) => v <= 2)).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });
});
