#!/usr/bin/env python
"""session-scribe: Craig recording -> speaker-labeled transcript aligned with the Foundry chat log.

Subcommands (run with the ~/.session-scribe venv python):
  smoke [audio]                       verify faster-whisper loads on CUDA (optionally transcribe a clip)
  fetch <craig-url> --session-dir D   download + extract the multitrack FLAC zip, save sanitized metadata
  transcribe --session-dir D          per-track faster-whisper with VAD -> transcript-segments.json
  align --session-dir D               merge segments + Foundry chatlog.json -> transcript.md

The Craig download key is used in-memory only and never written to disk (craig-info.json is
sanitized) — session dirs get committed to the campaign repo.

Craig API contract (mapped from CraigChat/craig @ master, 2026-07):
  GET  {base}/api/recording/{id}?key=          -> { info: { startTime, ... } }
  GET  {base}/api/recording/{id}/users?key=    -> { users: [{ id, name, discrim }] }   (track order)
  GET  {base}/api/recording/{id}/duration?key= -> { duration }                          (seconds)
  GET  {base}/api/recording/{id}/notes?key=    -> { notes }                             (/note markers)
  POST {base}/api/recording/{id}/cook?key=     body {format, container, dynaudnorm}     (start cook)
  GET  {base}/api/recording/{id}/cook?key=     -> { ready, download: { file } }         (poll)
  GET  {base}/dl/{file}                        -> the cooked archive
"""

import argparse
import datetime as dt
import html
import json
import os
import re
import site
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

