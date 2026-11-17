# Contributing

Thank you for helping shape Arthas Workbench. UI feedback, reproducible defects, docs and focused patches are welcome. Chinese and English are both welcome.

## Start with the prototype

Review the [interactive mock](https://yy568821795-max.github.io/arthas-workbench/preview/) or open `docs/preview/index.html` locally. Distinguish feedback about the current engineering prototype from ideas for the planned one-launch onboarding flow.

For runtime development, follow the root README. Use Python 3.13 and Rust 1.94.1 for the validated baseline. Keep caches and generated credentials under the ignored project directories.

## Changes

1. Fork the repository and create a focused branch.
2. Explain the observed behavior and proposed outcome. Discuss large architecture changes in an issue first.
3. Add tests for changes to routing, authentication, task lifecycle or process ownership. For layout-only changes, screenshots and a short interaction description are appropriate.
4. Run the relevant checks below; record real failures and skipped platform tests in the PR.
5. Open a pull request against `main`. Do not commit credentials, kubeconfig, dumps, binaries, runtime directories or customer data.

## Checks

From the checkout root in PowerShell:

```powershell
$project = (Get-Location).Path
$env:UV_CACHE_DIR = "$project/.cache/uv"
$env:CARGO_HOME = "$project/.cache/cargo"
$env:CARGO_TARGET_DIR = "$project/.build/connector"
$env:PYTHONDONTWRITEBYTECODE = '1'
uv sync --locked --python 3.13
cargo fmt --check --manifest-path "$project/connector/Cargo.toml"
cargo test --locked --features test-fixtures --manifest-path "$project/connector/Cargo.toml"
$env:WORKBENCH_LONG_TESTS = '1'
& "$project/.venv/Scripts/python.exe" -B -m unittest discover -s "$project/tests" -v
node --check "$project/workbench/static/app.js"
node --check "$project/docs/preview/mock.js"
```

The native test feature builds test helpers; they are never distributed as product executables. Python real-connector integration and the full-stack demo currently use Windows fixtures and expect the binary under `.build/connector/debug`. On other platforms those tests are skipped; a green unit suite does not prove platform acceptance.

After changing the application UI, regenerate its static review snapshot:

```powershell
& "$project/.venv/Scripts/python.exe" -B "$project/scripts/build_preview.py"
git diff -- docs/preview
```

`docs/preview/mock.js` is the only handwritten preview adapter. Never put real network calls or credentials in it. `index.html`, `app.js` and `style.css` in that directory are generated from the application UI.

## Pull request expectations

- State what changed and why, and include validation evidence.
- Keep user-visible text and errors actionable.
- Preserve explicit instance routing, user isolation, bounded streaming and cleanup of owned subprocesses.
- Do not introduce automatic Attach to an unselected JVM or retries that replay potentially executed actions.
- Document new dependencies and licensing obligations.
- Commits may use `feat:`, `fix:`, `docs:`, `test:` or `chore:` prefixes. No particular editor is required.

By contributing, you agree that your contributions are licensed under the project's MIT License and that you have the right to submit them. Report security issues privately using [SECURITY.md](SECURITY.md).
