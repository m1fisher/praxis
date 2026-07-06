# praxis

**LeetCode-style practice, except the problems don't exist until you ask for them.**
Type a topic, pick a difficulty, and an LLM writes a fresh problem — statement,
examples, constraints, and hidden test cases. You solve it in a real editor and
your code is graded against the tests **entirely in your browser**.

Bring your own API key. The server never holds a key and never pays for a token.

---

## Why bring-your-own-key (BYOK)?

Publishing free, open LLM access to the internet means paying for everyone's
tokens and inviting abuse. Praxis sidesteps that:

- You paste **your own** Anthropic or OpenAI key into the settings panel.
- It's saved only in **your browser** (`localStorage`) — never on the server.
- On each request the key is sent as an HTTP header straight through the backend
  to your chosen provider, used for that one call, and **never stored or logged**.

So anyone can host Praxis publicly without footing an API bill, and each user
pays only for their own usage.

## How code execution stays safe

Running arbitrary user code on a server is the classic footgun. Praxis avoids it
completely: submitted Python runs in **[Pyodide](https://pyodide.org)** — CPython
compiled to WebAssembly — inside the user's own browser tab. The server never
executes user code. Test cases are checked client-side.

## Trustworthy problems: the reference self-check

LLMs sometimes miscompute an expected output, which would silently fail a
*correct* solution. To catch this, the model must also return a hidden
**reference solution**. Before a problem is shown, Praxis runs that reference
against every test case (in the same in-browser Pyodide sandbox). If any
`expected` value disagrees with what the reference actually produces, the
problem failed its own self-check and is regenerated (up to a few attempts).
The reference solution is used only for this check — it's never displayed.

---

## Architecture

```
Browser                                   Server (FastAPI)          Provider
┌───────────────────────────┐             ┌──────────────┐          ┌──────────┐
│ Monaco editor  ├─ Run ─────┼─ Pyodide ─▶ (never touches user code) │          │
│ Problem panel             │  (in-tab WASM)                          │          │
│ localStorage: your API key├─ Generate ─▶│ POST /api/    ├─ header ─▶│ Claude / │
│                           │   (key in    │  generate     │  (key)    │ OpenAI   │
│                           │   X-Api-Key) │  ↳ forwards,   │◀──────────│          │
│                           │◀─ problem ───┤   parses JSON  │           │          │
└───────────────────────────┘             └──────────────┘          └──────────┘
```

- **Backend** — Python / [FastAPI](https://fastapi.tiangolo.com). One endpoint,
  `POST /api/generate`, plus static hosting of the frontend. Provider layer in
  `backend/llm.py`, prompt/schema in `backend/prompts.py`.
- **Frontend** — vanilla HTML/CSS/JS. [Monaco](https://microsoft.github.io/monaco-editor/)
  editor, [marked](https://marked.js.org) for problem markdown, Pyodide for
  in-browser grading. No build step.

## Quick start

Requires [uv](https://docs.astral.sh/uv/) (it manages the Python version and deps
for you). Then:

```bash
uv run uvicorn backend.main:app --reload
```

Open <http://localhost:8000>, click **⚙ Key**, paste an Anthropic or OpenAI key,
and hit **Generate**.

> First **Run** downloads the Pyodide runtime (~a few MB) once, then caches it.

## Project layout

```
praxis/
├── pyproject.toml        # deps + project metadata (uv)
├── backend/
│   ├── main.py           # FastAPI app: /api/generate + static hosting
│   ├── llm.py            # BYOK provider layer (Anthropic + OpenAI)
│   └── prompts.py        # problem-generation prompt & JSON schema
└── frontend/
    ├── index.html
    ├── style.css
    └── app.js            # editor, generate, Pyodide test runner
```

## Roadmap ideas

- More languages (Pyodide covers Python; JS via a Web Worker; others via Judge0).
- Save/replay past problems, a "daily" mode, difficulty auto-tuning.
- Streaming problem generation for faster first paint.
- Optional server-side key mode (env var) for personal/self-hosted single-user use.

## Notes & caveats

- The reference self-check catches problems whose `expected` values are
  internally inconsistent, but not a model that misunderstands the task the same
  way in both its reference solution and its tests. A stronger model reduces both.
- Test cases use `==` equality, so problems whose answers allow multiple valid
  orderings should pin a canonical order (the prompt asks the model to do this).
- BYOK keys live in `localStorage` — fine for a personal tool; if you deploy this
  for others, serve it over HTTPS.
