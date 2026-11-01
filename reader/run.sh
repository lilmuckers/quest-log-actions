#!/usr/bin/env bash
# Reads the photo on an attachment pull request into $QUEST_READ_OUT/result.json. This step gets no
# token: the action saves the result afterwards. Any failure leaves no result, and the photo goes
# to an agent instead. Dependencies are pinned by hash; models by version and checksum.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
id="${QUEST_PHOTO_REF#quest/attach/}"
if [[ "$QUEST_PHOTO_REF" != quest/attach/* || ! "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Not an attachment branch: nothing to read."
  exit 0
fi
photo=""
for ext in jpg jpeg png webp; do
  [[ -f "data/attachments/$id.$ext" ]] && photo="$PWD/data/attachments/$id.$ext"
done
if [[ -z "$photo" ]]; then
  echo "::warning::No photo found for $id."
  exit 0
fi
mkdir -p "$QUEST_READ_OUT"
work="$RUNNER_TEMP/quest-reader"
out="$QUEST_READ_OUT/result.json"
partial="$work/result.json"

python3 -m venv "$work/ocr"
"$work/ocr/bin/pip" install --quiet --no-input --require-hashes -r "$here/requirements-ocr.txt"
(cd "$here" && "$work/ocr/bin/python" ocr.py "$photo" "$partial")

# No words in it: only now fetch the much larger caption model.
if grep -q '"caption": true' "$partial"; then
  python3 -m venv "$work/caption"
  "$work/caption/bin/pip" install --quiet --no-input --require-hashes --extra-index-url https://download.pytorch.org/whl/cpu -r "$here/requirements-caption.txt"
  (cd "$here" && HF_HOME="$work/hf" HF_HUB_DISABLE_TELEMETRY=1 "$work/caption/bin/python" caption.py "$photo" "$partial")
fi
mv "$partial" "$out"
