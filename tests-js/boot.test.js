import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM, VirtualConsole } from "jsdom";

// Integration/boot smoke test: load index.html + lib.js + app.js as REAL
// <script> elements (runScripts: "dangerously") so that script-level global
// instantiation runs. Unit tests import lib.js alone and miss cross-script
// problems — e.g. a global-name collision between lib.js and app.js throwing
// "redeclaration of non-configurable global property" at parse time, which
// silently kills the whole app. This catches that class of bug.

const front = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend");
const html = readFileSync(path.join(front, "index.html"), "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const libJs = readFileSync(path.join(front, "lib.js"), "utf8");
const appJs = readFileSync(path.join(front, "app.js"), "utf8");

function loadApp() {
  const jsErrors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => jsErrors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost:8000/",
    virtualConsole: vc,
  });
  const { window } = dom;
  // Stub the CDN globals: marked present; Monaco/Pyodide absent (as if blocked).
  window.marked = { parse: (s) => s };
  window.PYODIDE_URL = "about:blank";
  window.MONACO_VS = "about:blank";
  for (const code of [libJs, appJs]) {
    const s = window.document.createElement("script");
    s.textContent = code;
    window.document.body.appendChild(s);
  }
  return { window, jsErrors };
}

describe("frontend boot (lib.js + app.js as real scripts)", () => {
  it("loads with no script errors and exposes PraxisLib", () => {
    const { window, jsErrors } = loadApp();
    expect(jsErrors).toEqual([]);
    expect(window.PraxisLib).toBeTruthy();
  });

  it("wires the Key button to open the settings modal", () => {
    const { window } = loadApp();
    const settings = window.document.getElementById("settings");
    settings.classList.add("hidden"); // boot may auto-open it when no key is set
    window.document.getElementById("open-settings").click();
    expect(settings.classList.contains("hidden")).toBe(false);
  });

  it("every element id app.js wires exists in index.html", () => {
    const ids = [...new Set([...appJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
    const dynamic = new Set(["toast", "fallback-editor"]); // created at runtime
    const missing = ids.filter((id) => !dynamic.has(id) && !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });
});
