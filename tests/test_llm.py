"""Tests for the BYOK LLM layer (backend/llm.py).

Provider SDK calls are mocked — no network, no real keys. We test:
  * JSON parsing / validation (`_parse_problem`)
  * generation orchestration: model resolution, repair-prompt selection, echo
  * provider-exception -> HTTP-status mapping
"""

import json

import pytest

import backend.llm as llm
from backend.llm import DEFAULT_MODELS, LLMError, _parse_problem, generate_problem

VALID = {
    "title": "Two Sum",
    "difficulty": "Easy",
    "topic": "arrays",
    "description": "Find two numbers…",
    "function_name": "two_sum",
    "starter_code": "def two_sum(nums, target):\n    pass",
    "reference_solution": "def two_sum(nums, target):\n    return [0, 1]",
    "tests": [{"input": [[2, 7, 11, 15], 9], "expected": [0, 1]}],
}


def raw(**overrides) -> str:
    return json.dumps({**VALID, **overrides})


# --------------------------------------------------------------------------- #
# _parse_problem
# --------------------------------------------------------------------------- #
class TestParseProblem:
    def test_valid(self):
        p = _parse_problem(raw())
        assert p["title"] == "Two Sum"
        assert p["tests"][0]["expected"] == [0, 1]

    def test_strips_json_code_fence(self):
        p = _parse_problem("```json\n" + raw() + "\n```")
        assert p["function_name"] == "two_sum"

    def test_extracts_from_surrounding_prose(self):
        p = _parse_problem("Sure! Here you go:\n" + raw() + "\nHope that helps.")
        assert p["title"] == "Two Sum"

    def test_tolerates_literal_control_chars(self):
        # A raw newline inside a string value is invalid strict JSON; the parser
        # uses strict=False because models emit these in code snippets.
        text = (
            '{"title":"t","description":"line1\nline2","function_name":"f",'
            '"starter_code":"s","tests":[{"input":[1],"expected":1}]}'
        )
        p = _parse_problem(text)
        assert p["description"] == "line1\nline2"

    @pytest.mark.parametrize(
        "bad",
        [
            "there is no json here",
            json.dumps({"title": "only"}),  # missing required fields
            raw(tests=[]),  # empty test list
        ],
    )
    def test_bad_input_raises_502(self, bad):
        with pytest.raises(LLMError) as ei:
            _parse_problem(bad)
        assert ei.value.status == 502


