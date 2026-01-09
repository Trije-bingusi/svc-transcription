#!/usr/bin/env python3
import argparse
import json
import re
from collections import Counter
from typing import List, Dict, Any

from faster_whisper import WhisperModel


def vtt_timestamp(seconds: float) -> str:
    if seconds is None or seconds != seconds:
        seconds = 0.0
    seconds = max(0.0, float(seconds))
    ms_total = int(round(seconds * 1000.0))
    h = ms_total // 3_600_000
    ms_total -= h * 3_600_000
    m = ms_total // 60_000
    ms_total -= m * 60_000
    s = ms_total // 1000
    ms = ms_total - s * 1000
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def write_vtt(segments: List[Dict[str, Any]], out_path: str) -> None:
    lines = ["WEBVTT", ""]
    cue_idx = 1
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", 0.0))
        if end <= start:
            continue

        lines.append(str(cue_idx))
        lines.append(f"{vtt_timestamp(start)} --> {vtt_timestamp(end)}")
        lines.append(text)
        lines.append("")
        cue_idx += 1

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def looks_like_loop(text: str) -> bool:
    tokens = re.findall(r"\w+", text.lower())
    if len(tokens) < 20:
        return False
    c = Counter(tokens)
    most_common = c.most_common(1)[0][1]
    return (most_common / len(tokens)) > 0.30


def main() -> int:
    p = argparse.ArgumentParser(description="Transcribe WAV with faster-whisper and output JSON + VTT.")
    p.add_argument("--model", required=True, help="Model name or HF repo id")
    p.add_argument("--language", default="sl")
    p.add_argument("--input_wav", required=True)
    p.add_argument("--out_json", required=True)
    p.add_argument("--out_vtt", required=True)

    p.add_argument("--compute_type", default="int8", help="int8 (CPU best), int8_float16, float16 (GPU), float32")
    p.add_argument("--beam_size", type=int, default=1)
    p.add_argument("--vad_filter", action="store_true", help="Enable VAD to skip silences (often improves segmentation)")
    p.add_argument("--max_segment_s", type=float, default=6.0, help="Split long segments to be subtitle-like")

    args = p.parse_args()

    model = WhisperModel(args.model, device="cpu", compute_type=args.compute_type)

    # Transcribe
    segments_iter, info = model.transcribe(
        args.input_wav,
        language=args.language,
        task="transcribe",
        beam_size=args.beam_size,
        vad_filter=args.vad_filter,
    )

    segments: List[Dict[str, Any]] = []

    for seg in segments_iter:
        text = (seg.text or "").strip()
        if not text:
            continue
        if looks_like_loop(text):
            continue

        start = float(seg.start)
        end = float(seg.end)
        if end <= start:
            continue

        # Split long segments into subtitle-sized chunks by time
        dur = end - start
        if dur > args.max_segment_s:
            n = int(dur // args.max_segment_s) + 1
            step = dur / n
            for i in range(n):
                s = start + i * step
                e = min(end, start + (i + 1) * step)
                segments.append({"start": s, "end": e, "text": text})
        else:
            segments.append({"start": start, "end": end, "text": text})

    if not segments:
        # fallback empty output
        segments = [{"start": 0.0, "end": 0.01, "text": ""}]

    with open(args.out_json, "w", encoding="utf-8") as f:
        json.dump(segments, f, ensure_ascii=False, indent=2)

    write_vtt(segments, args.out_vtt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
