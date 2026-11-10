"""生成 Deepscord 应用图标：紫色圆角渐变底 + 白色声波竖条。"""
from PIL import Image, ImageDraw
import os

S = 1024  # 超采样，最后缩小
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'desktop', 'assets')
os.makedirs(OUT, exist_ok=True)

# 渐变底（135°）
base = Image.new('RGB', (S, S))
px = base.load()
c1 = (143, 128, 255)   # #8f80ff
c2 = (86, 70, 214)     # #5646d6
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * (S - 1))
        px[x, y] = (
            round(c1[0] + (c2[0] - c1[0]) * t),
            round(c1[1] + (c2[1] - c1[1]) * t),
            round(c1[2] + (c2[2] - c1[2]) * t),
        )

# 圆角遮罩（iOS 风格 squircle 近似）
mask = Image.new('L', (S, S), 0)
md = ImageDraw.Draw(mask)
margin = int(S * 0.055)
md.rounded_rectangle(
    [margin, margin, S - margin, S - margin],
    radius=int(S * 0.235),
    fill=255,
)

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
img.paste(base, (0, 0), mask)

# 顶部柔光
glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([S * 0.1, -S * 0.45, S * 0.9, S * 0.45], fill=(255, 255, 255, 38))
img = Image.alpha_composite(img, Image.composite(glow, Image.new('RGBA', (S, S), (0, 0, 0, 0)), mask))

# 白色声波竖条（与网页 logo 同构）
bars = [
    (0.500, 0.44, 0.062),
    (0.402, 0.24, 0.056),
    (0.598, 0.24, 0.056),
    (0.305, 0.13, 0.048),
    (0.695, 0.13, 0.048),
]
draw = ImageDraw.Draw(img)
for cx, half_h, half_w in bars:
    x = cx * S
    h = half_h * S
    w = half_w * S
    draw.rounded_rectangle(
        [x - w / 2, S / 2 - h, x + w / 2, S / 2 + h],
        radius=w / 2,
        fill=(255, 255, 255, 255),
    )

# 输出
png = img.resize((512, 512), Image.LANCZOS)
png.save(os.path.join(OUT, 'icon.png'), 'PNG')

ico_sizes = [256, 128, 64, 48, 32, 16]
ico = img.resize((256, 256), Image.LANCZOS)
ico.save(os.path.join(OUT, 'icon.ico'), format='ICO', sizes=[(s, s) for s in ico_sizes])

print('icon written:', OUT)
