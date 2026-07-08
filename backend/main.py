"""FastAPI app: serves the static frontend and one BYOK generation endpoint.

The API key and provider are passed as request headers (never in the body, so
they don't end up in access logs) and are forwarded straight to the provider
for a single call. Nothing about the key is persisted or logged.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .llm import generate_problem, LLMError

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="Praxis", description="LLM-generated LeetCode-style practice.")


@app.middleware("http")
async def no_store(request, call_next):
    """Disable browser caching so edits to the static frontend show up on reload.
    Fine for a local/dev tool; add real caching + asset versioning for prod."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


class Mismatch(BaseModel):
    """One failing self-check case: the reference disagreed with `expected`."""

    input: Any = None
    expected: Any = None
    got: Any = None
    error: str | None = None


class RepairContext(BaseModel):
    """Hands a failed problem back to the model to fix rather than regenerate."""

    problem: dict
    mismatches: list[Mismatch]


class GenerateRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=200)
    difficulty: str = "Medium"
    model: str | None = None
    repair: RepairContext | None = None


@app.post("/api/generate")
def generate(
    req: GenerateRequest,
    x_provider: str = Header(..., alias="X-Provider"),
    x_api_key: str = Header(..., alias="X-Api-Key"),
) -> dict:
    """Generate a coding problem using the caller's own API key."""
    if not x_api_key.strip():
        raise HTTPException(status_code=401, detail="Missing API key.")
    try:
        return generate_problem(
            provider=x_provider,
            api_key=x_api_key,
            model=req.model,
            topic=req.topic,
            difficulty=req.difficulty,
            repair=req.repair,
        )
    except LLMError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from None


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


# Serve the SPA last so /api/* routes take precedence. html=True makes "/"
# return index.html.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
