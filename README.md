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
mismatch is handed back to the model — along with the problem so far — and it's
asked to **repair** (not regenerate) the problem, up to a few attempts. The
reference solution is used only for this check — it's never displayed.

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

## Free demo mode (optional — no key for visitors)

Let people try the app without their own API key by pointing a **"Demo"** provider
at a free, OpenAI-compatible endpoint using a key **you** hold. The key stays in
server env and is never sent to browsers.

**Defaults target Groq's free tier**, so you only need one env var — a `gsk_...`
key from [console.groq.com](https://console.groq.com):

```bash
PRAXIS_DEMO_API_KEY=gsk_your_key_here uv run uvicorn backend.main:app --reload
```

To use a different provider, override the base URL and model too:

| Provider | `PRAXIS_DEMO_BASE_URL` | `PRAXIS_DEMO_MODEL` (example) |
|---|---|---|
| **Groq** (default) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.0-flash` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | a `:free` model |

When `PRAXIS_DEMO_API_KEY` is set, a **Demo (free — no key)** option appears in the
provider dropdown; picking it hides the key field. When unset, the option simply
doesn't appear. The demo runs on the host's free-tier quota, so keep it behind the
password gate and expect the occasional rate-limit if it gets busy.

## Sharing it with someone (temporary)

Expose your locally-running app over a public HTTPS URL via an ephemeral
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/),
gated by a shared password:

```bash
brew install cloudflared      # one-time
PRAXIS_AUTH_USER=friend PRAXIS_AUTH_PASSWORD='pick-a-password' make share
```

It prints a `https://<random>.trycloudflare.com` URL — share that plus the
login. Notes:

- Your Mac must stay on and awake while they use it (the tunnel points at your
  machine); Ctrl+C stops both the app and the tunnel.
- The URL is random and changes each run. It's meant for a quick session, not a
  standing link — for always-on, deploy to a host and set the same
  `PRAXIS_AUTH_USER` / `PRAXIS_AUTH_PASSWORD` env vars there.
- Everything is BYOK: your friend needs their own Anthropic/OpenAI key.

The password gate (`PRAXIS_AUTH_USER` + `PRAXIS_AUTH_PASSWORD`) is off unless
both env vars are set, so local dev is unaffected.

## Project layout

```
praxis/
├── pyproject.toml        # deps + project metadata (uv)
├── backend/
│   ├── main.py           # FastAPI app: /api/generate + static hosting
│   ├── llm.py            # BYOK provider layer (Anthropic + OpenAI)
│   └── prompts.py        # problem-generation prompt & JSON schema
├── frontend/
│   ├── index.html
│   ├── style.css
│   ├── lib.js            # pure, DOM-free helpers + saved-library logic (unit-tested)
│   └── app.js            # editor, generate, Pyodide runner, saved-library glue
├── tests/                # pytest suite (prompts, parsing, API, grading harness)
├── tests-js/             # vitest suite (frontend/lib.js)
└── package.json          # JS dev deps (vitest, jsdom)
```

## Tests

Run everything (builds both environments on demand):

```bash
make test        # backend + frontend
# also: make install | make test-py | make test-js | make run | make help
```

Or run each suite directly:

**Backend (pytest):**

```bash
uv run pytest
```

Covers prompt construction, LLM response parsing/validation, provider
dispatch and error→HTTP-status mapping (SDKs mocked — no network, no keys), the
FastAPI endpoints, and a contract test mirroring the in-browser grading harness.

**Frontend (vitest + jsdom):**

```bash
npm install   # first time
npm test
```

Covers the pure, DOM-free logic in `frontend/lib.js` — HTML escaping, identifier
validation, and the saved-library primitives (build/validate entries,
load/save/remove, and import merging with id-collision handling). DOM/rendering
glue in `app.js` isn't unit-tested.

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
