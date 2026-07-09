"use strict";
// Pure, DOM-free helpers and saved-library primitives for praxis.
//
// Loaded as a classic <script> in the browser (attaches to window.PraxisLib)
// AND imported directly by the vitest suite. Keep this file free of DOM /
// Monaco / Pyodide dependencies so it stays unit-testable in jsdom.

const SAVED_KEY = "praxis.saved";

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
  SAVED_KEY, esc, safeIdent, fmt, newId,
  loadLibrary, saveLibrary, removeSaved, makeEntry, isValidEntry, importLibrary,
};

if (typeof window !== "undefined") window.PraxisLib = PraxisLib;
if (typeof globalThis !== "undefined") globalThis.PraxisLib = PraxisLib;