AUDIO_EXTS = {".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".wav", ".mp3"}
UA = {"User-Agent": "session-scribe/1.0 (personal D&D recap pipeline)"}


# --- CUDA DLL bootstrap -------------------------------------------------------

def add_nvidia_dlls() -> list[str]:
    """Register pip-installed NVIDIA DLL dirs. ctranslate2 resolves cuBLAS by bare
    LoadLibrary name, which ignores add_dll_directory — the dirs must also be on PATH."""
    added = []
    for sp in site.getsitepackages():
        nvidia = Path(sp) / "nvidia"
        if not nvidia.is_dir():
            continue
        for bin_dir in nvidia.glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            added.append(str(bin_dir))
    os.environ["PATH"] = os.pathsep.join(added + [os.environ.get("PATH", "")])
    return added


def load_model(model_name: str, device: str):
    from faster_whisper import WhisperModel

    if device in ("auto", "cuda"):
        try:
            m = WhisperModel(model_name, device="cuda", compute_type="float16")
            return m, "cuda/float16"
        except Exception as e:
            if device == "cuda":
                raise
            print(f"CUDA unavailable ({e!r}); falling back to CPU int8 (slower)")
    m = WhisperModel(model_name, device="cpu", compute_type="int8")
    return m, "cpu/int8"


# --- Craig API ----------------------------------------------------------------

def parse_craig_url(url: str) -> tuple[str, str, str]:
    """Return (base, recording_id, key) from a Craig download link."""
    u = urllib.parse.urlparse(url)
    base = f"{u.scheme}://{u.netloc}"
    q = urllib.parse.parse_qs(u.query)
    m = re.search(r"/(?:rec|home)/([A-Za-z0-9_-]+)", u.path)
    rec_id = m.group(1) if m else (q.get("id", [None])[0])
    key = q.get("key", [None])[0]
    if not rec_id or not key:
        raise SystemExit(f"Could not parse recording id/key from: {url}")
    return base, rec_id, key


def _request(url: str, data: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    return urllib.request.urlopen(req, timeout=120)


def api_json(url: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    try:
        with _request(url, data, headers) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (404, 410):
            raise SystemExit(
                f"Recording not found or expired (HTTP {e.code}). Craig keeps recordings 7 days."
            )
        if e.code == 403:
            raise SystemExit("Craig rejected the key (HTTP 403) — re-check the pasted link.")
        raise


def cmd_fetch(args) -> int:
    base, rec_id, key = parse_craig_url(args.url)
    sdir = Path(args.session_dir)
    audio_dir = sdir / "audio"
    tracks_dir = audio_dir / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)

    print(f"Recording {rec_id} @ {base}")
    info = api_json(f"{base}/api/recording/{rec_id}?key={key}").get("info", {})
    users = api_json(f"{base}/api/recording/{rec_id}/users?key={key}").get("users", [])
    duration = api_json(f"{base}/api/recording/{rec_id}/duration?key={key}").get("duration")
    try:
        notes = api_json(f"{base}/api/recording/{rec_id}/notes?key={key}").get("notes")
    except Exception:
        notes = None

    print(f"  channel : #{info.get('channelExtra', {}).get('name', '?')}"
          f" in {info.get('guildExtra', {}).get('name', '?')}")
    print(f"  started : {info.get('startTime')}")
    print(f"  duration: {duration}s, tracks: {len(users)}")

    print("Requesting cook (flac/zip)...")
    api_json(f"{base}/api/recording/{rec_id}/cook?key={key}",
             {"format": "flac", "container": "zip", "dynaudnorm": False})

    file_name = None
    deadline = time.time() + 45 * 60
    while time.time() < deadline:
        state = api_json(f"{base}/api/recording/{rec_id}/cook?key={key}")
        dl = state.get("download") or {}
        file_name = dl.get("file") or state.get("file")
        if state.get("ready") and file_name:
            break
        msg = state.get("message") or f"progress={state.get('progress')}"
        print(f"  cooking... {msg}")
        time.sleep(5)
    if not file_name:
        raise SystemExit("Cook did not finish in 45 min — download manually from the Craig page "
                         "and unzip into audio/tracks/, then run transcribe.")

    zip_path = audio_dir / f"craig-{rec_id}.zip"
    print(f"Downloading /dl/{file_name} ...")
    with _request(f"{base}/dl/{urllib.parse.quote(file_name)}") as r, open(zip_path, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    print(f"  saved {zip_path} ({zip_path.stat().st_size / 1e6:.1f} MB)")

    with zipfile.ZipFile(zip_path) as z:
        z.extractall(tracks_dir)
    extracted = [p.name for p in tracks_dir.rglob("*") if p.suffix.lower() in AUDIO_EXTS]
    print(f"  extracted {len(extracted)} audio tracks: {extracted}")

    # Sanitized metadata only — no key, safe to commit.
    meta = {
        "recordingId": rec_id,
        "startTime": info.get("startTime"),
        "durationSeconds": duration,
        "guild": info.get("guildExtra", {}).get("name"),
        "channel": info.get("channelExtra", {}).get("name"),
        "users": [{"track": i + 1, "id": u.get("id"), "name": u.get("name")}
                  for i, u in enumerate(users)],
        "craigNotes": notes,
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    (sdir / "craig-info.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"Wrote {sdir / 'craig-info.json'} (key NOT persisted)")
    return 0


# --- transcription --------------------------------------------------------------

def track_speaker(path: Path, users: list[dict]) -> str:
    m = re.match(r"^(\d+)[-_](.+)$", path.stem)
    if m:
        idx = int(m.group(1))
        for u in users:
            if u.get("track") == idx and u.get("name"):
                return u["name"]
        return m.group(2)
    return path.stem


def cmd_transcribe(args) -> int:
    sdir = Path(args.session_dir)
    tracks_dir = sdir / "audio" / "tracks"
    files = sorted(p for p in tracks_dir.rglob("*") if p.suffix.lower() in AUDIO_EXTS)
    if not files:
        raise SystemExit(f"No audio tracks under {tracks_dir} — run fetch first (or unzip manually).")

    meta = {}
    info_path = sdir / "craig-info.json"
    if info_path.exists():
        meta = json.loads(info_path.read_text(encoding="utf-8"))

    add_nvidia_dlls()
    print(f"Loading model {args.model} ...")
    model, device = load_model(args.model, args.device)
    print(f"Model on {device}; transcribing {len(files)} tracks")

    out_tracks = []
    for path in files:
        speaker = track_speaker(path, meta.get("users", []))
        t_start = time.time()
        segments, seg_info = model.transcribe(
            str(path), vad_filter=True, language=args.language or None
        )
        segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
                for s in segments if s.text.strip()]
        print(f"  {path.name} [{speaker}]: {len(segs)} segments, "
              f"{seg_info.duration:.0f}s audio in {time.time() - t_start:.0f}s")
        out_tracks.append({"file": path.name, "speaker": speaker, "segments": segs})

    out = {"model": args.model, "device": device, "tracks": out_tracks}
    (sdir / "transcript-segments.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"Wrote {sdir / 'transcript-segments.json'}")
    return 0


# --- alignment ------------------------------------------------------------------

def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def hms(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def cmd_align(args) -> int:
    sdir = Path(args.session_dir)
    meta = json.loads((sdir / "craig-info.json").read_text(encoding="utf-8"))
    segs = json.loads((sdir / "transcript-segments.json").read_text(encoding="utf-8"))
    chat_path = Path(args.chatlog) if args.chatlog else sdir / "chatlog.json"
    chat = json.loads(chat_path.read_text(encoding="utf-8")) if chat_path.exists() else []
    if not chat_path.exists():
        print(f"NOTE: {chat_path} missing — transcript will have no chat/roll events.")

    t0 = dt.datetime.fromisoformat(meta["startTime"].replace("Z", "+00:00")).timestamp()
    duration = float(meta.get("durationSeconds") or 0)

    events = []
    for track in segs["tracks"]:
        # Merge consecutive segments of one speaker into paragraphs (gap <= 2.5s).
        para = None
        for s in track["segments"]:
            if para and s["start"] - para["end"] <= 2.5:
                para["text"] += " " + s["text"]
                para["end"] = s["end"]
            else:
                if para:
                    events.append(para)
                para = {"t": s["start"], "end": s["end"], "kind": "speech",
                        "speaker": track["speaker"], "text": s["text"]}
        if para:
            events.append(para)

    window = (t0 - 120, t0 + max(duration, 1) + 120)
    kept = skipped = 0
    for m in chat:
        t = m.get("timestamp", 0) / 1000.0 + args.skew_seconds
        if not (window[0] <= t <= window[1]) and not args.no_window:
            skipped += 1
            continue
        kept += 1
        rolls = m.get("rolls") or []
        if m.get("isRoll") and rolls:
            parts = [f"{r.get('formula', '?')} = {r.get('total', '?')}" for r in rolls]
            text = f"{m.get('alias') or m.get('authorName')} — " \
                   f"{strip_html(m.get('flavor') or '') or 'roll'}: {', '.join(parts)}"
            kind = "roll"
        else:
            text = f"{m.get('alias') or m.get('authorName')}: {strip_html(m.get('content') or '')}"
            kind = "whisper" if (m.get("whisper") or m.get("blind")) else "chat"
        events.append({"t": t - t0, "kind": kind, "text": text})

    events.sort(key=lambda e: e["t"])

    icon = {"roll": "🎲", "chat": "💬", "whisper": "🤫"}
    lines = [
        f"# Session transcript — {meta.get('guild', '?')} / #{meta.get('channel', '?')}",
        "",
        f"- **Recorded:** {meta['startTime']} ({hms(duration)} long)",
        f"- **Model:** {segs.get('model')} on {segs.get('device')}",
        f"- **Chat events:** {kept} in window, {skipped} outside"
        + (f", skew {args.skew_seconds:+.1f}s applied" if args.skew_seconds else ""),
        "",
        "---",
        "",
    ]
    for e in events:
        if e["kind"] == "speech":
            lines.append(f"**[{hms(e['t'])}] {e['speaker']}:** {e['text']}")
        else:
            lines.append(f"> {icon[e['kind']]} `[{hms(e['t'])}]` {e['text']}")
        lines.append("")
    (sdir / "transcript.md").write_text("\n".join(lines), encoding="utf-8")

    speech = sum(1 for e in events if e["kind"] == "speech")
    print(f"Wrote {sdir / 'transcript.md'}: {speech} speech paragraphs, {kept} chat events "
          f"({skipped} outside recording window)")
    if meta.get("craigNotes"):
        print(f"Craig /note markers present: {meta['craigNotes']}")
    return 0


# --- smoke ------------------------------------------------------------------------

def cmd_smoke(args) -> int:
    dirs = add_nvidia_dlls()
    print(f"NVIDIA DLL dirs: {len(dirs)}")
    model, device = load_model("tiny", "auto")
    print(f"Model loaded on: {device}")
    if args.audio:
        segments, info = model.transcribe(args.audio, vad_filter=True)
        print(f"Audio: {info.duration:.1f}s, language={info.language}")
        for seg in segments:
            print(f"  [{seg.start:6.2f} -> {seg.end:6.2f}] {seg.text}")
    print("SMOKE TEST OK" if device.startswith("cuda") else "SMOKE TEST OK (CPU ONLY)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="session_scribe")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("smoke", help="verify the CUDA transcription stack")
    p.add_argument("audio", nargs="?", help="optional test clip to transcribe")
    p.set_defaults(fn=cmd_smoke)

    p = sub.add_parser("fetch", help="download a Craig recording (multitrack flac zip)")
    p.add_argument("url", help="the Craig download link from your DM")
    p.add_argument("--session-dir", required=True)
    p.set_defaults(fn=cmd_fetch)

    p = sub.add_parser("transcribe", help="transcribe all tracks with faster-whisper")
    p.add_argument("--session-dir", required=True)
    p.add_argument("--model", default="large-v3-turbo")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--language", default="en", help="empty string = autodetect")
    p.set_defaults(fn=cmd_transcribe)

    p = sub.add_parser("align", help="merge segments + Foundry chatlog.json into transcript.md")
    p.add_argument("--session-dir", required=True)
    p.add_argument("--chatlog", help="path to export-chat-log JSON (default: session-dir/chatlog.json)")
    p.add_argument("--skew-seconds", type=float, default=0.0,
                   help="add to chat timestamps to correct Craig-vs-Foundry clock skew")
    p.add_argument("--no-window", action="store_true",
                   help="include chat events outside the recording window")
    p.set_defaults(fn=cmd_align)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
