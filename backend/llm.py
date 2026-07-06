"""Bring-your-own-key LLM layer.

The caller's API key arrives per request and is used to construct a fresh
client for that single call. Keys are never stored, cached, or logged. Two
providers are supported: Anthropic (Claude) and OpenAI.
"""

from __future__ import annotations

import json
from typing import Any

from .prompts import SYSTEM_PROMPT, build_user_prompt

# Sensible defaults when the user doesn't pick a specific model. These are the
# user's tokens (BYOK), so we default to strong-but-economical models; the UI
# lets them override with any model string their key can access.
DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-5.4-mini",
}

# Guardrail: cap output so a bad key/model can't run up a huge bill on one call.
# Roomy enough for the problem plus a full reference solution.
MAX_OUTPUT_TOKENS = 6000

REQUIRED_FIELDS = ("title", "description", "function_name", "starter_code", "tests")


class LLMError(Exception):
    """Raised for any user-facing failure; `status` maps to an HTTP code."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def generate_problem(
    *, provider: str, api_key: str, model: str | None, topic: str, difficulty: str
) -> dict[str, Any]:
    provider = (provider or "").strip().lower()
    model = (model or "").strip() or DEFAULT_MODELS.get(provider)

    if provider == "anthropic":
        raw = _call_anthropic(api_key, model, topic, difficulty)
    elif provider == "openai":
        raw = _call_openai(api_key, model, topic, difficulty)
    else:
        raise LLMError(f"Unknown provider: {provider!r}", status=400)

    return _parse_problem(raw)


def _call_anthropic(api_key: str, model: str, topic: str, difficulty: str) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=MAX_OUTPUT_TOKENS,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": build_user_prompt(topic, difficulty)}],
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


def _call_openai(api_key: str, model: str, topic: str, difficulty: str) -> str:
    import openai

    client = openai.OpenAI(api_key=api_key)
    try:
        resp = client.chat.completions.create(
            model=model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_user_prompt(topic, difficulty)},
            ],
        )
    except openai.AuthenticationError:
        raise LLMError("Invalid OpenAI API key.", status=401) from None
    except openai.PermissionDeniedError:
        raise LLMError("This OpenAI key can't access that model.", status=403) from None
    except openai.NotFoundError:
        raise LLMError(f"Model not found: {model!r}.", status=404) from None
    except openai.RateLimitError:
        raise LLMError("OpenAI rate limit hit — try again shortly.", status=429) from None
    except openai.APIError as e:
        raise LLMError(f"OpenAI error: {e}", status=502) from None

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
