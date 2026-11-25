"""Draws the installer artwork (BMP files Windows installers need).

Run from the repository root:  python3 -I src-tauri/windows/make-installer-art.py
Needs Pillow, the Inter and JetBrains Mono fonts, and src-tauri/icons/icon.png.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = "src-tauri/windows"
ICON = Image.open("src-tauri/icons/icon.png").convert("RGBA")

FONT_DIRS = ["/usr/share/fonts/opentype/inter", "/usr/share/fonts/truetype/jetbrains-mono", os.path.expanduser("~/.fonts")]


def font(name, size):
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    sys.exit(f"font {name} not found")


BG_TOP = (9, 12, 17)
BG_BOTTOM = (18, 33, 52)
ACCENT = (90, 169, 230)
GREEN = (63, 185, 80)
TEXT = (232, 237, 243)
MUTED = (138, 148, 163)


def gradient(w, h):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = c
    return img


def glow(img, cx, cy, r, colour, strength):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse((cx - r, cy - r, cx + r, cy + r), fill=colour + (strength,))
    layer = layer.filter(ImageFilter.GaussianBlur(r * 0.55))
    base = img.convert("RGBA")
    base.alpha_composite(layer)
    return base.convert("RGB")


def grid(img, step, alpha):
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    for x in range(0, img.width, step):
        d.line((x, 0, x, img.height), fill=(255, 255, 255, alpha))
    for y in range(0, img.height, step):
        d.line((0, y, img.width, y), fill=(255, 255, 255, alpha))
    base = img.convert("RGBA")
    base.alpha_composite(over)
    return base.convert("RGB")


def paste_icon(img, size, x, y):
    ic = ICON.resize((size, size), Image.LANCZOS)
    base = img.convert("RGBA")
    # soft shadow
    sh = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x + 2, y + 4, x + size + 2, y + size + 4), radius=size // 5, fill=(0, 0, 0, 150))
    base.alpha_composite(sh.filter(ImageFilter.GaussianBlur(5)))
    base.alpha_composite(ic, (x, y))
    return base.convert("RGB")


def centered(d, w, y, text, f, fill):
    tw = d.textlength(text, font=f)
    d.text(((w - tw) / 2, y), text, font=f, fill=fill)


def side_panel(w, h):
    """The dark art panel used by the NSIS sidebar and the MSI dialog."""
    img = gradient(w, h)
    img = grid(img, 14, 9)
    img = glow(img, w // 2, 70, 70, ACCENT, 70)
    img = glow(img, w - 10, h - 30, 60, (124, 92, 230), 45)
    img = paste_icon(img, 64, (w - 64) // 2, 34)
    d = ImageDraw.Draw(img)
    centered(d, w, 108, "Siakap", font("Inter-Bold.otf", 25), TEXT)
    centered(d, w, 137, "TERMINAL", font("Inter-SemiBold.otf", 10), ACCENT)
    d.line(((w - 40) / 2, 158, (w + 40) / 2, 158), fill=ACCENT, width=2)
    # a little terminal card
    cx, cy, cw, ch = 14, 170, w - 28, 70
    card = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(card).rounded_rectangle((cx, cy, cx + cw, cy + ch), radius=7, fill=(5, 8, 12, 190), outline=(255, 255, 255, 28))
    base = img.convert("RGBA")
    base.alpha_composite(card)
    img = base.convert("RGB")
    d = ImageDraw.Draw(img)
    for i, c in enumerate([(248, 81, 73), (210, 153, 34), GREEN]):
        d.ellipse((cx + 8 + i * 10, cy + 7, cx + 14 + i * 10, cy + 13), fill=c)
    mono = font("JetBrainsMono-Medium.ttf", 9)
    lines = [
        [("$ ", GREEN), ("ssh core-sw01", TEXT)],
        [("  host key ", MUTED), ("trusted", ACCENT)],
        [("core-sw01# ", GREEN), ("show ver", TEXT)],
        [("$ ", GREEN), ("_", ACCENT)],
    ]
    for i, parts in enumerate(lines):
        x = cx + 8
        for text, colour in parts:
            d.text((x, cy + 20 + i * 12), text, font=mono, fill=colour)
            x += d.textlength(text, font=mono)
    small = font("Inter-Medium.otf", 10)
    for i, t in enumerate(["Encrypted session vault", "SSH  ·  SFTP  ·  Serial", "Macros  ·  Split panes"]):
        y = cy + ch + 14 + i * 17
        d.ellipse((cx + 2, y + 4, cx + 7, y + 9), fill=ACCENT)
        d.text((cx + 14, y), t, font=small, fill=TEXT)
    return img


def header(w, h, bg=(255, 255, 255)):
    """Right-hand header logo for inner pages (white page header)."""
    img = Image.new("RGB", (w, h), bg)
    size = 34
    img = paste_icon(img, size, w - size - 10, (h - size) // 2 - 1)
    d = ImageDraw.Draw(img)
    f = font("Inter-Bold.otf", 15)
    t = "Siakap"
    tw = d.textlength(t, font=f)
    x = w - size - 18 - tw
    d.text((x, h / 2 - 15), t, font=f, fill=(17, 21, 28))
    d.text((x, h / 2 + 3), "Terminal", font=font("Inter-SemiBold.otf", 10), fill=(41, 121, 191))
    return img


def save(img, name):
    img.convert("RGB").save(os.path.join(OUT, name), format="BMP")
    print("wrote", name, img.size)


# NSIS (setup.exe): welcome/finish sidebar 164x314, inner-page header 150x57.
save(side_panel(164, 314), "nsis-sidebar.bmp")
save(header(150, 57), "nsis-header.bmp")

# MSI: top banner 493x58 (text is drawn on its left), welcome/finish dialog 493x312.
banner = Image.new("RGB", (493, 58), (255, 255, 255))
banner.paste(header(170, 58), (493 - 170, 0))
d = ImageDraw.Draw(banner)
d.line((0, 57, 493, 57), fill=(225, 230, 236))
save(banner, "msi-banner.bmp")
dialog = Image.new("RGB", (493, 312), (255, 255, 255))
dialog.paste(side_panel(164, 312), (0, 0))
save(dialog, "msi-dialog.bmp")
