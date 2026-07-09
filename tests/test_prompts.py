"""Tests for prompt construction (backend/prompts.py)."""

from backend.prompts import SYSTEM_PROMPT, build_user_prompt, build_repair_prompt


def test_system_prompt_requests_reference_and_extra_inputs():
    # The self-check needs a reference; the expanded suite needs inputs-only.
    assert "reference_solution" in SYSTEM_PROMPT
    assert "extra_inputs" in SYSTEM_PROMPT


class TestUserPrompt:
    def test_contains_topic_and_difficulty(self):
        p = build_user_prompt("binary search", "Hard")
        assert "binary search" in p
        assert "Hard" in p

    def test_difficulty_is_normalized(self):
        assert "Medium" in build_user_prompt("x", "medium")
        assert "Easy" in build_user_prompt("x", "EASY")

    def test_unknown_difficulty_falls_back_to_medium(self):
        assert "Medium" in build_user_prompt("x", "impossible")

    def test_blank_topic_falls_back(self):
        # Empty topic shouldn't produce an empty request.
        p = build_user_prompt("   ", "Medium")
        assert "arrays and hashing" in p


class TestRepairPrompt:
    PROBLEM = {
        "title": "Min Spread",
        "function_name": "find_min_spread_day",
        "reference_solution": "def find_min_spread_day(a, b): ...",
        "tests": [{"input": [[5.0, 6.0], [4.5, 6.5]], "expected": 1}],
    }

    def test_renders_expected_vs_got(self):
        s = build_repair_prompt(
            self.PROBLEM,
            [{"input": [[5.0, 6.0], [4.5, 6.5]], "expected": 1, "got": 0, "error": None}],
        )
        assert "REPAIR" in s
        assert "actually returns 0" in s
        assert '"expected" is 1' in s

    def test_includes_the_problem_json(self):
        s = build_repair_prompt(self.PROBLEM, [{"input": [1], "expected": 1, "got": 0}])
        assert "Min Spread" in s
        assert "find_min_spread_day" in s

    def test_error_mismatch_is_rendered(self):
        s = build_repair_prompt(self.PROBLEM, [{"input": [1], "error": "ValueError('boom')"}])
        assert "raised" in s
        assert "ValueError('boom')" in s
