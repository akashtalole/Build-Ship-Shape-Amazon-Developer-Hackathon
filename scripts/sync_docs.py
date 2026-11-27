#!/usr/bin/env python3
"""Mirrors the repo's canonical docs into docs/ so MkDocs has one content tree.

Every project's own README.md and FRICTION_LOG.md (and a few other top-level
docs) stay the single source of truth; nothing under docs/ is hand-edited except
index.md. This script also generates docs/projects/index.md, the overview of
every solution, from SOLUTIONS below. Run it before `mkdocs build` or
`mkdocs serve`; the GitHub Pages workflow does it on every push to main.

Relative links in mirrored files are rewritten: a link to another mirrored file
becomes a link to that page on the site, and anything else (source code,
scripts) becomes an absolute GitHub URL, since the original relative path
doesn't exist under docs/.
"""
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
REPO_URL = "https://github.com/akashtalole/Build-Ship-Shape-Amazon-Developer-Hackathon"

SOLUTIONS = [
    {
        "slug": "homeops",
        "dir": "alexa-homeops-mcp",
        "name": "HomeOps",
        "track": "Alexa+",
        "idea": "ideas/alexa-plus.md",
        "summary": "A self-hosted MCP server that lets Alexa+ run a household in one conversation: morning "
        "briefing, freeform capture, reordering that asks before it spends, proactive alerts and meal planning.",
        "status": "The repo's hackathon entry. Deployable to Amazon ECS Express Mode, with Claude via MCP "
        "sampling, Amazon Bedrock or the Anthropic API.",
        "port": 3333,
    },
    {
        "slug": "porchpass",
        "dir": "ring-porchpass",
        "name": "PorchPass",
        "track": "Ring",
        "idea": "ideas/ring.md",
        "summary": "Single-use or time-boxed access passes for visitors, matched against Ring doorbell and "
        "motion events, with visitor trust scores and neighborhood alerts.",
        "status": "Prototype. Runs against a simulated Ring client rather than Ring's own APIs.",
        "port": 4444,
    },
    {
        "slug": "courtside",
        "dir": "firetv-courtside",
        "name": "CourtSide",
        "track": "Fire TV",
        "idea": "ideas/fire-tv.md",
        "summary": "The backend a Fire TV overlay would call during a live game: play-by-play commentary, "
        "viewer questions, live predictions, fantasy tracking and watch parties.",
        "status": "Prototype. Backend only; there's no Fire OS or Vega app yet.",
        "port": 4455,
    },
    {
        "slug": "studyloop",
        "dir": "bee-studyloop",
        "name": "StudyLoop",
        "track": "Bee",
        "idea": "ideas/bee.md",
        "summary": "Turns study-session transcripts into flashcards and a spaced-repetition (SM-2) review "
        "schedule, with a concept graph and an exam-readiness score.",
        "status": "Prototype. Backend only; not yet fed by a real Bee device.",
        "port": 4466,
    },
    {
        "slug": "model-router",
        "dir": "aws-builder-model-router",
        "name": "Model Router",
        "track": "AWS Builder (mini-challenge)",
        "idea": "ideas/aws-builder.md",
        "summary": "Sends each request to a small classifier first and escalates to a foundation model only "
        "when confidence is low, with budgets, canary routing and drift detection.",
        "status": "Prototype. The SageMaker and Bedrock calls are mocked.",
        "port": 4567,
    },
    {
        "slug": "friction-log-toolkit",
        "dir": "friction-log-toolkit",
        "name": "friction-log-toolkit",
        "track": "Open Source (mini-challenge)",
        "idea": "ideas/open-source.md",
        "summary": "A CLI for logging developer friction the moment it happens, then triaging and exporting "
        "it as a report, GitHub issues or a timeline.",
        "status": "Working CLI, MIT-licensed in a public repo.",
        "port": None,
    },
]

# (source path relative to repo root, destination path relative to docs/)
PAGES = [
    ("hackathon-ideas/README.md", "ideas/index.md"),
    ("hackathon-ideas/fire-tv.md", "ideas/fire-tv.md"),
    ("hackathon-ideas/alexa-plus.md", "ideas/alexa-plus.md"),
    ("hackathon-ideas/bee.md", "ideas/bee.md"),
    ("hackathon-ideas/ring.md", "ideas/ring.md"),
    ("hackathon-ideas/aws-builder.md", "ideas/aws-builder.md"),
    ("hackathon-ideas/open-source.md", "ideas/open-source.md"),
    *[
        pair
        for s in SOLUTIONS
        for pair in (
            (f"{s['dir']}/README.md", f"projects/{s['slug']}/index.md"),
            (f"{s['dir']}/FRICTION_LOG.md", f"projects/{s['slug']}/friction-log.md"),
        )
    ],
    ("deploy/README.md", "deploy.md"),
    ("demo/README.md", "demo.md"),
    ("DEVPOST_SUBMISSION.md", "devpost-submission.md"),
    ("kiro/PLAN.md", "kiro.md"),
]

