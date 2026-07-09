"use strict";

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const LS = {
  get provider() { return localStorage.getItem("praxis.provider") || "anthropic"; },
  set provider(v) { localStorage.setItem("praxis.provider", v); },
  get key() { return localStorage.getItem("praxis.key") || ""; },
  set key(v) { localStorage.setItem("praxis.key", v); },
  get model() { return localStorage.getItem("praxis.model") || ""; },
  set model(v) { localStorage.setItem("praxis.model", v); },
  clear() { ["provider", "key", "model"].forEach((k) => localStorage.removeItem("praxis." + k)); },
};

let currentProblem = null;
let editor = null;
let pyodide = null;      // lazily loaded
let pyodideLoading = null;

// How many times to regenerate if a problem fails its own reference self-check.
const MAX_GEN_ATTEMPTS = 3;

// Mirror of the backend defaults (backend/llm.py DEFAULT_MODELS) so we can show
// the resolved model *before* the response arrives. The response also echoes
// the authoritative model, which we prefer once we have it.
const DEFAULT_MODELS = { anthropic: "claude-sonnet-4-6", openai: "gpt-5.4-mini" };
function resolvedModel() { return LS.model || DEFAULT_MODELS[LS.provider] || LS.provider; }

// Pure helpers + saved-library primitives — defined in lib.js so they can be
// unit-tested in isolation (see tests-js/lib.test.js).
const { esc, safeIdent, fmt, makeEntry, isValidEntry, importLibrary, loadLibrary, saveLibrary, removeSaved } =
  window.PraxisLib;

// ---------- toast ----------
let toastTimer = null;
function toast(msg) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 5000);
}

// ---------- settings modal ----------
function openSettings() {
  $("provider").value = LS.provider;
  $("api-key").value = LS.key;
  $("model").value = LS.model;
  $("settings").classList.remove("hidden");
}
function closeSettings() { $("settings").classList.add("hidden"); }
function saveSettings() {
  LS.provider = $("provider").value;
  LS.key = $("api-key").value.trim();
  LS.model = $("model").value.trim();
  updateModelIndicator();
  closeSettings();
}
function clearKey() {
  LS.clear();
  $("api-key").value = "";
  $("model").value = "";
  toast("Key cleared from this browser.");
}

// ---------- Monaco ----------
function initEditor() {
  require.config({ paths: { vs: window.MONACO_VS } });
  require(["vs/editor/editor.main"], () => {
    editor = monaco.editor.create($("editor"), {
      value: "# Generate a problem, then write your solution here.\n",
      language: "python",
      theme: "vs-dark",
      fontSize: 14,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: 4,
    });
  });
}

// ---------- progress + model indicator ----------
function updateModelIndicator() {
  const el = $("model-indicator");
  if (el) el.innerHTML = `via <code>${esc(resolvedModel())}</code>`;
}
function showProgress(on) {
  const el = $("progress");
  el.classList.toggle("hidden", !on);
  if (!on) el.classList.remove("stage-writing", "stage-checking");
}
function setProgressStage(stage) {
  const el = $("progress");
  el.classList.remove("stage-writing", "stage-checking");
  if (stage) el.classList.add(`stage-${stage}`);
}
// Render the generating state with a two-step stepper (Write → Self-check) so
// the panel reflects which stage we're in, plus the attempt count on repairs.
function showStage({ stage, attempt, model, detail }) {
  setProgressStage(stage === "checking" ? "checking" : "writing");
  const steps = [
    { label: attempt > 1 ? "Repair the problem" : "Write the problem",
      state: stage === "checking" ? "done" : "active" },
    { label: "Self-check the answer key",
      state: stage === "checking" ? "active" : "pending" },
  ];
  const icon = (st) =>
    st === "done" ? '<span class="cl-ico done">✓</span>'
    : st === "active" ? '<span class="cl-ico spin"></span>'
    : '<span class="cl-ico pending"></span>';
  const rows = steps
    .map((s) => `<div class="cl-row ${s.state}">${icon(s.state)}<span class="cl-label">${esc(s.label)}</span></div>`)
    .join("");
  const attemptBadge = attempt > 1 ? `<div class="gen-attempt">Attempt ${attempt} of ${MAX_GEN_ATTEMPTS}</div>` : "";
  $("problem").innerHTML = `
    <div class="gen-state">
      <div class="checklist">${rows}</div>
      <div class="gen-phase">${esc(detail)}</div>
      ${attemptBadge}
      <div class="model-chip">via <code>${esc(model)}</code></div>
    </div>`;
}

