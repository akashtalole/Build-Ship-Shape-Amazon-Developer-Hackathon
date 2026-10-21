#!/usr/bin/env python3
"""Renders the narration in demo/script.json to one audio file per segment.

  python3 demo/tools/narration.py polly [--voice Matthew] [--region us-east-1]
      Final voice. Amazon Polly (neural, conversational style) via the AWS CLI;
      run it in AWS CloudShell. Writes demo/narration/polly/<segment>.mp3.

  python3 demo/tools/narration.py piper --model en_US-lessac-high.onnx
      Draft voice. Local Piper TTS (pip install piper-tts). Writes
      demo/narration/draft/<segment>.mp3 (needs ffmpeg).

  python3 demo/tools/narration.py ssml
      Writes demo/narration.ssml: the whole script as one SSML document with a
      <mark> per segment, for rendering in a single Polly call.

assemble.sh uses polly/ audio for a segment when it exists, else draft/.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape

DEMO = Path(__file__).resolve().parent.parent
ACRONYMS = ["MCP", "AWS", "ECS"]


def segments():
    script = json.loads((DEMO / "script.json").read_text(encoding="utf-8"))
    return [s for s in script["segments"] if s.get("narration")]


def to_ssml_fragment(text: str) -> str:
    out = escape(text)
    out = out.replace("Alexa+", '<sub alias="Alexa plus">Alexa+</sub>')
    for acronym in ACRONYMS:
        out = re.sub(rf"\b{acronym}\b", f'<say-as interpret-as="characters">{acronym}</say-as>', out)
    return out


def to_piper_text(text: str) -> str:
    out = text.replace("Alexa+", "Alexa plus")
    for acronym in ACRONYMS:
        out = re.sub(rf"\b{acronym}\b", " ".join(acronym), out)
    return out


def wrap_speak(body: str) -> str:
    return (
        '<speak><amazon:domain name="conversational">'
        f"{body}"
        "</amazon:domain></speak>"
    )


def cmd_polly(args):
    out_dir = DEMO / "narration" / "polly"
    out_dir.mkdir(parents=True, exist_ok=True)
    for seg in segments():
        target = out_dir / f"{seg['id']}.mp3"
        subprocess.run(
            [
                "aws", "polly", "synthesize-speech",
                "--region", args.region,
                "--engine", "neural",
                "--voice-id", args.voice,
                "--text-type", "ssml",
                "--text", wrap_speak(to_ssml_fragment(seg["narration"])),
                "--output-format", "mp3",
                "--sample-rate", "24000",
                str(target),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        print(f"polly -> {target.relative_to(DEMO)}")


def cmd_piper(args):
    out_dir = DEMO / "narration" / "draft"
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for seg in segments():
            wav = Path(tmp) / f"{seg['id']}.wav"
            subprocess.run(
                [
                    args.python, "-m", "piper",
                    "--model", args.model,
                    "--output-file", str(wav),
                    "--sentence-silence", "0.25",
                    "--length-scale", str(args.length_scale),
                ],
                input=to_piper_text(seg["narration"]).encode("utf-8"),
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            target = out_dir / f"{seg['id']}.mp3"
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
                 "-ar", "24000", "-ac", "1", "-b:a", "96k", str(target)],
                check=True,
            )
            print(f"piper -> {target.relative_to(DEMO)}")


def cmd_ssml(_args):
    parts = [f'<mark name="{s["id"]}"/>\n{to_ssml_fragment(s["narration"])}\n<break time="700ms"/>' for s in segments()]
    body = "\n\n".join(parts)
    doc = (
        '<speak version="1.0" xml:lang="en-US" xmlns="http://www.w3.org/2001/10/synthesis" '
        'xmlns:amazon="http://amazon.com/schemas/ssml-1.0">\n'
        '<amazon:domain name="conversational">\n\n'
        f"{body}\n\n</amazon:domain>\n</speak>\n"
    )
    (DEMO / "narration.ssml").write_text(doc, encoding="utf-8")
    print("wrote narration.ssml")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    polly = sub.add_parser("polly")
    polly.add_argument("--voice", default="Matthew")
    polly.add_argument("--region", default="us-east-1")
    piper = sub.add_parser("piper")
    piper.add_argument("--model", required=True)
    piper.add_argument("--python", default=sys.executable, help="Python interpreter that has piper-tts installed")
    piper.add_argument("--length-scale", type=float, default=1.0, help=">1 speaks slower")
    sub.add_parser("ssml")
    args = parser.parse_args()
    {"polly": cmd_polly, "piper": cmd_piper, "ssml": cmd_ssml}[args.cmd](args)


if __name__ == "__main__":
    main()
