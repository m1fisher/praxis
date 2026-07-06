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

// ---------- generate ----------
async function generate() {
  const topic = $("topic").value.trim();
  if (!topic) { toast("Enter a topic first."); return; }
  if (!LS.key) { toast("Add your API key in ⚙ Key first."); openSettings(); return; }

  const btn = $("generate");
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating…';

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider": LS.provider,
        "X-Api-Key": LS.key,
      },
      body: JSON.stringify({
        topic,
        difficulty: $("difficulty").value,
        model: LS.model || null,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Request failed (${res.status}).`);
    }

    currentProblem = await res.json();
    renderProblem(currentProblem);
    if (editor) editor.setValue(currentProblem.starter_code || "");
    $("run").disabled = false;
    $("reset-code").disabled = false;
    $("fn-label").textContent = currentProblem.function_name
      ? `def ${currentProblem.function_name}(…)`
      : "";
    setResults('<span class="muted">Ready. Write your solution and hit Run.</span>');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------- render problem ----------
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

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
    </div>
    <div style="margin:16px 0">${marked.parse(p.description || "")}</div>
    ${examples ? `<h2>Examples</h2>${examples}` : ""}
    ${constraints ? `<h2>Constraints</h2><ul>${constraints}</ul>` : ""}
  `;
}

// ---------- results panel ----------
function setResults(html) { $("results-body").innerHTML = html; }

// ---------- Pyodide runner ----------
async function ensurePyodide() {
  if (pyodide) return pyodide;
  if (!pyodideLoading) {
    setResults('<span class="spinner"></span> Loading the Python runtime (first run only)…');
    pyodideLoading = (async () => {
      // loadPyodide is provided by the pyodide.js script we inject here.
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

function safeIdent(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name || "") ? name : null;
}

async function runCode() {
  if (!currentProblem) return;
  const fn = safeIdent(currentProblem.function_name);
  if (!fn) { toast("This problem has an invalid function name."); return; }

  const runBtn = $("run");
  runBtn.disabled = true;
  const userCode = editor.getValue();

  try {
    const py = await ensurePyodide();
    setResults('<span class="spinner"></span> Running tests…');

    // Capture stdout from the user's own print() calls.
    let stdout = "";
    py.setStdout({ batched: (s) => { stdout += s + "\n"; } });

    // 1) Define the user's function.
    await py.runPythonAsync(userCode);

    // 2) Feed the test cases in as a Python object, then run the harness.
    py.globals.set("_tests", py.toPy(currentProblem.tests || []));
    const harness = `
import json as _json
_fn = globals().get(${JSON.stringify(fn)})
_out = []
if not callable(_fn):
    _out = [{"ok": False, "error": "Function '${fn}' is not defined.", "input": None, "expected": None, "got": None}]
else:
    for _t in _tests:
        _args = _t["input"] if isinstance(_t["input"], (list, tuple)) else [_t["input"]]
        try:
            _got = _fn(*_args)
            _out.append({"ok": _got == _t["expected"], "got": _got,
                         "expected": _t["expected"], "input": list(_args), "error": None})
        except Exception as _e:
            _out.append({"ok": False, "got": None, "expected": _t["expected"],
                         "input": list(_args), "error": repr(_e)})
_json.dumps(_out, default=repr)
`;
    const resultsJson = await py.runPythonAsync(harness);
    renderResults(JSON.parse(resultsJson), stdout);
  } catch (e) {
    // Syntax errors / exceptions raised while defining the function land here.
    setResults(`<div class="summary fail">Error</div><div class="case fail"><div class="row">${esc(e.message || e)}</div></div>`);
  } finally {
    runBtn.disabled = false;
  }
}

function fmt(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function renderResults(cases, stdout) {
  const passed = cases.filter((c) => c.ok).length;
  const total = cases.length;
  const allPass = passed === total;

  let html = `<div class="summary ${allPass ? "pass" : "fail"}">${allPass ? "✓ Accepted" : "✗ Wrong Answer"} — ${passed}/${total} tests passed</div>`;
  if (stdout && stdout.trim()) {
    html += `<div class="stdout"><span class="muted">stdout</span>\n${esc(stdout.trimEnd())}</div>`;
  }
  cases.forEach((c, i) => {
    html += `<div class="case ${c.ok ? "pass" : "fail"}">
      <div class="row"><span class="k">Test ${i + 1}:</span> ${c.ok ? "✓ passed" : "✗ failed"}</div>
      ${c.input !== null ? `<div class="row"><span class="k">input:</span> ${esc(fmt(c.input))}</div>` : ""}
      ${!c.ok && c.error ? `<div class="row"><span class="k">error:</span> ${esc(c.error)}</div>` : ""}
      ${!c.ok && !c.error ? `<div class="row"><span class="k">expected:</span> ${esc(fmt(c.expected))}</div>
        <div class="row"><span class="k">got:</span> ${esc(fmt(c.got))}</div>` : ""}
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

  if (!LS.key) openSettings();
});
