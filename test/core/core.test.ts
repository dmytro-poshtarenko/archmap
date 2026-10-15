import { describe, expect, it } from "vitest";
import { canonicalJson, hashOf } from "../../src/core/hash.js";
import { mulberry32, seedFrom, shuffle, unitInterval } from "../../src/core/prng.js";

describe("canonical hashing", () => {
  it("ignores key order at every level and drops undefined", () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } };
    const b = { a: { d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashOf(a)).toBe(hashOf(b));
  });

  it("keeps array order significant", () => {
    expect(hashOf([1, 2])).not.toBe(hashOf([2, 1]));
  });
});

describe("seeded randomness", () => {
  it("maps digests into [0, 1)", () => {
    expect(unitInterval("0".repeat(64))).toBe(0);
    const max = unitInterval("f".repeat(64));
    expect(max).toBeLessThan(1);
    expect(max).toBeGreaterThan(0.999);
  });

  it("derives the same seed from the same parts", () => {
    expect(seedFrom("sample", 7)).toBe(seedFrom("sample", 7));
    expect(seedFrom("sample", 7)).not.toBe(seedFrom("sample", 8));
  });

  it("repeats the sequence for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("shuffles deterministically without mutating the input", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const first = shuffle(items, mulberry32(7));
    expect(shuffle(items, mulberry32(7))).toEqual(first);
    expect(items).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect([...first].sort((x, y) => x - y)).toEqual(items);
    expect(first).not.toEqual(items);
  });
});
