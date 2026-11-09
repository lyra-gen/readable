#!/bin/sh
# Rebuilds tests/fixtures/files (macOS only). Needs Readable's managed Docling
# with the speech add-on installed, Google Chrome, and LibreOffice for the old
# Office files.
set -e
ROOT="$HOME/Library/Application Support/Readable"
export CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
export FFMPEG="${FFMPEG:-$ROOT/bin/ffmpeg}"
export SOFFICE="${SOFFICE:-/Applications/LibreOffice.app/Contents/MacOS/soffice}"
exec "$ROOT/venv/bin/python" -I "$(dirname "$0")/../tests/fixtures/generate.py" "$@"
