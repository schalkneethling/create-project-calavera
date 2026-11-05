#!/usr/bin/env bash
# Collects everything a review needs for one target and writes it to a folder.
#
#   resolve-target.sh <github pull request url>            [out-dir]
#   resolve-target.sh <owner>/<repo>#<number>              [out-dir]
#   resolve-target.sh <folder> <branch> [base-branch]      [out-dir]
#
# Writes into out-dir (default: a fresh folder under $TMPDIR/pr-review/):
#   meta.json       title, body, author, base, head, numbers, mode, checkout path
#   diff.patch      the full unified diff, base...head
#   files.txt       changed paths, one per line, with status and +/- counts
#   commits.txt     the commits in the change, oldest first
#   diff-numbered.patch  the same diff with the new-file line number in front of every context and added line
#   comments.json   review comments already on the PR (URL mode), so you do not repeat them
#   threads.json    review threads with their resolved state and last reply (URL mode, when GraphQL is reachable)
#   issues.json     issues the PR body links (closes #N, fixes #N, or a bare #N), with title and body (URL mode)
#   checks.json     CI check runs on the head commit (URL mode)
#   checkout/       a worktree or clone at the head commit, for reading the code around the diff
# Prints the out-dir path on the last line of stdout.
set -euo pipefail

die() { echo "resolve-target: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 is not on PATH"; }
need git; need python3

ROOT_TMP="${TMPDIR:-/tmp}/pr-review"

# Writes diff-numbered.patch: every context and added line carries its line number in the new file,
# so a reviewer can cite path:line without counting.
number_diff() {
  python3 - "$1/diff.patch" "$1/diff-numbered.patch" <<'PY3'
import re, sys
src, dst = sys.argv[1:]
out, n = [], 0
for line in open(src, encoding="utf-8", errors="replace"):
    line = line.rstrip("\n")
    m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
    if m:
        n = int(m.group(1)); out.append(line); continue
    if line.startswith(("diff ", "index ", "--- ", "+++ ", "new file", "deleted file", "similarity", "rename ", "Binary")):
        out.append(line); continue
    if line.startswith("+"):
        out.append(f"{n:5d} {line}"); n += 1
    elif line.startswith("-"):
        out.append(f"      {line}")
    elif line.startswith("\\"):
        out.append(f"      {line}")
    else:
        out.append(f"{n:5d} {line}"); n += 1
open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY3
}
mkdir -p "$ROOT_TMP"

[[ $# -ge 1 ]] || { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }
TARGET="$1"

# ---------- mode A: a GitHub pull request ----------
if [[ "$TARGET" =~ ^https?://github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]] || [[ "$TARGET" =~ ^([^/ ]+)/([^# ]+)#([0-9]+)$ ]]; then
  OWNER="${BASH_REMATCH[1]}" REPO="${BASH_REMATCH[2]%.git}" NUM="${BASH_REMATCH[3]}"
  need gh
  OUT="${2:-$ROOT_TMP/$OWNER-$REPO-$NUM}"
  rm -rf "$OUT"; mkdir -p "$OUT"
  API="repos/$OWNER/$REPO/pulls/$NUM"

  gh api "$API" > "$OUT/pr.json" || die "cannot read $OWNER/$REPO#$NUM (is gh logged in?)"
  gh api -H "Accept: application/vnd.github.v3.diff" "$API" > "$OUT/diff.patch"
  gh api --paginate "$API/files" --jq '.[] | "\(.status)\t+\(.additions)\t-\(.deletions)\t\(.filename)"' > "$OUT/files.txt"
  gh api --paginate "$API/commits" --jq '.[] | "\(.sha[0:8])  \(.commit.message | split("\n") | map(select(length > 0)) | join("\n    "))"' > "$OUT/commits.txt"
  gh api --paginate "$API/comments" --jq '[.[] | {path, line, user: .user.login, body: (.body[0:400]), url: .html_url}]' > "$OUT/comments.json" 2>/dev/null || echo '[]' > "$OUT/comments.json"
  gh api --paginate "repos/$OWNER/$REPO/issues/$NUM/comments" --jq '[.[] | {user: .user.login, body: (.body[0:600])}]' > "$OUT/issue-comments.json" 2>/dev/null || echo '[]' > "$OUT/issue-comments.json"

  # Review threads with their resolved state (GraphQL). Falls back to [] where GraphQL is not reachable.
  gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} body createdAt}}}}}}}' \
    -f o="$OWNER" -f r="$REPO" -F n="$NUM" \
    --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | {path, line, resolved: .isResolved, outdated: .isOutdated, first_by: .comments.nodes[0].author.login, first: (.comments.nodes[0].body[0:300]), last_by: .comments.nodes[-1].author.login, last: (.comments.nodes[-1].body[0:300]), replies: ((.comments.nodes | length) - 1)}]' \
    > "$OUT/threads.json" 2>/dev/null || echo '[]' > "$OUT/threads.json"

  # Issues the body links: "closes #12", "fixes org/repo#34", or a bare "#56".
  python3 - "$OUT" "$OWNER" "$REPO" <<'PY2' > "$OUT/issues.json"
