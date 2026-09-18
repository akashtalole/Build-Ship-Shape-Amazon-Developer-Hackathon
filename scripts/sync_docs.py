#!/usr/bin/env python3
"""Mirrors the repo's canonical READMEs into docs/ so MkDocs has one content tree.

Every project's own README.md (and a few other top-level docs) stays the single
source of truth; nothing under docs/ is hand-edited except index.md. Run this
before `mkdocs build`/`mkdocs serve` — the GitHub Pages workflow does it
automatically on every push to main.

Relative markdown links in the mirrored files (e.g. "./src/index.ts",
"../hackathon-ideas/ring.md") are rewritten to absolute GitHub blob/tree URLs,
since a relative link that made sense next to the original file would otherwise
resolve to a nonexistent path once the content is copied under docs/.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
REPO_URL = "https://github.com/akashtalole/Build-Ship-Shape-Amazon-Developer-Hackathon"

# (source path relative to repo root, destination path relative to docs/)
PAGES = [
    ("hackathon-ideas/README.md", "ideas/index.md"),
    ("hackathon-ideas/fire-tv.md", "ideas/fire-tv.md"),
    ("hackathon-ideas/alexa-plus.md", "ideas/alexa-plus.md"),
    ("hackathon-ideas/bee.md", "ideas/bee.md"),
    ("hackathon-ideas/ring.md", "ideas/ring.md"),
    ("hackathon-ideas/aws-builder.md", "ideas/aws-builder.md"),
    ("hackathon-ideas/open-source.md", "ideas/open-source.md"),
    ("alexa-homeops-mcp/README.md", "projects/homeops.md"),
    ("ring-porchpass/README.md", "projects/porchpass.md"),
    ("firetv-courtside/README.md", "projects/courtside.md"),
    ("bee-studyloop/README.md", "projects/studyloop.md"),
    ("aws-builder-model-router/README.md", "projects/model-router.md"),
    ("friction-log-toolkit/README.md", "projects/friction-log-toolkit.md"),
    ("deploy/README.md", "deploy.md"),
    ("demo/README.md", "demo.md"),
    ("DEVPOST_SUBMISSION.md", "devpost-submission.md"),
]

# Matches markdown/image link targets: ...](target "optional title")
LINK_RE = re.compile(r"\]\(([^)\s]+)(\s+\"[^\"]*\")?\)")


def rewrite_links(text: str, src_rel: str) -> str:
    src_dir = Path(src_rel).parent

    def repl(match: re.Match) -> str:
        target, title = match.group(1), match.group(2) or ""
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:|^#|^/", target):
            return match.group(0)  # absolute URL, mailto:, in-page anchor, or root-relative — leave alone
        path_part, sep, frag = target.partition("#")
        resolved = (ROOT / src_dir / path_part).resolve()
        try:
            rel_to_root = resolved.relative_to(ROOT)
        except ValueError:
            return match.group(0)  # points outside the repo somehow; leave unresolved
        if not resolved.exists():
            return match.group(0)  # can't confirm a real target; leave unresolved rather than guess
        kind = "tree" if resolved.is_dir() else "blob"
        new_target = f"{REPO_URL}/{kind}/main/{rel_to_root.as_posix()}"
        if sep:
            new_target += f"#{frag}"
        return f"]({new_target}{title})"

    return LINK_RE.sub(repl, text)


def main() -> None:
    for src_rel, dest_rel in PAGES:
        src = ROOT / src_rel
        dest = DOCS / dest_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        text = rewrite_links(src.read_text(encoding="utf-8"), src_rel)
        note = (
            '!!! note "Source of truth"\n'
            f"    This page mirrors [`{src_rel}`]({REPO_URL}/blob/main/{src_rel}) in the repo — "
            "edit it there, not here. Links below point back to the repo on GitHub.\n\n"
        )
        dest.write_text(note + text, encoding="utf-8")
        print(f"synced {src_rel} -> docs/{dest_rel}")


if __name__ == "__main__":
    main()
