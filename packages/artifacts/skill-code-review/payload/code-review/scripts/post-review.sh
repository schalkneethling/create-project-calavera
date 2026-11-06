#!/usr/bin/env bash
# Posts a finished review to GitHub as one pull request review with inline comments.
#
#   post-review.sh <out-dir>/review.json [--dry-run]
#
# review.json:
#   {
#     "event": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
#     "body": "the top comment (may be empty for APPROVE)",
#     "comments": [
#       { "path": "src/x.ts", "line": 42, "body": "..." },                      # one line
#       { "path": "src/x.ts", "start_line": 18, "line": 21, "body": "..." }     # a range, start to line
#     ]
#   }
# The owner, repo, number and head commit come from meta.json in the same folder.
#
# Every comment is checked against diff.patch before anything is sent: GitHub only accepts a
# comment on a line that the head commit's diff shows (added or context, right side). A comment
# whose range is partly outside the diff is shrunk to its first valid line; one with no valid
# line is moved into the top comment under "Outside the diff", with its path:line. --dry-run
# prints the payload that would be sent and exits.
# Prints the review URL.
set -euo pipefail
FILE="${1:?give the path to review.json}"; shift || true
DRY=false; [[ "${1:-}" == "--dry-run" ]] && DRY=true
DIR="$(cd "$(dirname "$FILE")" && pwd)"
[[ -f "$DIR/meta.json" ]] || { echo "post-review: no meta.json beside $FILE" >&2; exit 1; }
command -v gh >/dev/null || { echo "post-review: gh is not on PATH" >&2; exit 1; }

python3 - "$FILE" "$DIR" <<'PY' > "$DIR/payload.json"
import json, re, sys
review = json.load(open(sys.argv[1])); d = sys.argv[2]
meta = json.load(open(f"{d}/meta.json"))
if meta.get("mode") != "github":
    sys.exit("post-review: this review target is a local branch, not a GitHub pull request")
event = review.get("event", "COMMENT")
assert event in ("APPROVE", "REQUEST_CHANGES", "COMMENT"), f"bad event {event}"

# Right-side lines the diff shows, per file.
valid, path = {}, None
for line in open(f"{d}/diff.patch", encoding="utf-8", errors="replace"):
    if line.startswith("+++ "):
        path = line[4:].strip(); path = path[2:] if path.startswith("b/") else path
        valid.setdefault(path, set()); n = 0; continue
    m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
    if m: n = int(m.group(1)); continue
    if path is None or line.startswith(("diff ", "index ", "--- ", "\\")): continue
    if line.startswith("-"): continue
    valid[path].add(n); n += 1

comments, moved = [], []
for c in review.get("comments", []):
    p, body = c["path"], c["body"]
    end = int(c["line"]); start = int(c.get("start_line", end))
    ok = sorted(l for l in range(start, end + 1) if l in valid.get(p, ()))
    if not ok:
        moved.append(f"- `{p}:{start}`" + (f"-{end}" if end != start else "") + "\n" + body)
        continue
    entry = {"path": p, "line": ok[-1], "side": "RIGHT", "body": body}
    if ok[0] != ok[-1]:
        entry["start_line"] = ok[0]; entry["start_side"] = "RIGHT"
    if (ok[0], ok[-1]) != (start, end):
        sys.stderr.write(f"post-review: {p}:{start}-{end} shrunk to {ok[0]}-{ok[-1]} (lines outside the diff)\n")
    comments.append(entry)

body = review.get("body", "") or ""
if moved:
    body = (body + "\n\n" if body else "") + "**Outside the diff**\n\n" + "\n\n".join(moved)
    sys.stderr.write(f"post-review: {len(moved)} comment(s) moved into the top comment: not on a line in the diff\n")
if event == "APPROVE" and moved:
    event = "COMMENT"; sys.stderr.write("post-review: event changed to COMMENT because findings were moved into the body\n")
json.dump({"commit_id": meta["head_sha"], "event": event, "body": body, "comments": comments}, sys.stdout)
PY

if $DRY; then python3 -m json.tool "$DIR/payload.json"; exit 0; fi
META="$DIR/meta.json"
OWNER="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["owner"])' "$META")"
REPO="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["repo"])' "$META")"
NUM="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["number"])' "$META")"
if ! gh api -X POST "repos/$OWNER/$REPO/pulls/$NUM/reviews" --input "$DIR/payload.json" --jq '.html_url'; then
  echo "post-review: GitHub refused the post. The checked review is in $DIR/payload.json; to send it with your own login:" >&2
  echo "  gh api repos/$OWNER/$REPO/pulls/$NUM/reviews --method POST --input $DIR/payload.json" >&2
  exit 1
fi
