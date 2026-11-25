#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI-Veil 图标生成脚本。

项目本身不携带任何二进制素材依赖；图标用 Pillow 现场绘制并写盘：
    src-tauri/icons/32x32.png
    src-tauri/icons/128x128.png
    src-tauri/icons/128x128@2x.png
    src-tauri/icons/icon.png
    src-tauri/icons/icon.ico
    src-tauri/icons/tray.png

用法：
    python scripts/gen_icons.py
（需要 Pillow；若使用 DSH 自带运行时的 python，Pillow 已内置。）
"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "src-tauri" / "icons"

ORANGE = (255, 122, 24, 255)
ORANGE_DARK = (214, 92, 10, 255)
INK = (26, 20, 16, 255)
CREAM = (255, 245, 236, 255)


def draw_mark(size: int, transparent_bg: bool = True) -> Image.Image:
    """画一枚「猫脸 + 边框」标记：橙色圆底 + 猫耳 + 两只眼睛。"""
    scale = 8  # 超采样后缩放，边缘更干净
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(s * 0.05)
    # 圆角方底
    d.rounded_rectangle(
        [pad, pad, s - pad, s - pad],
        radius=int(s * 0.26),
        fill=ORANGE,
        outline=ORANGE_DARK,
        width=max(1, int(s * 0.02)),
    )

    # 猫耳（两个三角）
    ear_h = s * 0.20
    ear_w = s * 0.22
    left_x = s * 0.24
    right_x = s * 0.76
    top_y = s * 0.26
    d.polygon(
        [(left_x, top_y + ear_h), (left_x + ear_w * 0.5, top_y), (left_x + ear_w, top_y + ear_h)],
        fill=INK,
    )
    d.polygon(
        [(right_x - ear_w, top_y + ear_h), (right_x - ear_w * 0.5, top_y), (right_x, top_y + ear_h)],
        fill=INK,
    )

    # 脸
    face = [s * 0.20, s * 0.32, s * 0.80, s * 0.78]
    d.ellipse(face, fill=INK)

    # 眼睛
    eye_r = s * 0.055
    for cx in (s * 0.38, s * 0.62):
        cy = s * 0.52
        d.ellipse([cx - eye_r, cy - eye_r, cx + eye_r, cy + eye_r], fill=CREAM)

    # 胡须
    for dy in (-0.03, 0.02, 0.07):
        d.line(
            [(s * 0.30, s * (0.62 + dy)), (s * 0.18, s * (0.60 + dy))],
            fill=CREAM,
            width=max(1, int(s * 0.012)),
        )
        d.line(
            [(s * 0.70, s * (0.62 + dy)), (s * 0.82, s * (0.60 + dy))],
            fill=CREAM,
            width=max(1, int(s * 0.012)),
        )

    out = img.resize((size, size), Image.LANCZOS)
    if not transparent_bg:
        bg = Image.new("RGBA", (size, size), (14, 17, 22, 255))
        bg.alpha_composite(out)
        return bg
    return out


def draw_tray(size: int = 32) -> Image.Image:
    """托盘图标：单色描边风格的实心圆（macOS 模板图标友好）。"""
    scale = 8
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([s * 0.12, s * 0.12, s * 0.88, s * 0.88], fill=(60, 60, 62, 255))
    d.ellipse([s * 0.30, s * 0.30, s * 0.70, s * 0.70], fill=(255, 255, 255, 255))
    d.ellipse([s * 0.42, s * 0.42, s * 0.58, s * 0.58], fill=(255, 122, 24, 255))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    targets = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }
    for name, size in targets.items():
        draw_mark(size).save(ICON_DIR / name)
        print(f"wrote {name} ({size}x{size})")

    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base = draw_mark(256)
    base.save(ICON_DIR / "icon.ico", sizes=ico_sizes)
    print("wrote icon.ico")

    draw_tray(32).save(ICON_DIR / "tray.png")
    print("wrote tray.png")

    # macOS 需要 .icns 时可用系统命令转换（可选，不强制）
    if os.name == "posix":
        print("提示：如需 .icns，可在 macOS 上执行 iconutil 由 iconset 生成。")


if __name__ == "__main__":
    main()
