#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Minimal placeholder icons for suyue watch (dark rounded square, light glyph).
# Replace with designed artwork before release; these are valid PNGs so the
# Lite Wearable HAP packages and installs.
from PIL import Image, ImageDraw

def make(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size // 16
    d.rounded_rectangle([pad, pad, size - pad, size - pad],
                        radius=size // 5, fill=(16, 17, 20, 255))
    inner = size // 4
    d.rounded_rectangle([inner, inner, size - inner, size - inner],
                        radius=size // 10, fill=(52, 66, 89, 255))
    cx, cy = size // 2, size // 2
    w = size // 10
    d.rounded_rectangle([cx - w, cy - size // 6, cx + w, cy + size // 6],
                        radius=w // 2, fill=(242, 242, 242, 255))
    img.save(path, "PNG")

make(104, "watch/huawei/watch-lite/entry/src/main/resources/base/media/icon.png")
make(92, "watch/huawei/watch-lite/entry/src/main/resources/base/media/icon_small.png")
print("icons written")
