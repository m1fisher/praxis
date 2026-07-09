"""The prompt and JSON schema used to ask an LLM to author a coding problem.

The model must return a single JSON object matching PROBLEM_SCHEMA. Tests are
structured so they can be executed in the browser via Pyodide: each test calls
``function_name(*input)`` and compares the result to ``expected`` with ``==``.
"""

# Human-readable description of the exact JSON we expect back. Kept in the
# prompt (rather than relying on provider-specific structured-output APIs) so
# the same prompt works across Anthropic and OpenAI and any model the user
# brings.
SYSTEM_PROMPT = """You are an expert competitive-programming problem author. \
Given a topic and difficulty, you invent one original, self-contained coding \
problem and return it as a SINGLE JSON object — nothing else, no markdown, no \
prose outside the JSON.

The JSON object MUST have exactly these fields:

{
  "title": string,               // short problem title
  "difficulty": "Easy" | "Medium" | "Hard",
  "topic": string,               // the topic you were given
  "description": string,         // Markdown. State the problem clearly.
  "examples": [                  // 1-3 worked examples
    { "input": string, "output": string, "explanation": string }
  ],
  "constraints": [string],       // e.g. "1 <= n <= 10^4"
  "function_name": string,       // snake_case Python identifier the user implements
  "starter_code": string,        // Python function stub, e.g.
                                 // "def two_sum(nums, target):\\n    # your code here\\n    pass"
  "reference_solution": string,  // a COMPLETE, CORRECT Python implementation of
                                 // function_name (NOT a stub). Same signature as
                                 // starter_code.
  "tests": [                     // 4-8 deterministic test cases
    { "input": [ ...positional args... ], "expected": <any JSON value> }
  ],
  "extra_inputs": [              // 15-30 ADDITIONAL inputs, INPUTS ONLY (no
    [ ...positional args... ]    // "expected"). Their outputs are computed by
  ]                              // running reference_solution, so you don't
                                 // supply expected values here.
}

Hard requirements for the tests — these run automatically in a sandbox:
- "input" is a JSON array of the POSITIONAL arguments passed to the function,
  in order. Example: for two_sum(nums, target) with nums=[2,7,11,15], target=9,
  the input is [[2, 7, 11, 15], 9].
- "expected" is the exact value the function must return, as a JSON value.
- The function must be PURE and DETERMINISTIC: no input(), no printing required,
  no randomness, no file/network access, standard library only.
- Return values must be comparable with Python '==' (numbers, strings, bools,
  lists, dicts, tuples-as-lists). Avoid problems whose answer is "any valid
  ordering" unless you fix a canonical order in the description.
- starter_code must define exactly the function named function_name.
- extra_inputs is a list of INPUTS ONLY (each item has the same shape as a
  test's "input": a JSON array of positional args). Do NOT include expected
  values — reference_solution will be run on them to compute the answers.
  Provide 15-30 that stress edge cases: empty/minimal inputs, single elements,
  duplicates, negatives, zeros, boundary values, and larger inputs. Every extra
  input MUST be valid per the constraints (the reference will be called on it).

CRITICAL self-consistency requirement:
- reference_solution is a full, correct implementation, not a stub.
- For EVERY test, reference_solution(*input) MUST return exactly "expected".
  Mentally execute your reference solution on each input and set "expected" to
  its actual return value. Do not guess. Your tests will be run against your
  reference solution automatically; if any "expected" is wrong, the problem is
  rejected.
- Any worked "examples" you show must agree with the reference solution too.

Return ONLY the JSON object."""


def build_user_prompt(topic: str, difficulty: str) -> str:
    topic = (topic or "").strip() or "arrays and hashing"
    difficulty = (difficulty or "Medium").strip().capitalize()
    if difficulty not in {"Easy", "Medium", "Hard"}:
        difficulty = "Medium"
    return (
        f"Create a {difficulty} coding problem about: {topic}\n\n"
        "Return only the JSON object described in the system prompt."
    )


def build_repair_prompt(problem: dict, mismatches: list[dict]) -> str:
    """Ask the model to fix a problem that failed its own self-check.

    `mismatches` are the failing cases from running the model's own
    reference_solution against its tests: each has input, expected (the test's
    claim), got (what the reference actually returned), and error (if it threw).
    """
    import json

    problem_json = json.dumps(problem, indent=2, ensure_ascii=False)

    rows = []
    for m in mismatches:
        inp = json.dumps(m.get("input"), ensure_ascii=False)
        if m.get("error"):
            rows.append(f"- input={inp}: reference_solution raised: {m['error']}")
        else:
            exp = json.dumps(m.get("expected"), ensure_ascii=False)
            got = json.dumps(m.get("got"), ensure_ascii=False)
            rows.append(
                f'- input={inp}: the test says "expected" is {exp}, but running '
                f"reference_solution on this input actually returns {got}"
            )
    mismatch_block = "\n".join(rows)

    return (
        "You previously generated this coding problem:\n\n"
        f"{problem_json}\n\n"
        "It failed an automatic self-check: its own reference_solution disagrees "
        'with its test "expected" values on these cases:\n'
        f"{mismatch_block}\n\n"
        "REPAIR this problem so that reference_solution(*input) == expected for "
        "EVERY test. Determine which side is correct and fix the other: correct "
        'the wrong "expected" values, or fix the bug in reference_solution, or (if '
        "the statement itself is ambiguous) tighten the statement to match. Make "
        "the minimal change that resolves the inconsistency — keep the same "
        "problem, don't invent a new one. Return the FULL corrected JSON object "
        "with all fields, in the exact same schema."
    )
