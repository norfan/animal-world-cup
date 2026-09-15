import math
import os
from PIL import Image, ImageDraw

SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

res_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "res"))


def make_icon(S):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(S * 0.06)
    r = int(S * 0.22)
    # 蓝色圆角背景
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=r, fill=(59, 130, 246, 255))
    # 白色足球圆
    cx = cy = S // 2
    R = int(S * 0.30)
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(255, 255, 255, 255))
    # 中心黑色五边形
    pr = int(S * 0.12)
    pts = []
    for i in range(5):
        ang = -math.pi / 2 + i * 2 * math.pi / 5
        pts.append((cx + pr * math.cos(ang), cy + pr * math.sin(ang)))
    d.polygon(pts, fill=(15, 23, 42, 255))
    return img


def main():
    for folder, S in SIZES.items():
        out = os.path.join(res_dir, folder, "ic_launcher.png")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        make_icon(S).save(out)
        print("wrote", out)


if __name__ == "__main__":
    main()
