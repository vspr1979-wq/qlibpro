# Vendored: Microsoft Qlib

| | |
|---|---|
| Upstream | https://github.com/microsoft/qlib.git |
| Pinned commit | `be725493eb1a6bbb42bf11b37aa7669f59610ff1` |
| Vendored on | 2026-09-29 |
| How | full clone of the commit, `.git` history stripped, copied to `vendor/qlib/` |

This directory is the **Microsoft Qlib source used by OptionSignal**.
`requirements.txt` installs it with `pip install ./vendor/qlib`, so the app
builds against the copy committed in this repository — no network fetch of
Qlib at install time.

## Local patch (only one)

`vendor/qlib/pyproject.toml` — added `fallback_version = "0.1.dev1"` to
`[tool.setuptools_scm]`, because the stripped `.git` directory means
setuptools-scm cannot detect the version from tags. Everything else is
byte-identical to the pinned upstream commit.

## Refreshing to a newer upstream commit

```
git clone https://github.com/microsoft/qlib.git /tmp/qlib-new
cd /tmp/qlib-new && git checkout <new-commit>
# copy tree (excluding .git, build artifacts) over vendor/qlib/
# re-apply the fallback_version line above if pyproject.toml changed
pip install ./vendor/qlib    # rebuild, then run tests
python tests/test_units.py && python tests/smoke_qlib.py
```