# Mirrored source file (repo-relative POSIX path) -> its page under docs/.
SOURCE_TO_PAGE = {src: dest for src, dest in PAGES}

# Matches markdown/image link targets: ...](target "optional title")
LINK_RE = re.compile(r"\]\(([^)\s]+)(\s+\"[^\"]*\")?\)")


def rewrite_links(text: str, src_rel: str, dest_rel: str) -> str:
    src_dir = Path(src_rel).parent
    dest_dir = Path(dest_rel).parent

    def repl(match: re.Match) -> str:
        target, title = match.group(1), match.group(2) or ""
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:|^#|^/", target):
            return match.group(0)  # absolute URL, mailto:, in-page anchor, or root-relative: leave alone
        path_part, sep, frag = target.partition("#")
        resolved = (ROOT / src_dir / path_part).resolve()
        try:
            rel_to_root = resolved.relative_to(ROOT).as_posix()
        except ValueError:
            return match.group(0)  # points outside the repo; leave unresolved
        if not resolved.exists():
            return match.group(0)  # can't confirm a real target; leave unresolved rather than guess
        suffix = f"#{frag}" if sep else ""

        page = SOURCE_TO_PAGE.get(rel_to_root)
        if page is None and resolved.is_dir():
            page = SOURCE_TO_PAGE.get(f"{rel_to_root}/README.md")
        if page is not None:
            return f"]({Path(os.path.relpath(page, dest_dir)).as_posix()}{suffix}{title})"

        kind = "tree" if resolved.is_dir() else "blob"
        return f"]({REPO_URL}/{kind}/main/{rel_to_root}{suffix}{title})"

    return LINK_RE.sub(repl, text)


def solutions_overview() -> str:
    rows = "\n".join(
        f"| [{s['name']}]({s['slug']}/index.md) | {s['track']} | {s['status']} |" for s in SOLUTIONS
    )
    sections = []
    for s in SOLUTIONS:
        if s["port"]:
            run = (
                f"cd {s['dir']}\nnpm install\nnpm test                      # end-to-end tests\n"
                f"npm run build && npm start   # http://localhost:{s['port']}"
            )
        else:
            run = f"cd {s['dir']}\nnpm install\nnpm test\nnode dist/cli.js --help"
        sections.append(
            f"## {s['name']}\n\n"
            f"**Track:** [{s['track']}](../{s['idea']}) · "
            f"[Overview]({s['slug']}/index.md) · [Friction log]({s['slug']}/friction-log.md) · "
            f"[Source]({REPO_URL}/tree/main/{s['dir']})\n\n"
            f"{s['summary']}\n\n"
            f"{s['status']}\n\n"
            f"```bash\n{run}\n```\n"
        )
    return (
        "# All solutions\n\n"
        "One implementation per hackathon category. Each is a standalone Node.js/TypeScript project with its own "
        "README, end-to-end tests and friction log. Where real hardware or credentials weren't available, the "
        "project says so and isolates the integration behind one interface.\n\n"
        "| Solution | Category | Status |\n|---|---|---|\n"
        f"{rows}\n\n" + "\n".join(sections)
    )


def main() -> None:
    for src_rel, dest_rel in PAGES:
        src = ROOT / src_rel
        dest = DOCS / dest_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        text = rewrite_links(src.read_text(encoding="utf-8"), src_rel, dest_rel)
        note = (
            '!!! note "Source of truth"\n'
            f"    This page mirrors [`{src_rel}`]({REPO_URL}/blob/main/{src_rel}) in the repo; edit it there, "
            "not here. Links to other pages stay on this site; links to code go to GitHub.\n\n"
        )
        dest.write_text(note + text, encoding="utf-8")
        print(f"synced {src_rel} -> docs/{dest_rel}")

    overview = DOCS / "projects" / "index.md"
    overview.write_text(solutions_overview(), encoding="utf-8")
    print("generated docs/projects/index.md")


if __name__ == "__main__":
    main()