// ---------- generate ----------
async function fetchProblem(topic, difficulty, repair) {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Provider": LS.provider,
      "X-Api-Key": LS.key,
    },
    body: JSON.stringify({ topic, difficulty, model: LS.model || null, repair: repair || null }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Request failed (${res.status}).`);
  }
  return res.json();
}

async function generate() {
  const topic = $("topic").value.trim();
  if (!topic) { toast("Enter a topic first."); return; }
  if (!LS.key) { toast("Add your API key in ⚙ Key first."); openSettings(); return; }

  const btn = $("generate");
  const original = btn.textContent;
  btn.disabled = true;
  showProgress(true);

  const model = resolvedModel();

  try {
    const difficulty = $("difficulty").value;
    let problem = null;
    let verified = false;
    let unverifiable = false;

    // Generate, then self-check the model's own reference solution against its
    // test cases. If they disagree, hand the mismatch back to the model so it
    // can *repair* the problem rather than starting over.
    let repair = null; // { problem, mismatches } — null on the first attempt
    for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
      btn.innerHTML = `<span class="spinner"></span>${attempt === 1 ? "Generating…" : "Repairing…"}`;
      showStage({
        stage: "writing",
        attempt,
        model,
        detail: attempt === 1
          ? `Writing a ${difficulty} problem…`
          : "Repairing the problem to fix its self-check…",
      });
      problem = await fetchProblem(topic, difficulty, repair);

      const fn = safeIdent(problem.function_name);
      if (!problem.reference_solution || !fn) { unverifiable = true; break; }

      try {
        await ensurePyodide();
      } catch {
        unverifiable = true; // runtime unavailable — show the problem unverified
        break;
      }

      const nTests = (problem.tests || []).length;
      showStage({
        stage: "checking",
        attempt,
        model: problem.model || model,
        detail: `Running the reference solution against ${nTests} test${nTests === 1 ? "" : "s"}…`,
      });

      // The problem-so-far we hand back for repair (strip our injected `model`).
      const prior = { ...problem };
      delete prior.model;

      let cases;
      try {
        ({ cases } = await evaluate(problem.reference_solution, fn, problem.tests, false));
      } catch (e) {
        // The reference couldn't even run — feed that back as the thing to fix.
        repair = { problem: prior, mismatches: [{ error: String(e.message || e) }] };
        continue;
      }

      if (cases.length && cases.every((c) => c.ok)) { verified = true; break; }

      // Collect the disagreements and repair (not replace) on the next attempt.
      repair = {
        problem: prior,
        mismatches: cases
          .filter((c) => !c.ok)
          .map((c) => ({ input: c.input, expected: c.expected, got: c.got, error: c.error })),
      };
    }

    applyProblem(problem);

    if (verified) {
      setResults('<div class="summary pass">✓ self-checked</div><span class="muted">The reference solution passes all hidden tests. Write yours and hit Run.</span>');
    } else if (unverifiable) {
      setResults('<span class="muted">Ready. (Couldn\'t self-verify — no runtime or reference solution.) Write your solution and hit Run.</span>');
    } else {
      setResults('<div class="summary fail">⚠ unverified</div><span class="muted">This problem failed its own self-check after several tries — the expected outputs may be off. Consider regenerating, or treat test results with caution.</span>');
    }
  } catch (e) {
    toast(e.message);
    $("problem").innerHTML = `
      <div class="gen-state">
        <div class="gen-phase" style="color:var(--red)">Generation failed</div>
        <div class="model-chip">${esc(e.message)}</div>
      </div>`;
  } finally {
    showProgress(false);
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------- render problem ----------
function renderProblem(p) {
  const diff = ["Easy", "Medium", "Hard"].includes(p.difficulty) ? p.difficulty : "Medium";
  const examples = (p.examples || []).map((ex) => `
    <div class="example">
      <div class="row"><span class="lbl">Input</span><br><code>${esc(ex.input)}</code></div>
      <div class="row"><span class="lbl">Output</span><br><code>${esc(ex.output)}</code></div>
      ${ex.explanation ? `<div class="row"><span class="lbl">Explanation</span><br>${esc(ex.explanation)}</div>` : ""}
    </div>`).join("");
  const constraints = (p.constraints || []).map((c) => `<li><code>${esc(c)}</code></li>`).join("");

  $("problem").innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h1 style="margin:0">${esc(p.title || "Untitled")}</h1>
      <span class="badge ${diff}">${diff}</span>
      ${p.model ? `<span class="model-chip">via <code>${esc(p.model)}</code></span>` : ""}
    </div>
    <div style="margin:16px 0">${marked.parse(p.description || "")}</div>
    ${examples ? `<h2>Examples</h2>${examples}` : ""}
    ${constraints ? `<h2>Constraints</h2><ul>${constraints}</ul>` : ""}
  `;
}