import json, re, subprocess, sys
out, owner, repo = sys.argv[1:]
body = json.load(open(f"{out}/pr.json")).get("body") or ""
seen, issues = set(), []
for o, r, n in re.findall(r"(?:([\w.-]+)/([\w.-]+))?#(\d+)\b", body):
    key = (o or owner, r or repo, int(n))
    if key in seen: continue
    seen.add(key)
    res = subprocess.run(["gh", "api", f"repos/{key[0]}/{key[1]}/issues/{key[2]}"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    if res.returncode != 0: continue
    i = json.loads(res.stdout)
    if "pull_request" in i: continue
    issues.append({"ref": f"{key[0]}/{key[1]}#{key[2]}", "url": i["html_url"], "title": i["title"], "state": i["state"], "body": (i.get("body") or "")[:4000]})
json.dump(issues, sys.stdout, indent=2)
PY2

  HEAD_SHA="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["head"]["sha"])' "$OUT/pr.json")"
  gh api "repos/$OWNER/$REPO/commits/$HEAD_SHA/check-runs" --jq '[.check_runs[] | {name, status, conclusion, url: .html_url}]' > "$OUT/checks.json" 2>/dev/null || echo '[]' > "$OUT/checks.json"

  # A checkout of the head commit: reuse a local clone when the current folder is one, else clone.
  CHECKOUT="$OUT/checkout"
  LOCAL=""
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    url="$(git remote get-url origin 2>/dev/null || true)"
    [[ "$url" == *"$OWNER/$REPO"* ]] && LOCAL="$(git rev-parse --show-toplevel)"
  fi
  if [[ -n "$LOCAL" ]]; then
    git -C "$LOCAL" worktree prune
    git -C "$LOCAL" fetch --quiet origin "pull/$NUM/head" 2>/dev/null || true
    git -C "$LOCAL" worktree add --quiet --detach "$CHECKOUT" "$HEAD_SHA" 2>/dev/null \
      || git -C "$LOCAL" worktree add --quiet --detach "$CHECKOUT" FETCH_HEAD
  else
    git clone --quiet --depth 1 "https://github.com/$OWNER/$REPO" "$CHECKOUT"
    git -C "$CHECKOUT" fetch --quiet --depth 50 origin "pull/$NUM/head"
    git -C "$CHECKOUT" checkout --quiet FETCH_HEAD
  fi

  number_diff "$OUT"
  python3 - "$OUT" "$OWNER" "$REPO" "$NUM" "$CHECKOUT" <<'PY'
import json, sys
out, owner, repo, num, checkout = sys.argv[1:]
pr = json.load(open(f"{out}/pr.json"))
meta = {
  "mode": "github",
  "owner": owner, "repo": repo, "number": int(num),
  "url": pr["html_url"],
  "title": pr["title"], "body": pr.get("body") or "",
  "author": pr["user"]["login"], "draft": pr.get("draft", False),
  "labels": [l["name"] for l in pr.get("labels", [])],
  "base": pr["base"]["ref"], "head": pr["head"]["ref"], "head_sha": pr["head"]["sha"],
  "additions": pr["additions"], "deletions": pr["deletions"], "changed_files": pr["changed_files"],
  "checkout": checkout,
}
json.dump(meta, open(f"{out}/meta.json", "w"), indent=2)
PY
  echo "$OUT"
  exit 0
fi

# ---------- mode B: a local folder and a branch ----------
FOLDER="$TARGET"
[[ -d "$FOLDER" ]] || die "'$FOLDER' is not a folder and not a GitHub pull request URL"
[[ $# -ge 2 ]] || die "give the branch to review: resolve-target.sh <folder> <branch> [base]"
BRANCH="$2"
REPO_ROOT="$(git -C "$FOLDER" rev-parse --show-toplevel)" || die "'$FOLDER' is not a git repository"

# Base: the third argument, else the remote default branch, else main/master/develop.
BASE="${3:-}"
if [[ -z "$BASE" ]]; then
  BASE="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  if [[ -z "$BASE" ]]; then
    for b in main master develop; do
      git -C "$REPO_ROOT" rev-parse --verify --quiet "$b" >/dev/null && { BASE="$b"; break; }
    done
  fi
fi
[[ -n "$BASE" ]] || die "cannot find a base branch; pass it as the third argument"

OUT="${4:-$ROOT_TMP/$(basename "$REPO_ROOT")-$(echo "$BRANCH" | tr '/' '-')}"
rm -rf "$OUT"; mkdir -p "$OUT"

# Compare against the freshest base we can get, without failing offline.
BASE_REF="$BASE"
if git -C "$REPO_ROOT" fetch --quiet origin "$BASE" 2>/dev/null && git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$BASE" >/dev/null; then
  BASE_REF="origin/$BASE"
fi
if git -C "$REPO_ROOT" rev-parse --verify --quiet "$BRANCH" >/dev/null; then
  BRANCH_REF="$BRANCH"
elif git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  BRANCH_REF="origin/$BRANCH"
elif git -C "$REPO_ROOT" fetch --quiet origin "$BRANCH" 2>/dev/null; then
  BRANCH_REF="origin/$BRANCH"
else
  die "branch '$BRANCH' not found locally or on origin"
fi

MERGE_BASE="$(git -C "$REPO_ROOT" merge-base "$BASE_REF" "$BRANCH_REF" 2>/dev/null || true)"
if [[ -z "$MERGE_BASE" ]] && [[ -f "$REPO_ROOT/.git/shallow" ]]; then
  # A shallow clone may not hold the fork point yet. Deepen both sides and try again.
  git -C "$REPO_ROOT" fetch --quiet --deepen=500 origin "$BASE" "$BRANCH" 2>/dev/null || true
  MERGE_BASE="$(git -C "$REPO_ROOT" merge-base "$BASE_REF" "$BRANCH_REF" 2>/dev/null || true)"
fi
DIFF_BASIS="merge-base"
if [[ -z "$MERGE_BASE" ]]; then
  echo "resolve-target: no common history between $BASE_REF and $BRANCH_REF (shallow clone?); comparing the two tips directly" >&2
  MERGE_BASE="$BASE_REF"; DIFF_BASIS="tip-to-tip"
fi
git -C "$REPO_ROOT" diff "$MERGE_BASE" "$BRANCH_REF" > "$OUT/diff.patch"
paste <(git -C "$REPO_ROOT" diff --name-status "$MERGE_BASE" "$BRANCH_REF" | cut -f1) \
      <(git -C "$REPO_ROOT" diff --numstat "$MERGE_BASE" "$BRANCH_REF") \
  | awk -F'\t' '{s=$1; sub(/^A.*/,"added",s); sub(/^M.*/,"modified",s); sub(/^D.*/,"removed",s); sub(/^R.*/,"renamed",s); printf "%s\t+%s\t-%s\t%s\n",s,$2,$3,$4}' > "$OUT/files.txt"
# Subjects and bodies, oldest first: the bodies carry the author's reasons.
git -C "$REPO_ROOT" log --reverse --format='%h  %s%n%w(0,4,4)%b' "$MERGE_BASE..$BRANCH_REF" | sed '/^ *$/d' > "$OUT/commits.txt"
for f in comments issue-comments checks threads issues; do echo '[]' > "$OUT/$f.json"; done

# Uncommitted work counts when the branch is the one checked out.
CURRENT="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
UNCOMMITTED=false
if [[ "$CURRENT" == "$BRANCH" ]]; then
  if ! git -C "$REPO_ROOT" diff --quiet HEAD -- || [[ -n "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]]; then
    UNCOMMITTED=true
    git -C "$REPO_ROOT" diff HEAD -- > "$OUT/uncommitted.patch"
    git -C "$REPO_ROOT" ls-files --others --exclude-standard > "$OUT/untracked.txt"
  fi
  CHECKOUT="$REPO_ROOT"
else
  CHECKOUT="$OUT/checkout"
  git -C "$REPO_ROOT" worktree prune
  git -C "$REPO_ROOT" worktree add --quiet --detach "$CHECKOUT" "$BRANCH_REF"
fi

number_diff "$OUT"
python3 - "$OUT" "$REPO_ROOT" "$BRANCH" "$BRANCH_REF" "$BASE" "$MERGE_BASE" "$DIFF_BASIS" "$CHECKOUT" "$UNCOMMITTED" <<'PY'
import json, subprocess, sys
out, root, branch, ref, base, merge_base, diff_basis, checkout, uncommitted = sys.argv[1:]
def git(*a): return subprocess.run(["git","-C",root,*a],stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,text=True).stdout.strip()
stat = git("diff","--shortstat",merge_base,ref)
files = sum(1 for _ in open(f"{out}/files.txt"))
meta = {
  "mode": "local",
  "repo_root": root, "remote": git("remote","get-url","origin"),
  "title": git("log","-1","--format=%s",ref), "body": "",
  "author": git("log","-1","--format=%an",ref),
  "base": base, "head": branch, "head_sha": git("rev-parse",ref), "merge_base": merge_base,
  "diff_basis": diff_basis,  # "merge-base", or "tip-to-tip" when no common history was found (shallow clone)
  "shortstat": stat, "changed_files": files,
  "uncommitted_changes": uncommitted == "true",
  "checkout": checkout,
}
json.dump(meta, open(f"{out}/meta.json","w"), indent=2)
PY
echo "$OUT"
