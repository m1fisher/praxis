"""Tests for the FastAPI surface (backend/main.py)."""

import base64

import pytest
from fastapi.testclient import TestClient

import backend.main as main
from backend.llm import LLMError

client = TestClient(main.app)

AUTH = {"X-Provider": "anthropic", "X-Api-Key": "sk-test"}


def _basic(user, pw):
    token = base64.b64encode(f"{user}:{pw}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


class TestBasicAuthGate:
    def test_disabled_by_default(self):
        # No PRAXIS_AUTH_* env set => site is open (all other tests rely on this).
        assert client.get("/").status_code == 200

    def test_enabled_blocks_without_credentials(self, monkeypatch):
        monkeypatch.setattr(main, "_AUTH_USER", "friend")
        monkeypatch.setattr(main, "_AUTH_PASS", "s3cret")
        r = client.get("/")
        assert r.status_code == 401
        assert r.headers.get("WWW-Authenticate", "").startswith("Basic")

    def test_correct_credentials_pass(self, monkeypatch):
        monkeypatch.setattr(main, "_AUTH_USER", "friend")
        monkeypatch.setattr(main, "_AUTH_PASS", "s3cret")
        assert client.get("/", headers=_basic("friend", "s3cret")).status_code == 200

    def test_wrong_credentials_rejected(self, monkeypatch):
        monkeypatch.setattr(main, "_AUTH_USER", "friend")
        monkeypatch.setattr(main, "_AUTH_PASS", "s3cret")
        assert client.get("/", headers=_basic("friend", "nope")).status_code == 401

    def test_health_stays_open_for_probes(self, monkeypatch):
        monkeypatch.setattr(main, "_AUTH_USER", "friend")
        monkeypatch.setattr(main, "_AUTH_PASS", "s3cret")
        assert client.get("/api/health").status_code == 200


class TestStaticAndHealth:
    def test_health(self):
        assert client.get("/api/health").json() == {"ok": True}

    def test_index_served(self):
        r = client.get("/")
        assert r.status_code == 200
        assert "<title>" in r.text

    def test_static_assets_served(self):
        assert client.get("/app.js").status_code == 200
        assert client.get("/style.css").status_code == 200

    def test_no_store_header(self):
        # Dev caching is disabled so frontend edits show up on reload.
        for path in ("/", "/app.js", "/style.css", "/api/health"):
            assert client.get(path).headers.get("cache-control") == "no-store"


class TestGenerateEndpoint:
    def test_missing_headers_is_422(self):
        # X-Provider / X-Api-Key are required headers.
        assert client.post("/api/generate", json={"topic": "t"}).status_code == 422

    def test_blank_key_is_401(self):
        r = client.post(
            "/api/generate",
            json={"topic": "t"},
            headers={"X-Provider": "anthropic", "X-Api-Key": "   "},
        )
        assert r.status_code == 401

    def test_unknown_provider_is_400(self):
        # Reaches the real generate_problem, which rejects before any network call.
        r = client.post(
            "/api/generate",
            json={"topic": "t"},
            headers={"X-Provider": "bogus", "X-Api-Key": "k"},
        )
        assert r.status_code == 400

    def test_happy_path_returns_problem(self, monkeypatch):
        monkeypatch.setattr(
            main, "generate_problem",
            lambda **kw: {"title": "Generated", "tests": [], "model": "m"},
        )
        r = client.post("/api/generate", json={"topic": "arrays"}, headers=AUTH)
        assert r.status_code == 200
        assert r.json()["title"] == "Generated"

    def test_llm_error_maps_to_its_status(self, monkeypatch):
        def boom(**kw):
            raise LLMError("no access to that model", status=403)

        monkeypatch.setattr(main, "generate_problem", boom)
        r = client.post("/api/generate", json={"topic": "t"}, headers=AUTH)
        assert r.status_code == 403
        assert r.json()["detail"] == "no access to that model"

    def test_forwards_repair_context(self, monkeypatch):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return {"ok": True}

        monkeypatch.setattr(main, "generate_problem", capture)
        body = {
            "topic": "t",
            "repair": {
                "problem": {"title": "Prior"},
                "mismatches": [{"input": [1], "expected": 1, "got": 0}],
            },
        }
        client.post("/api/generate", json=body, headers={"X-Provider": "openai", "X-Api-Key": "k"})

        assert seen["repair"] is not None
        assert seen["repair"].problem["title"] == "Prior"
        assert seen["repair"].mismatches[0].got == 0

    def test_topic_length_validation(self):
        # Empty topic fails pydantic's min_length before any provider work.
        r = client.post("/api/generate", json={"topic": ""}, headers=AUTH)
        assert r.status_code == 422