# --------------------------------------------------------------------------- #
# generate_problem orchestration
# --------------------------------------------------------------------------- #
class TestGenerateOrchestration:
    def test_uses_default_model_when_none(self, monkeypatch):
        seen = {}

        def fake(api_key, model, user_prompt):
            seen["model"] = model
            return raw()

        monkeypatch.setattr(llm, "_call_anthropic", fake)
        p = generate_problem(
            provider="anthropic", api_key="k", model=None, topic="t", difficulty="Easy"
        )
        assert seen["model"] == DEFAULT_MODELS["anthropic"]
        assert p["model"] == DEFAULT_MODELS["anthropic"]  # echoed to the UI

    def test_uses_override_model(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(
            llm, "_call_openai",
            lambda api_key, model, user_prompt: seen.update(model=model) or raw(),
        )
        p = generate_problem(
            provider="openai", api_key="k", model="gpt-fancy", topic="t", difficulty="Easy"
        )
        assert seen["model"] == "gpt-fancy"
        assert p["model"] == "gpt-fancy"

    def test_first_pass_uses_generation_prompt(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(
            llm, "_call_anthropic",
            lambda api_key, model, user_prompt: seen.update(prompt=user_prompt) or raw(),
        )
        generate_problem(
            provider="anthropic", api_key="k", model="m", topic="graphs", difficulty="Hard"
        )
        assert "graphs" in seen["prompt"]
        assert "REPAIR" not in seen["prompt"]

    def test_repair_pass_uses_repair_prompt(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(
            llm, "_call_openai",
            lambda api_key, model, user_prompt: seen.update(prompt=user_prompt) or raw(),
        )

        class _Mismatch:
            def __init__(self, d):
                self._d = d

            def model_dump(self):
                return self._d

        class _Repair:
            problem = {"title": "Prior", "function_name": "f"}
            mismatches = [_Mismatch({"input": [1], "expected": 1, "got": 0, "error": None})]

        generate_problem(
            provider="openai", api_key="k", model="m", topic="t", difficulty="Easy",
            repair=_Repair(),
        )
        assert "REPAIR" in seen["prompt"]
        assert "Prior" in seen["prompt"]  # the prior problem is handed back

    def test_unknown_provider_raises_400(self):
        with pytest.raises(LLMError) as ei:
            generate_problem(
                provider="cohere", api_key="k", model=None, topic="t", difficulty="Easy"
            )
        assert ei.value.status == 400

    def test_demo_routes_to_configured_endpoint(self, monkeypatch):
        monkeypatch.setattr(llm, "DEMO_ENABLED", True)
        monkeypatch.setattr(llm, "DEMO_API_KEY", "demo-key")
        monkeypatch.setattr(llm, "DEMO_BASE_URL", "https://api.groq.com/openai/v1")
        monkeypatch.setattr(llm, "DEMO_MODEL", "llama-demo")
        seen = {}

        def fake(api_key, model, user_prompt, *, base_url=None, json_mode=True, label="OpenAI"):
            seen.update(api_key=api_key, model=model, base_url=base_url, json_mode=json_mode, label=label)
            return raw()

        monkeypatch.setattr(llm, "_call_openai_compatible", fake)
        p = generate_problem(provider="demo", api_key="", model=None, topic="t", difficulty="Easy")

        assert seen["base_url"] == "https://api.groq.com/openai/v1"
        assert seen["model"] == "llama-demo"
        assert seen["api_key"] == "demo-key"      # host key, not the (empty) user key
        assert seen["json_mode"] is False          # max cross-provider compatibility
        assert seen["label"] == "Demo"
        assert p["model"] == "llama-demo"          # echoed to the UI

    def test_demo_unconfigured_raises_503(self):
        # DEMO_ENABLED is False by default in the test environment.
        with pytest.raises(LLMError) as ei:
            generate_problem(provider="demo", api_key="", model=None, topic="t", difficulty="Easy")
        assert ei.value.status == 503


# --------------------------------------------------------------------------- #
# provider exception -> status mapping
# --------------------------------------------------------------------------- #
def _client_raises(monkeypatch, module, ctor_name, exc_cls):
    """Patch a provider SDK so its create() call raises `exc_cls`.

    The instance is built via the class's own __new__ (bypassing __init__, which
    wants an httpx response) — our handlers key off the exception *type* only.
    """
    exc = exc_cls.__new__(exc_cls)

    class _Client:
        def __init__(self, **kwargs):
            self.messages = self          # anthropic: client.messages.create
            self.chat = self              # openai:    client.chat.completions.create
            self.completions = self

        def create(self, **kwargs):
            raise exc

    monkeypatch.setattr(module, ctor_name, _Client)


class TestErrorMapping:
    def test_anthropic_auth_error_maps_401(self, monkeypatch):
        import anthropic

        _client_raises(monkeypatch, anthropic, "Anthropic", anthropic.AuthenticationError)
        with pytest.raises(LLMError) as ei:
            generate_problem(provider="anthropic", api_key="bad", model="m",
                             topic="t", difficulty="Easy")
        assert ei.value.status == 401

    def test_anthropic_not_found_maps_404(self, monkeypatch):
        import anthropic

        _client_raises(monkeypatch, anthropic, "Anthropic", anthropic.NotFoundError)
        with pytest.raises(LLMError) as ei:
            generate_problem(provider="anthropic", api_key="k", model="nope",
                             topic="t", difficulty="Easy")
        assert ei.value.status == 404

    def test_openai_auth_error_maps_401(self, monkeypatch):
        import openai

        _client_raises(monkeypatch, openai, "OpenAI", openai.AuthenticationError)
        with pytest.raises(LLMError) as ei:
            generate_problem(provider="openai", api_key="bad", model="m",
                             topic="t", difficulty="Easy")
        assert ei.value.status == 401

    def test_openai_rate_limit_maps_429(self, monkeypatch):
        import openai

        _client_raises(monkeypatch, openai, "OpenAI", openai.RateLimitError)
        with pytest.raises(LLMError) as ei:
            generate_problem(provider="openai", api_key="k", model="m",
                             topic="t", difficulty="Easy")
        assert ei.value.status == 429
