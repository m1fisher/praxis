"""Bring-your-own-key LLM layer.

The caller's API key arrives per request and is used to construct a fresh
client for that single call. Keys are never stored, cached, or logged. Two
providers are supported: Anthropic (Claude) and OpenAI.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .prompts import SYSTEM_PROMPT, build_user_prompt, build_repair_prompt

# Optional server-hosted "Demo" provider: a free/cheap OpenAI-COMPATIBLE endpoint
# using a key the HOST supplies via env, so people can try the app without their
# own key. The key stays server-side and is never sent to the browser.
#
# Defaults target Groq's free tier — so setting just PRAXIS_DEMO_API_KEY (a
# `gsk_...` key from console.groq.com) is enough to enable it. Override the base
# URL / model to point at Google Gemini, OpenRouter, Cerebras, etc.
DEMO_API_KEY = os.environ.get("PRAXIS_DEMO_API_KEY")
DEMO_BASE_URL = os.environ.get("PRAXIS_DEMO_BASE_URL", "https://api.groq.com/openai/v1")
DEMO_MODEL = os.environ.get("PRAXIS_DEMO_MODEL", "llama-3.3-70b-versatile")
DEMO_ENABLED = bool(DEMO_API_KEY)

# Sensible defaults when the user doesn't pick a specific model. These are the
# user's tokens (BYOK), so we default to strong-but-economical models; the UI
# lets them override with any model string their key can access.
DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-5.4-mini",
}

# Anthropic's Messages API *requires* max_tokens, so we must pass one. This is a
# generous hard ceiling (a problem + full reference solution is well under this)
# — not a tight budget — so it never truncates valid output. OpenAI is left
# uncapped: on GPT-5-series the cap is `max_completion_tokens` and counts
# reasoning tokens, so a tight limit there would do more harm than good.
ANTHROPIC_MAX_TOKENS = 16000

REQUIRED_FIELDS = ("title", "description", "function_name", "starter_code", "tests")


class LLMError(Exception):
    """Raised for any user-facing failure; `status` maps to an HTTP code."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def generate_problem(
    *,
    provider: str,
    api_key: str,
    model: str | None,
    topic: str,
    difficulty: str,
    repair: Any = None,
) -> dict[str, Any]:
    provider = (provider or "").strip().lower()

    # On a repair pass, hand the model its own problem plus the self-check
    # mismatches and ask it to fix them — rather than starting over.
    if repair is not None:
        mismatches = [m.model_dump() for m in repair.mismatches]
        user_prompt = build_repair_prompt(repair.problem, mismatches)
    else:
        user_prompt = build_user_prompt(topic, difficulty)

    if provider == "demo":
        if not DEMO_ENABLED:
            raise LLMError("Demo mode isn't available on this server.", status=503)
        model = DEMO_MODEL  # host-configured; the user's key is ignored
        raw = _call_openai_compatible(
            DEMO_API_KEY, model, user_prompt,
            base_url=DEMO_BASE_URL, json_mode=False, label="Demo",
        )
    elif provider == "anthropic":
        model = (model or "").strip() or DEFAULT_MODELS["anthropic"]
        raw = _call_anthropic(api_key, model, user_prompt)
    elif provider == "openai":
        model = (model or "").strip() or DEFAULT_MODELS["openai"]
        raw = _call_openai(api_key, model, user_prompt)
    else:
        raise LLMError(f"Unknown provider: {provider!r}", status=400)

    problem = _parse_problem(raw)
    problem["model"] = model  # echo the resolved model so the UI can show it
    return problem


def _call_anthropic(api_key: str, model: str, user_prompt: str) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=ANTHROPIC_MAX_TOKENS,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
    except anthropic.AuthenticationError:
        raise LLMError("Invalid Anthropic API key.", status=401) from None
    except anthropic.PermissionDeniedError:
        raise LLMError("This Anthropic key can't access that model.", status=403) from None
    except anthropic.NotFoundError:
        raise LLMError(f"Model not found: {model!r}.", status=404) from None
    except anthropic.RateLimitError:
        raise LLMError("Anthropic rate limit hit — try again shortly.", status=429) from None
    except anthropic.APIError as e:  # network / 5xx / anything else
        raise LLMError(f"Anthropic error: {e}", status=502) from None

    return "".join(block.text for block in resp.content if block.type == "text")


def _call_openai(api_key: str, model: str, user_prompt: str) -> str:
    return _call_openai_compatible(api_key, model, user_prompt, label="OpenAI")


def _call_openai_compatible(
    api_key: str,
    model: str,
    user_prompt: str,
    *,
    base_url: str | None = None,
    json_mode: bool = True,
    label: str = "OpenAI",
) -> str:
    """Call any OpenAI-compatible chat endpoint (OpenAI, or a `base_url` override
    for Groq/Gemini/OpenRouter/… in demo mode). `json_mode` off maximizes cross-
    provider compatibility (not all support response_format); parsing is robust."""
    import openai

    client = openai.OpenAI(api_key=api_key, base_url=base_url)  # base_url=None => OpenAI
    params: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    }
    if json_mode:
        params["response_format"] = {"type": "json_object"}
    try:
        resp = client.chat.completions.create(**params)
    except openai.AuthenticationError:
        raise LLMError(f"Invalid {label} API key.", status=401) from None
    except openai.PermissionDeniedError:
        raise LLMError(f"This {label} key can't access that model.", status=403) from None
    except openai.NotFoundError:
        raise LLMError(f"Model not found: {model!r}.", status=404) from None
    except openai.RateLimitError:
        raise LLMError(f"{label} rate limit hit — try again shortly.", status=429) from None
    except openai.APIError as e:
        raise LLMError(f"{label} error: {e}", status=502) from None

    return resp.choices[0].message.content or ""


def _parse_problem(text: str) -> dict[str, Any]:
    """Extract and validate the JSON object from a model response."""
    text = (text or "").strip()

    # Tolerate a stray ```json fence even though we ask for raw JSON.
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]

    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise LLMError("The model did not return valid JSON.", status=502)

    try:
        # strict=False tolerates literal control chars (e.g. raw newlines inside
        # a string), which models occasionally emit in code snippets.
        data = json.loads(text[start : end + 1], strict=False)
    except json.JSONDecodeError as e:
        raise LLMError(f"Could not parse the generated problem: {e}", status=502) from None

    missing = [f for f in REQUIRED_FIELDS if f not in data]
    if missing:
        raise LLMError(
            f"Generated problem is missing fields: {', '.join(missing)}", status=502
        )
    if not isinstance(data.get("tests"), list) or not data["tests"]:
        raise LLMError("Generated problem has no test cases.", status=502)

    return data