// ---------- results panel ----------
function setResults(html) { $("results-body").innerHTML = html; }

// ---------- apply a problem to the workspace ----------
function applyProblem(problem, code) {
  currentProblem = problem;
  renderProblem(problem);
  if (editor) editor.setValue(code != null ? code : (problem.starter_code || ""));
  $("run").disabled = false;
  $("reset-code").disabled = false;
  $("save-problem").disabled = false;
  $("fn-label").textContent = problem.function_name ? `def ${problem.function_name}(…)` : "";
}

// ---------- saved library (localStorage) ----------
// The pure primitives (loadLibrary/saveLibrary/makeEntry/isValidEntry/
// importLibrary/…) live in lib.js and are pulled in via the destructure near
// the top of this file. Below is just the app/DOM glue around them.

function saveCurrent() {
  if (!currentProblem) return;
  const lib = loadLibrary();
  lib.unshift(makeEntry(currentProblem, editor ? editor.getValue() : ""));
  saveLibrary(lib);
  toast(`Saved “${currentProblem.title || "problem"}” to your library.`);
}

function exportLibrary() {
  const lib = loadLibrary();
  if (!lib.length) { toast("Nothing saved yet."); return; }
  const blob = new Blob([JSON.stringify(lib, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "praxis-saved.json";
  a.click();
  URL.revokeObjectURL(url);
}

async function onImportFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = ""; // allow re-importing the same file
  if (!file) return;
  try {
    const n = importLibrary(await file.text());
    renderSavedList();
    toast(`Imported ${n} problem${n === 1 ? "" : "s"}.`);
  } catch (e) {
    toast(e.message);
  }
}

// ---------- saved modal ----------
function openSavedModal() { renderSavedList(); $("saved-modal").classList.remove("hidden"); }
function closeSavedModal() { $("saved-modal").classList.add("hidden"); }

function renderSavedList() {
  const lib = loadLibrary();
  const body = $("saved-list");
  if (!lib.length) {
    body.innerHTML = '<p class="muted">No saved problems yet. Generate one and hit ★ Save.</p>';
    return;
  }
  body.innerHTML = lib.map((e) => {
    const diff = ["Easy", "Medium", "Hard"].includes(e.difficulty) ? e.difficulty : "Medium";
    return `<div class="saved-row">
      <div class="saved-main">
        <span class="badge ${diff}">${diff}</span>
        <span class="saved-title">${esc(e.title || "Untitled")}</span>
        ${e.topic ? `<span class="muted saved-topic">· ${esc(e.topic)}</span>` : ""}
        <span class="muted saved-when">${esc((e.savedAt || "").slice(0, 10))}</span>
      </div>
      <div class="saved-actions">
        <button class="btn ghost saved-open" data-id="${esc(e.id)}">Open</button>
        <button class="btn ghost saved-del" data-id="${esc(e.id)}">Delete</button>
      </div>
    </div>`;
  }).join("");
}

function onSavedListClick(ev) {
  const openBtn = ev.target.closest(".saved-open");
  const delBtn = ev.target.closest(".saved-del");
  if (openBtn) {
    const entry = loadLibrary().find((x) => x.id === openBtn.dataset.id);
    if (entry) openSaved(entry);
  } else if (delBtn) {
    removeSaved(delBtn.dataset.id);
    renderSavedList();
  }
}

// Load a saved problem back into the workspace and re-run its self-check.
async function openSaved(entry) {
  closeSavedModal();
  applyProblem(entry.problem, entry.code != null ? entry.code : (entry.problem.starter_code || ""));

  const fn = safeIdent(entry.problem.function_name);
  if (entry.problem.reference_solution && fn) {
    try {
      await ensurePyodide();
      const { cases } = await evaluate(entry.problem.reference_solution, fn, entry.problem.tests, false);
      const ok = cases.length && cases.every((c) => c.ok);
      setResults(ok
        ? '<div class="summary pass">✓ loaded — self-check still passes</div><span class="muted">Your saved code is in the editor. Hit Run.</span>'
        : '<div class="summary fail">⚠ loaded — self-check fails now</div><span class="muted">This saved problem no longer agrees with its reference; treat results with caution.</span>');
      return;
    } catch { /* runtime unavailable — fall through */ }
  }
  setResults('<span class="muted">Loaded a saved problem. Write/adjust your solution and hit Run.</span>');
}

// ---------- Pyodide runner ----------
// UI-silent: safe to call eagerly in the background at startup.
async function ensurePyodide() {
  if (pyodide) return pyodide;
  if (!pyodideLoading) {
    pyodideLoading = (async () => {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = window.PYODIDE_URL + "pyodide.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("Failed to load Pyodide."));
        document.head.appendChild(s);
      });
      pyodide = await loadPyodide({ indexURL: window.PYODIDE_URL });
      return pyodide;
    })();
  }
  return pyodideLoading;
}

