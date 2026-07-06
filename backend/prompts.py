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
  "tests": [                     // 4-8 deterministic test cases
    { "input": [ ...positional args... ], "expected": <any JSON value> }
  ]
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
