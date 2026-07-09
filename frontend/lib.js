"use strict";
// Pure, DOM-free helpers and saved-library primitives for praxis.
//
// Wrapped in an IIFE so ONLY `window.PraxisLib` leaks to the global scope. If
// these were top-level declarations in this classic script, their names (esc,
// fmt, …) would become globals and collide with app.js's
// `const { esc, fmt, … } = window.PraxisLib` — two classic scripts share one
// global scope, so that throws "redeclaration of non-configurable global
// property". Keep everything private here; export only via PraxisLib.
//
// Loaded as a classic <script> in the browser AND imported by the vitest suite
// (which reads globalThis.PraxisLib). No DOM / Monaco / Pyodide dependencies.
(function () {
  const SAVED_KEY = "praxis.saved";

  // Curated model choices per provider for the settings dropdown. These can go
  // stale as providers ship/retire models — the UI always also offers "Default"
  // and a "Custom…" free-text option, so this list is convenience, not a limit.
  const MODEL_OPTIONS = {
    anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function safeIdent(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name || "") ? name : null;
  }

  function fmt(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  function fmtMs(ms) {
    if (!isFinite(ms)) return "—";
    if (ms >= 10) return `${ms.toFixed(0)} ms`;
    if (ms >= 1) return `${ms.toFixed(1)} ms`;
    return `${ms.toFixed(2)} ms`;
  }

  // Compare seconds-per-pass of the user's vs the reference solution. Returns
  // null when either measurement is missing or non-positive (too fast to trust).
  function runtimeVerdict(userSec, refSec) {
    if (userSec == null || refSec == null || userSec <= 0 || refSec <= 0) return null;
    const userMs = userSec * 1000;
    const refMs = refSec * 1000;
    const ratio = userSec / refSec;
    let label, cls;
    if (ratio < 0.9) { label = `~${(1 / ratio).toFixed(1)}× faster than reference`; cls = "fast"; }
    else if (ratio <= 1.1) { label = "about the same as reference"; cls = "same"; }
    else { label = `~${ratio.toFixed(1)}× slower than reference`; cls = "slow"; }
    return { userMs, refMs, ratio, label, cls };
  }

  function newId() { return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

  function loadLibrary() {
    try {
      const v = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  function saveLibrary(arr) { localStorage.setItem(SAVED_KEY, JSON.stringify(arr)); }
  function removeSaved(id) { saveLibrary(loadLibrary().filter((e) => e.id !== id)); }

  function makeEntry(problem, code) {
    return {
      id: newId(),
      savedAt: new Date().toISOString(),
      title: problem.title || "Untitled",
      difficulty: problem.difficulty || "Medium",
      topic: problem.topic || "",
      model: problem.model || "",
      problem,          // full problem (statement, tests, reference, …)
      code: code || "", // the user's solution at save time
    };
  }

  // An entry is usable only if it carries a runnable problem.
  function isValidEntry(e) {
    return !!(e && e.problem && typeof e.problem.function_name === "string"
      && Array.isArray(e.problem.tests) && typeof e.problem.starter_code === "string");
  }

  // Merge exported entries into the library; returns how many were imported.
  function importLibrary(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("That file isn't valid JSON."); }
    const incoming = Array.isArray(data) ? data : [data];
    const existing = new Set(loadLibrary().map((e) => e.id));
    const valid = incoming.filter(isValidEntry).map((e) => ({
      ...e,
      id: e.id && !existing.has(e.id) ? e.id : newId(), // avoid id collisions
      savedAt: e.savedAt || new Date().toISOString(),
      title: e.title || e.problem.title || "Untitled",
      difficulty: e.difficulty || e.problem.difficulty || "Medium",
      topic: e.topic || e.problem.topic || "",
      code: typeof e.code === "string" ? e.code : "",
    }));
    if (!valid.length) throw new Error("No valid saved problems in that file.");
    saveLibrary([...valid, ...loadLibrary()]);
    return valid.length;
  }

  const PraxisLib = {
    SAVED_KEY, MODEL_OPTIONS, esc, safeIdent, fmt, fmtMs, runtimeVerdict, newId,
    loadLibrary, saveLibrary, removeSaved, makeEntry, isValidEntry, importLibrary,
  };

  if (typeof window !== "undefined") window.PraxisLib = PraxisLib;
  if (typeof globalThis !== "undefined") globalThis.PraxisLib = PraxisLib;
})();
