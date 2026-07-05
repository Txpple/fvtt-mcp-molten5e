#!/usr/bin/env python
"""Knock a token image's solid / green / blue / white background out to alpha.

Turns a background-baked token (a green- or blue-screen render, a flat white or
colored plate, or any busy background if rembg is installed) into a transparent
RGBA PNG ready to drop on a VTT.

    python token_cutout.py INPUT [OUTPUT]
        [--method auto|rembg|chroma]   # auto (default): rembg if installed, else chroma
        [--color RRGGBB]               # chroma key color; default = auto-detect from corners
        [--keep-shadow]                # chroma only: keep a cast shadow instead of keying it out
        [--no-preview]                 # skip the magenta fringe-check preview
        [--erode N]                    # shrink the matte N px inward to eat a residual fringe (default 0)

Always writes an RGBA PNG (default: INPUT with a .png extension, never overwriting
the source) plus INPUT_preview.png — the cutout composited over magenta so any
leftover fringe or over-eaten edge is obvious. Read that preview before trusting it.

Method guide:
  rembg  — AI matte (U^2-Net). Best for characters with soft edges / hair / a cast
           shadow, and the ONLY option that handles a busy (non-solid) background.
           Needs `pip install "rembg[cpu]"` (one-time ~176MB model download).
  chroma — offline, instant, deterministic. Best for a clean, flat solid-color
           plate (classic green/blue screen). Auto-detects the key color from the
           four corners; keys by channel-dominance for green/blue, color-distance
           otherwise, with edge feathering + spill suppression.
"""
import argparse
import os
import sys

from PIL import Image
import numpy as np


def despill(rgb, key):
    """Suppress the key hue's fringe on retained pixels (green/blue screens)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    kr, kg, kb = key
    if kg - max(kr, kb) > 25:            # green screen
        rgb[..., 1] = np.minimum(g, np.maximum(r, b))
    elif kb - max(kr, kg) > 25:          # blue screen
        rgb[..., 2] = np.minimum(b, np.maximum(r, g))
    elif min(kr, kb) - kg > 25:          # magenta screen — spill sits in r AND b
        spill = np.maximum(np.minimum(r, b) - g, 0.0)
        rgb[..., 0] = r - spill
        rgb[..., 2] = b - spill
    return rgb


def detect_key(a):
    """Median color of the four 24px corner patches."""
    p = 24
    corners = np.concatenate([
        a[:p, :p].reshape(-1, 3), a[:p, -p:].reshape(-1, 3),
        a[-p:, :p].reshape(-1, 3), a[-p:, -p:].reshape(-1, 3),
    ])
    return np.median(corners, axis=0)


def chroma(src, key=None, keep_shadow=False):
    a = np.asarray(src.convert("RGB")).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    if key is None:
        key = detect_key(a)
    kr, kg, kb = float(key[0]), float(key[1]), float(key[2])

    green = kg - max(kr, kb) > 25
    blue = kb - max(kr, kg) > 25

    if green or blue:
        # Channel-dominance metric — robust to brightness, so a dark cast shadow
        # (still green/blue, just darker) keys out too unless --keep-shadow.
        metric = (g - np.maximum(r, b)) if green else (b - np.maximum(r, g))
        bg = float(metric[[0, -1], [0, -1]].mean())      # corner reading
        bg = max(bg, 40.0)
        lo, hi = (0.55 if keep_shadow else 0.28) * bg, (0.75 if keep_shadow else 0.60) * bg
        alpha = np.clip((hi - metric) / (hi - lo), 0.0, 1.0)
    else:
        # Generic solid color: Euclidean distance from the key color.
        d = np.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2)
        lo, hi = 40.0, 120.0
        alpha = np.clip((d - lo) / (hi - lo), 0.0, 1.0)

    a = despill(a, (kr, kg, kb))
    return a, alpha


def via_rembg(src):
    from rembg import remove, new_session
    cut = remove(
        src, session=new_session("u2net"),
        alpha_matting=True, alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=15, alpha_matting_erode_size=8,
    ).convert("RGBA")
    a = np.asarray(cut).astype(np.float32)
    key = detect_key(np.asarray(src.convert("RGB")).astype(np.float32))
    a[..., :3] = despill(a[..., :3], (float(key[0]), float(key[1]), float(key[2])))
    return a[..., :3], a[..., 3] / 255.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--method", choices=["auto", "rembg", "chroma"], default="auto")
    ap.add_argument("--color")
    ap.add_argument("--keep-shadow", action="store_true")
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--erode", type=int, default=0)
    args = ap.parse_args()

    src = Image.open(args.input).convert("RGB")
    out_path = args.output or os.path.splitext(args.input)[0] + ".png"
    if os.path.abspath(out_path) == os.path.abspath(args.input):
        out_path = os.path.splitext(args.input)[0] + "_cutout.png"  # never clobber source

    key = None
    if args.color:
        h = args.color.lstrip("#")
        key = np.array([int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)], dtype=np.float32)

    method = args.method
    if method == "auto":
        try:
            import rembg  # noqa: F401
            method = "rembg"
        except ImportError:
            method = "chroma"

    if method == "rembg":
        rgb, alpha = via_rembg(src)
    else:
        rgb, alpha = chroma(src, key=key, keep_shadow=args.keep_shadow)

    if args.erode > 0:
        try:
            from scipy.ndimage import minimum_filter
            alpha = minimum_filter(alpha, size=2 * args.erode + 1)
        except ImportError:
            print("  (scipy not installed — --erode skipped)", file=sys.stderr)

    rgb = rgb.copy()
    rgb[alpha <= 0.004] = 0.0            # neutralize fully-keyed pixels (no bleed on scale)
    rgba = np.dstack([rgb, alpha * 255.0]).astype(np.uint8)
    out = Image.fromarray(rgba, "RGBA")
    out.save(out_path)

    print(f"method: {method}")
    print(f"saved:  {out_path}  ({out.size[0]}x{out.size[1]} RGBA)")
    print(f"subject coverage: {(alpha > 0.5).mean() * 100:.1f}%  "
          f"background removed: {(alpha <= 0.5).mean() * 100:.1f}%")

    if not args.no_preview:
        prev = os.path.splitext(out_path)[0] + "_preview.png"
        bg = Image.new("RGBA", out.size, (255, 0, 255, 255))
        Image.alpha_composite(bg, out).convert("RGB").save(prev)
        print(f"preview: {prev}  (open it - any halo/over-cut shows against magenta)")


if __name__ == "__main__":
    main()
