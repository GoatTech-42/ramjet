#!/bin/sh
# builds the local search backend ramjet runs as a child process. safe to re-run.
set -e
cd "$(dirname "$0")"
[ -d src ] || git clone -q --depth 1 https://github.com/searxng/searxng.git src
[ -d venv ] || { python3 -m venv venv 2>/dev/null || { python3 -m pip install --user --break-system-packages -q virtualenv && python3 -m virtualenv -q venv; }; }
venv/bin/pip install -q -U setuptools wheel pyyaml msgspec typing_extensions
venv/bin/pip install -q -r src/requirements.txt
venv/bin/pip install -q --use-pep517 --no-build-isolation -e src
echo ok
