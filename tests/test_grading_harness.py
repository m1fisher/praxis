"""Contract test for the in-browser grading harness.

The real grader is Python that runs in Pyodide, embedded as a string in
`frontend/app.js` (see buildHarness). This test mirrors that logic in CPython to
lock the *contract* we depend on: per-test equality, per-test stdout capture,
exception handling with partial stdout, and single-arg wrapping.

⚠️ If you change buildHarness in app.js, mirror the change here.
"""

import contextlib
import io


def run_against_tests(fn, tests):
    """Mirror of buildHarness's per-test loop."""
    out = []
    for t in tests:
        args = t["input"] if isinstance(t["input"], (list, tuple)) else [t["input"]]
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                got = fn(*args)
            out.append({
                "ok": got == t["expected"], "got": got, "expected": t["expected"],
                "input": list(args), "error": None, "stdout": buf.getvalue(),
            })
        except Exception as e:  # noqa: BLE001 - harness reports, never crashes
            out.append({
                "ok": False, "got": None, "expected": t["expected"],
                "input": list(args), "error": repr(e), "stdout": buf.getvalue(),
            })
    return out


def test_pass_and_fail_are_detected():
    res = run_against_tests(
        lambda n: n * 2,
        [{"input": [3], "expected": 6}, {"input": [5], "expected": 999}],
    )
    assert res[0]["ok"] is True and res[0]["got"] == 6
    assert res[1]["ok"] is False and res[1]["got"] == 10


def test_stdout_is_captured_per_test():
    def solve(n):
        print(f"processing {n}")
        return n

    res = run_against_tests(solve, [{"input": [3], "expected": 3}, {"input": [5], "expected": 5}])
    # Each test carries ONLY its own output — no lumping.
    assert res[0]["stdout"] == "processing 3\n"
    assert res[1]["stdout"] == "processing 5\n"


def test_exception_is_caught_with_partial_stdout():
    def solve(n):
        print("before boom")
        raise ValueError("nope")

    res = run_against_tests(solve, [{"input": [1], "expected": 1}])
    case = res[0]
    assert case["ok"] is False
    assert "ValueError" in case["error"]
    assert case["stdout"] == "before boom\n"  # output before the raise is preserved


def test_single_nonlist_input_is_wrapped_as_one_arg():
    res = run_against_tests(lambda x: x + 1, [{"input": 4, "expected": 5}])
    assert res[0]["ok"] is True
    assert res[0]["input"] == [4]


def test_list_input_is_splatted_as_positional_args():
    res = run_against_tests(lambda a, b: a + b, [{"input": [2, 3], "expected": 5}])
    assert res[0]["ok"] is True
