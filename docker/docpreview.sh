#!/bin/sh
# Convert an office document under /workspace into a previewable form for the
# dashboard's Document deck tab (#368): docx/pptx and legacy doc/ppt (plus
# odt/odp/rtf) render to PDF via headless LibreOffice; xlsx/xls/ods render to
# an HTML table via xlsx2html.py. Results are cached under /tmp/docpreview and
# reconverted only when the source's mtime moves past the cached output.
#
# Runs inside the agent container (invoked by core-server over docker exec).
# Prints the absolute path of the converted file on stdout; any diagnostics go
# to stderr. Exit codes: 0 ok, 2 bad usage/path, 3 unsupported type,
# 4 conversion failed.
set -u

SRC="${1:-}"
[ -n "$SRC" ] || { echo "usage: docpreview.sh /workspace/<file>" >&2; exit 2; }
case "$SRC" in
  /workspace/*) ;;
  *) echo "docpreview: path must be under /workspace" >&2; exit 2 ;;
esac
[ -f "$SRC" ] || { echo "docpreview: no such file: $SRC" >&2; exit 2; }

EXT=$(printf '%s' "${SRC##*.}" | tr 'A-Z' 'a-z')

CACHE_ROOT=/tmp/docpreview
# One cache slot per source path (not per basename — two dirs can hold files
# with the same name).
SLOT=$(printf '%s' "$SRC" | md5sum | cut -c1-16)
OUT_DIR="$CACHE_ROOT/$SLOT"
mkdir -p "$OUT_DIR"

BASE=$(basename "$SRC")
STEM="${BASE%.*}"

case "$EXT" in
  docx|doc|pptx|ppt|odt|odp|rtf)
    OUT="$OUT_DIR/$STEM.pdf"
    if [ -f "$OUT" ] && [ ! "$SRC" -nt "$OUT" ]; then
      printf '%s\n' "$OUT"; exit 0
    fi
    # LibreOffice is not safe to run concurrently against one profile, and a
    # shared profile also avoids a ~2s first-run cost per conversion. Serialize
    # with flock when available (util-linux is in the image).
    LOCK="$CACHE_ROOT/.soffice.lock"
    PROFILE="-env:UserInstallation=file://$CACHE_ROOT/lo-profile"
    if command -v flock >/dev/null 2>&1; then
      flock "$LOCK" soffice "$PROFILE" --headless --norestore \
        --convert-to pdf --outdir "$OUT_DIR" "$SRC" >&2
    else
      soffice "$PROFILE" --headless --norestore \
        --convert-to pdf --outdir "$OUT_DIR" "$SRC" >&2
    fi
    # soffice exits 0 even on some failures — trust the artifact, not the code.
    [ -f "$OUT" ] || { echo "docpreview: conversion produced no output" >&2; exit 4; }
    # Stamp freshness relative to the source so the [ -nt ] check above stays
    # valid even if conversion finished within the same clock second.
    touch "$OUT"
    printf '%s\n' "$OUT"
    ;;
  xlsx|xls|ods)
    OUT="$OUT_DIR/$STEM.html"
    if [ -f "$OUT" ] && [ ! "$SRC" -nt "$OUT" ]; then
      printf '%s\n' "$OUT"; exit 0
    fi
    python3 /app/xlsx2html.py "$SRC" "$OUT" || { echo "docpreview: xlsx render failed" >&2; exit 4; }
    printf '%s\n' "$OUT"
    ;;
  *)
    echo "docpreview: unsupported extension: $EXT" >&2
    exit 3
    ;;
esac
