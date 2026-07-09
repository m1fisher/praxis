import { beforeEach, describe, expect, it } from "vitest";
import "../frontend/lib.js"; // side-effect: sets globalThis.PraxisLib

const lib = globalThis.PraxisLib;

beforeEach(() => localStorage.clear());

describe("MODEL_OPTIONS", () => {
  it("lists models for both providers including the defaults", () => {
    expect(Array.isArray(lib.MODEL_OPTIONS.anthropic)).toBe(true);
    expect(Array.isArray(lib.MODEL_OPTIONS.openai)).toBe(true);
    expect(lib.MODEL_OPTIONS.anthropic).toContain("claude-sonnet-4-6");
    expect(lib.MODEL_OPTIONS.openai).toContain("gpt-5.4-mini");
  });
});

describe("esc", () => {
  it("escapes HTML-significant characters", () => {
    expect(lib.esc('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
  it("coerces non-strings", () => {
    expect(lib.esc(42)).toBe("42");
  });
});

describe("safeIdent", () => {
  it("accepts valid Python identifiers", () => {
    expect(lib.safeIdent("two_sum")).toBe("two_sum");
    expect(lib.safeIdent("_x1")).toBe("_x1");
  });
  it("rejects invalid identifiers", () => {
    for (const bad of ["1abc", "has space", "a-b", "def()", "", null, undefined]) {
      expect(lib.safeIdent(bad)).toBeNull();
    }
  });
});

describe("fmt", () => {
  it("serializes JSON values", () => {
    expect(lib.fmt([1, 2])).toBe("[1,2]");
    expect(lib.fmt({ a: 1 })).toBe('{"a":1}');
  });
  it("falls back to String for non-serializable values", () => {
    expect(lib.fmt(10n)).toBe("10"); // BigInt throws in JSON.stringify
  });
});

describe("fmtMs", () => {
  it("formats by magnitude", () => {
    expect(lib.fmtMs(123.4)).toBe("123 ms");
    expect(lib.fmtMs(3.45)).toBe("3.5 ms");
    expect(lib.fmtMs(0.42)).toBe("0.42 ms");
    expect(lib.fmtMs(Infinity)).toBe("—");
  });
});

describe("runtimeVerdict", () => {
  it("flags a faster solution", () => {
    const v = lib.runtimeVerdict(0.001, 0.002); // user 2x faster
    expect(v.cls).toBe("fast");
    expect(v.label).toMatch(/2\.0× faster/);
  });
  it("flags a slower solution", () => {
    const v = lib.runtimeVerdict(0.003, 0.001); // user 3x slower
    expect(v.cls).toBe("slow");
    expect(v.label).toMatch(/3\.0× slower/);
  });
  it("calls near-equal times 'about the same'", () => {
    expect(lib.runtimeVerdict(0.00101, 0.001).cls).toBe("same");
  });
  it("returns null when a measurement is missing or non-positive", () => {
    expect(lib.runtimeVerdict(null, 0.001)).toBeNull();
    expect(lib.runtimeVerdict(0, 0.001)).toBeNull();
    expect(lib.runtimeVerdict(0.001, 0)).toBeNull();
  });
});

describe("makeEntry", () => {
  it("captures the problem, code, and metadata", () => {
    const p = {
      title: "T", difficulty: "Hard", topic: "graphs", model: "m",
      function_name: "f", tests: [], starter_code: "s",
    };
    const e = lib.makeEntry(p, "print(1)");
    expect(e.title).toBe("T");
    expect(e.difficulty).toBe("Hard");
    expect(e.topic).toBe("graphs");
    expect(e.model).toBe("m");
    expect(e.code).toBe("print(1)");
    expect(e.problem).toBe(p);
    expect(e.id).toMatch(/^p_/);
    expect(typeof e.savedAt).toBe("string");
  });
  it("defaults missing metadata and empty code", () => {
    const e = lib.makeEntry({ function_name: "f", tests: [], starter_code: "s" });
    expect(e.title).toBe("Untitled");
    expect(e.difficulty).toBe("Medium");
    expect(e.topic).toBe("");
    expect(e.code).toBe("");
  });
});

describe("isValidEntry", () => {
  it("accepts a runnable entry", () => {
    expect(lib.isValidEntry({ problem: { function_name: "f", tests: [], starter_code: "s" } })).toBe(true);
  });
  it("rejects malformed entries", () => {
    const bad = [
      null,
      {},
      { problem: {} },
      { problem: { function_name: "f" } },
      { problem: { function_name: "f", tests: "not-array", starter_code: "s" } },
      { problem: { function_name: 5, tests: [], starter_code: "s" } },
    ];
    for (const b of bad) expect(lib.isValidEntry(b)).toBe(false);
  });
});

describe("loadLibrary / saveLibrary / removeSaved", () => {
  it("round-trips through localStorage", () => {
    lib.saveLibrary([{ id: "a" }, { id: "b" }]);
    expect(lib.loadLibrary().map((e) => e.id)).toEqual(["a", "b"]);
  });
  it("returns [] for empty or corrupt storage", () => {
    expect(lib.loadLibrary()).toEqual([]);
    localStorage.setItem(lib.SAVED_KEY, "{ not json");
    expect(lib.loadLibrary()).toEqual([]);
    localStorage.setItem(lib.SAVED_KEY, '{"not":"an array"}');
    expect(lib.loadLibrary()).toEqual([]);
  });
  it("removes an entry by id", () => {
    lib.saveLibrary([{ id: "a" }, { id: "b" }]);
    lib.removeSaved("a");
    expect(lib.loadLibrary().map((e) => e.id)).toEqual(["b"]);
  });
});

describe("importLibrary", () => {
  const entry = (id) => ({
    id,
    problem: { function_name: "f", tests: [], starter_code: "s", title: "T" },
    code: "c",
  });

  it("throws on invalid JSON", () => {
    expect(() => lib.importLibrary("{ nope")).toThrow(/valid JSON/);
  });
  it("throws when there is nothing valid to import", () => {
    expect(() => lib.importLibrary(JSON.stringify([{ problem: {} }]))).toThrow(/No valid/);
  });
  it("imports an array and skips invalid entries", () => {
    const n = lib.importLibrary(JSON.stringify([entry("a"), { junk: true }, entry("b")]));
    expect(n).toBe(2);
    expect(lib.loadLibrary().map((e) => e.id).sort()).toEqual(["a", "b"]);
  });
  it("wraps a single object", () => {
    expect(lib.importLibrary(JSON.stringify(entry("solo")))).toBe(1);
    expect(lib.loadLibrary()).toHaveLength(1);
  });
  it("preserves code and reassigns colliding ids", () => {
    lib.saveLibrary([entry("dup")]);
    lib.importLibrary(JSON.stringify(entry("dup")));
    const merged = lib.loadLibrary();
    expect(merged).toHaveLength(2);
    expect(merged.every((e) => e.code === "c")).toBe(true);
    expect(new Set(merged.map((e) => e.id)).size).toBe(2); // ids are unique
  });
  it("puts imported entries ahead of existing ones", () => {
    lib.saveLibrary([entry("old")]);
    lib.importLibrary(JSON.stringify(entry("new")));
    expect(lib.loadLibrary().map((e) => e.id)).toEqual(["new", "old"]);
  });
});