// Python harness: define the candidate function (via `code`), then call it on
// every test input and compare to `expected`. Tests are passed as base64 JSON
// so no delimiter/escaping in the data can break the source. The last
// expression is a JSON string of per-case results.
function buildHarness(fn, tests) {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(tests || []))));
  return `
import json as _json, base64 as _b64, io as _io, contextlib as _ctx
_tests = _json.loads(_b64.b64decode("${b64}").decode("utf-8"))
_fn = globals().get(${JSON.stringify(fn)})
_out = []
if not callable(_fn):
    _out = [{"ok": False, "error": "Function '${fn}' is not defined.", "input": None, "expected": None, "got": None, "stdout": ""}]
else:
    for _t in _tests:
        _args = _t["input"] if isinstance(_t["input"], (list, tuple)) else [_t["input"]]
        _buf = _io.StringIO()  # capture this call's prints, tied to this test
        try:
            with _ctx.redirect_stdout(_buf):
                _got = _fn(*_args)
            _out.append({"ok": _got == _t["expected"], "got": _got,
                         "expected": _t["expected"], "input": list(_args),
                         "error": None, "stdout": _buf.getvalue()})
        except Exception as _e:
            _out.append({"ok": False, "got": None, "expected": _t["expected"],
                         "input": list(_args), "error": repr(_e),
                         "stdout": _buf.getvalue()})
_json.dumps(_out, default=repr)
`;
}

// Run `code` (which must define `fn`) against `tests` in a FRESH namespace, so
// reference-check runs and user runs never leak state into one another.
async function evaluate(code, fn, tests, capture) {
  const py = await ensurePyodide();
  let stdout = "";
  py.setStdout({ batched: capture ? (s) => { stdout += s + "\n"; } : () => {} });

  const ns = py.toPy({}); // fresh Python dict used as module globals
  try {
    const resultsJson = await py.runPythonAsync(code + "\n" + buildHarness(fn, tests), { globals: ns });
    return { cases: JSON.parse(resultsJson), stdout };
  } finally {
    ns.destroy();
  }
}

