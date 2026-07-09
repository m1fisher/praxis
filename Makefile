# praxis — common tasks. Environments are built on demand; `make test` runs both
# the Python (pytest) and JS (vitest) suites.

.PHONY: test test-py test-js install run clean help
.DEFAULT_GOAL := help

## test: run all tests (backend + frontend)
test: test-py test-js

## test-py: run the backend pytest suite
test-py: .venv
	uv run pytest

## test-js: run the frontend vitest suite
test-js: node_modules
	npm test

## install: build both environments
install: .venv node_modules

## run: launch the app with autoreload
run: .venv
	uv run uvicorn backend.main:app --reload

## share: expose the app publicly via Cloudflare Tunnel (set PRAXIS_AUTH_USER/PASSWORD)
share: .venv
	./scripts/share.sh

## clean: remove environments and caches
clean:
	rm -rf .venv node_modules .pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +

## help: list available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'

# --- environments (rebuilt only when their manifest changes) ---
.venv: pyproject.toml
	uv sync
	@touch .venv

node_modules: package.json
	npm install
	@touch node_modules