async function runCode() {
  if (!currentProblem) return;
  const fn = safeIdent(currentProblem.function_name);
  if (!fn) { toast("This problem has an invalid function name."); return; }

  const runBtn = $("run");
  runBtn.disabled = true;
  try {
    await ensurePyodide();
    setResults('<span class="spinner"></span> Running tests…');
    const { cases, stdout } = await evaluate(editor.getValue(), fn, currentProblem.tests, true);
    renderResults(cases, stdout);
  } catch (e) {
    // Syntax errors / exceptions raised while defining the function land here.
    setResults(`<div class="summary fail">Error</div><div class="case fail"><div class="row">${esc(e.message || e)}</div></div>`);
  } finally {
    runBtn.disabled = false;
  }
}

function renderResults(cases, stdout) {
  const passed = cases.filter((c) => c.ok).length;
  const total = cases.length;
  const allPass = passed === total;

  let html = `<div class="summary ${allPass ? "pass" : "fail"}">${allPass ? "✓ Accepted" : "✗ Wrong Answer"} — ${passed}/${total} tests passed</div>`;
  // Module-level prints (outside the function) — rare; per-test prints show in-case.
  if (stdout && stdout.trim()) {
    html += `<div class="stdout"><span class="muted">module output</span>\n${esc(stdout.trimEnd())}</div>`;
  }
  cases.forEach((c, i) => {
    const out = (c.stdout || "").replace(/\s+$/, "");
    html += `<div class="case ${c.ok ? "pass" : "fail"}">
      <div class="row"><span class="k">Test ${i + 1}:</span> ${c.ok ? "✓ passed" : "✗ failed"}</div>
      ${c.input !== null ? `<div class="row"><span class="k">input:</span> ${esc(fmt(c.input))}</div>` : ""}
      ${!c.ok && c.error ? `<div class="row"><span class="k">error:</span> ${esc(c.error)}</div>` : ""}
      ${!c.ok && !c.error ? `<div class="row"><span class="k">expected:</span> ${esc(fmt(c.expected))}</div>
        <div class="row"><span class="k">got:</span> ${esc(fmt(c.got))}</div>` : ""}
      ${out ? `<div class="row case-stdout"><span class="k">stdout:</span>\n${esc(out)}</div>` : ""}
    </div>`;
  });
  setResults(html);
}

// ---------- resizable divider ----------
function initDivider() {
  const divider = $("divider");
  const left = $("left");
  let dragging = false;
  divider.addEventListener("mousedown", () => { dragging = true; document.body.style.cursor = "col-resize"; });
  window.addEventListener("mouseup", () => { dragging = false; document.body.style.cursor = ""; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const total = $("left").parentElement.clientWidth;
    const pct = Math.min(75, Math.max(25, (e.clientX / total) * 100));
    left.style.flex = `0 0 ${pct}%`;
  });
}

// ---------- wire up ----------
window.addEventListener("DOMContentLoaded", () => {
  initEditor();
  initDivider();

  $("generate").addEventListener("click", generate);
  $("topic").addEventListener("keydown", (e) => { if (e.key === "Enter") generate(); });
  $("run").addEventListener("click", runCode);
  $("reset-code").addEventListener("click", () => {
    if (currentProblem && editor) editor.setValue(currentProblem.starter_code || "");
  });

  $("open-settings").addEventListener("click", openSettings);
  $("close-settings").addEventListener("click", closeSettings);
  $("save-settings").addEventListener("click", saveSettings);
  $("clear-key").addEventListener("click", clearKey);
  $("settings").addEventListener("click", (e) => { if (e.target.id === "settings") closeSettings(); });

  // saved library
  $("save-problem").addEventListener("click", saveCurrent);
  $("open-saved").addEventListener("click", openSavedModal);
  $("close-saved").addEventListener("click", closeSavedModal);
  $("saved-modal").addEventListener("click", (e) => { if (e.target.id === "saved-modal") closeSavedModal(); });
  $("export-lib").addEventListener("click", exportLibrary);
  $("import-lib").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", onImportFile);
  $("saved-list").addEventListener("click", onSavedListClick);

  updateModelIndicator();

  // Warm up the Python runtime in the background so the first problem's
  // self-check (and the first Run) don't wait on the download.
  ensurePyodide().catch(() => {});

  if (!LS.key) openSettings();
});
