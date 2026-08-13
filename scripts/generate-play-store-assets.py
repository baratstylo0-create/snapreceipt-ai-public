from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter


OUT = Path.home() / "Downloads" / "SnapReceiptAI-PlayStore-Assets"

COLORS = {
    "blue": "#2563eb",
    "blue_dark": "#1d4ed8",
    "blue_deep": "#0b1730",
    "blue_ink": "#102a56",
    "blue_pale": "#eaf2ff",
    "blue_faint": "#f6f9ff",
    "white": "#ffffff",
    "ink": "#10213d",
    "muted": "#61738f",
    "line": "#dbe5f4",
    "green": "#16a36a",
    "green_pale": "#e8f8f0",
}


def font(size, bold=False, serif=False):
    if serif:
        candidates = [
            "C:/Windows/Fonts/georgiab.ttf" if bold else "C:/Windows/Fonts/georgia.ttf",
            "C:/Windows/Fonts/timesbd.ttf" if bold else "C:/Windows/Fonts/times.ttf",
        ]
    else:
        candidates = [
            "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def rounded_line(draw, points, fill, width):
    draw.line(points, fill=fill, width=width, joint="curve")
    radius = width // 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def label(draw, xy, value, size, fill, bold=False, serif=False, anchor=None):
    draw.text(xy, value, font=font(size, bold=bold, serif=serif), fill=fill, anchor=anchor)


def wrapped_lines(draw, value, max_width, size, bold=False, serif=False):
    typeface = font(size, bold=bold, serif=serif)
    lines = []
    current = ""
    for word in value.split():
        candidate = f"{current} {word}".strip()
        if not current or draw.textlength(candidate, font=typeface) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def vertical_gradient(size, top, bottom):
    image = Image.new("RGB", size)
    pixels = image.load()
    top_rgb = tuple(int(top[i:i + 2], 16) for i in (1, 3, 5))
    bottom_rgb = tuple(int(bottom[i:i + 2], 16) for i in (1, 3, 5))
    height = max(1, size[1] - 1)
    for y in range(size[1]):
        ratio = y / height
        color = tuple(int(top_rgb[i] * (1 - ratio) + bottom_rgb[i] * ratio) for i in range(3))
        for x in range(size[0]):
            pixels[x, y] = color
    return image.convert("RGBA")


def shadowed_panel(base, box, radius, fill, shadow=(11, 23, 48, 48), blur=18, outline=None):
    x1, y1, x2, y2 = box
    shadow_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    rounded(shadow_draw, (x1 + 12, y1 + 18, x2 + 12, y2 + 18), radius, shadow)
    base.alpha_composite(shadow_layer.filter(ImageFilter.GaussianBlur(blur)))
    draw = ImageDraw.Draw(base)
    rounded(draw, box, radius, fill, outline=outline, width=2 if outline else 1)
    return draw


def draw_receipt_mark(draw, x, y, scale=1.0, fill=None, cutout=None):
    fill = fill or COLORS["white"]
    cutout = cutout or COLORS["blue"]
    width = int(130 * scale)
    height = int(168 * scale)
    rounded(draw, (x, y, x + width, y + height), int(18 * scale), fill)
    tooth = int(17 * scale)
    for index in range(5):
        left = x + int(13 * scale) + index * int(25 * scale)
        draw.polygon([(left, y + height - 2), (left + tooth, y + height - 2), (left + tooth // 2, y + height + tooth)], fill=fill)
    draw.line((x + int(23 * scale), y + int(35 * scale), x + width - int(23 * scale), y + int(35 * scale)), fill=cutout, width=max(2, int(7 * scale)))
    draw.line((x + int(23 * scale), y + int(59 * scale), x + width - int(38 * scale), y + int(59 * scale)), fill=cutout, width=max(2, int(7 * scale)))
    draw.line((x + int(23 * scale), y + int(83 * scale), x + width - int(23 * scale), y + int(83 * scale)), fill=cutout, width=max(2, int(7 * scale)))
    draw.ellipse((x + int(34 * scale), y + int(105 * scale), x + int(95 * scale), y + int(166 * scale)), fill=cutout)
    draw.line((x + int(48 * scale), y + int(135 * scale), x + int(61 * scale), y + int(149 * scale)), fill=fill, width=max(3, int(8 * scale)), joint="curve")
    draw.line((x + int(61 * scale), y + int(149 * scale), x + int(84 * scale), y + int(122 * scale)), fill=fill, width=max(3, int(8 * scale)), joint="curve")


def draw_excel_sheet(draw, x, y, width, height, scale=1.0):
    rounded(draw, (x, y, x + width, y + height), int(18 * scale), COLORS["white"], COLORS["line"], max(1, int(2 * scale)))
    header_h = int(54 * scale)
    draw.rectangle((x, y, x + width, y + header_h), fill=COLORS["blue_pale"])
    columns = [0.20, 0.49, 0.75]
    headings = ["Date", "Merchant", "Amount"]
    for fraction, heading in zip(columns, headings):
        label(draw, (x + int(width * fraction), y + header_h // 2), heading, int(15 * scale), COLORS["blue_ink"], bold=True, anchor="mm")
    rows = [("12 Aug", "Fuel", "85.20"), ("12 Aug", "Lunch", "24.00"), ("13 Aug", "Supplies", "139.90"), ("13 Aug", "Taxi", "18.00")]
    row_h = int(59 * scale)
    for row_index, row in enumerate(rows):
        top = y + header_h + row_index * row_h
        draw.line((x + int(16 * scale), top, x + width - int(16 * scale), top), fill=COLORS["line"], width=max(1, int(scale)))
        for fraction, value in zip(columns, row):
            label(draw, (x + int(width * fraction), top + row_h // 2), value, int(15 * scale), COLORS["ink"], bold=value == row[-1], anchor="mm")


def draw_phone(base, x, y, width, height, variant):
    draw = ImageDraw.Draw(base)
    shadowed_panel(base, (x, y, x + width, y + height), int(width * 0.13), COLORS["blue_deep"], blur=20)
    screen = (x + int(width * 0.045), y + int(height * 0.025), x + width - int(width * 0.045), y + height - int(height * 0.025))
    rounded(draw, screen, int(width * 0.10), COLORS["blue_faint"])
    sx, sy, ex, ey = screen
    rounded(draw, (x + width // 2 - int(width * 0.13), y + int(height * 0.045), x + width // 2 + int(width * 0.13), y + int(height * 0.065)), int(width * 0.02), COLORS["blue_deep"])
    pad = int(width * 0.12)
    label(draw, (sx + pad, sy + int(height * 0.10)), "SnapReceipt", int(width * 0.075), COLORS["blue_ink"], bold=True)
    label(draw, (sx + pad, sy + int(height * 0.145)), "Expense workspace", int(width * 0.037), COLORS["muted"])

    if variant == "scan":
        rounded(draw, (sx + pad, sy + int(height * 0.22), ex - pad, sy + int(height * 0.50)), int(width * 0.055), COLORS["white"], COLORS["line"], 2)
        draw_receipt_mark(draw, sx + int(width * 0.27), sy + int(height * 0.265), width / 280, COLORS["blue_pale"], COLORS["blue"])
        label(draw, ((sx + ex) // 2, sy + int(height * 0.55)), "Receipt details found", int(width * 0.042), COLORS["blue_ink"], bold=True, anchor="mm")
        label(draw, ((sx + ex) // 2, sy + int(height * 0.59)), "Merchant, date and total", int(width * 0.035), COLORS["muted"], anchor="mm")
        rounded(draw, (sx + pad, ey - int(height * 0.13), ex - pad, ey - int(height * 0.06)), int(width * 0.04), COLORS["blue"])
        label(draw, ((sx + ex) // 2, ey - int(height * 0.095)), "Review receipt", int(width * 0.043), COLORS["white"], bold=True, anchor="mm")
    elif variant == "review":
        rounded(draw, (sx + pad, sy + int(height * 0.22), ex - pad, sy + int(height * 0.63)), int(width * 0.055), COLORS["white"], COLORS["line"], 2)
        label(draw, (sx + pad * 1.5, sy + int(height * 0.27)), "Extracted expense", int(width * 0.04), COLORS["muted"], bold=True)
        fields = [("Merchant", "Kedai Makan Seri"), ("Date", "12 Aug 2026"), ("Amount", "MYR 42.80"), ("Category", "Meals")]
        for index, (field, value) in enumerate(fields):
            top = sy + int(height * (0.34 + index * 0.065))
            label(draw, (sx + pad * 1.5, top), field, int(width * 0.032), COLORS["muted"])
            label(draw, (ex - pad * 1.5, top), value, int(width * 0.036), COLORS["ink"], bold=field == "Amount", anchor="ra")
        rounded(draw, (sx + pad, ey - int(height * 0.13), ex - pad, ey - int(height * 0.06)), int(width * 0.04), COLORS["blue"])
        label(draw, ((sx + ex) // 2, ey - int(height * 0.095)), "Save expense", int(width * 0.043), COLORS["white"], bold=True, anchor="mm")
    elif variant == "dashboard":
        cards = [("This month", "MYR 2,418", COLORS["blue"]), ("Receipts", "126", COLORS["green"])]
        for index, (heading, value, color) in enumerate(cards):
            left = sx + pad + index * int((width - pad * 2) / 2)
            right = left + int((width - pad * 2) / 2) - int(width * 0.03)
            top = sy + int(height * 0.22)
            rounded(draw, (left, top, right, top + int(height * 0.12)), int(width * 0.04), COLORS["white"], COLORS["line"], 2)
            label(draw, (left + int(width * 0.03), top + int(height * 0.035)), heading, int(width * 0.028), COLORS["muted"])
            label(draw, (left + int(width * 0.03), top + int(height * 0.08)), value, int(width * 0.043), color, bold=True)
        label(draw, (sx + pad, sy + int(height * 0.40)), "Recent expenses", int(width * 0.042), COLORS["blue_ink"], bold=True)
        rows = [("Petrol", "MYR 85.20"), ("Lunch", "MYR 24.00"), ("Supplies", "MYR 139.90")]
        for index, (name, value) in enumerate(rows):
            top = sy + int(height * (0.47 + index * 0.085))
            draw.line((sx + pad, top + int(height * 0.058), ex - pad, top + int(height * 0.058)), fill=COLORS["line"], width=2)
            label(draw, (sx + pad, top), name, int(width * 0.037), COLORS["ink"], bold=True)
            label(draw, (ex - pad, top), value, int(width * 0.037), COLORS["muted"], anchor="ra")
        rounded(draw, (sx + pad, ey - int(height * 0.13), ex - pad, ey - int(height * 0.06)), int(width * 0.04), COLORS["blue"])
        label(draw, ((sx + ex) // 2, ey - int(height * 0.095)), "View all expenses", int(width * 0.043), COLORS["white"], bold=True, anchor="mm")
    else:
        label(draw, (sx + pad, sy + int(height * 0.21)), "Ready for Excel", int(width * 0.06), COLORS["blue_ink"], bold=True)
        label(draw, (sx + pad, sy + int(height * 0.265)), "Clean rows. No retyping.", int(width * 0.035), COLORS["muted"])
        draw_excel_sheet(draw, sx + pad, sy + int(height * 0.34), ex - sx - pad * 2, int(height * 0.35), width / 430)
        rounded(draw, (sx + pad, ey - int(height * 0.13), ex - pad, ey - int(height * 0.06)), int(width * 0.04), COLORS["green"])
        label(draw, ((sx + ex) // 2, ey - int(height * 0.095)), "Export Excel report", int(width * 0.043), COLORS["white"], bold=True, anchor="mm")


def draw_desktop(base, x, y, width, height, variant):
    draw = ImageDraw.Draw(base)
    rounded(draw, (x, y, x + width, y + height), 28, COLORS["blue_deep"])
    rounded(draw, (x + 18, y + 18, x + width - 18, y + height - 18), 18, COLORS["blue_faint"])
    label(draw, (x + 54, y + 58), "SnapReceipt", 30, COLORS["blue_ink"], bold=True)
    label(draw, (x + 54, y + 104), "Expense workspace", 17, COLORS["muted"])
    sidebar_x = x + 40
    for index, item in enumerate(["Overview", "Expenses", "Reports"]):
        top = y + 170 + index * 58
        if (variant == "excel" and item == "Reports") or (variant != "excel" and item == "Overview"):
            rounded(draw, (sidebar_x, top - 10, sidebar_x + 170, top + 36), 13, COLORS["blue_pale"])
        label(draw, (sidebar_x + 20, top + 12), item, 18, COLORS["blue"] if item == "Reports" and variant == "excel" else COLORS["blue_ink"], bold=True if item == "Reports" and variant == "excel" else False, anchor="lm")
    content_x = x + 280
    label(draw, (content_x, y + 68), "Expense reports", 30, COLORS["blue_ink"], bold=True)
    label(draw, (content_x, y + 110), "Everything organized and ready to export.", 18, COLORS["muted"])
    if variant == "excel":
        draw_excel_sheet(draw, content_x, y + 170, width - 350, 350, 1.1)
        rounded(draw, (content_x, y + 570, content_x + 250, y + 626), 16, COLORS["green"])
        label(draw, (content_x + 125, y + 598), "Download Excel", 18, COLORS["white"], bold=True, anchor="mm")
    else:
        for index, (heading, value) in enumerate([("This month", "MYR 2,418"), ("Receipts", "126"), ("Categories", "8")]):
            left = content_x + index * 190
            rounded(draw, (left, y + 175, left + 170, y + 275), 18, COLORS["white"], COLORS["line"], 2)
            label(draw, (left + 22, y + 210), heading, 15, COLORS["muted"])
            label(draw, (left + 22, y + 250), value, 24, COLORS["blue"], bold=True)
        label(draw, (content_x, y + 335), "Recent expenses", 22, COLORS["blue_ink"], bold=True)
        rows = [("Petrol", "MYR 85.20"), ("Lunch", "MYR 24.00"), ("Supplies", "MYR 139.90")]
        for index, row in enumerate(rows):
            top = y + 390 + index * 62
            draw.line((content_x, top + 42, x + width - 50, top + 42), fill=COLORS["line"], width=2)
            label(draw, (content_x, top), row[0], 18, COLORS["ink"], bold=True)
            label(draw, (x + width - 50, top), row[1], 18, COLORS["muted"], anchor="ra")


def make_icon(path):
    image = vertical_gradient((512, 512), COLORS["blue"], COLORS["blue_dark"])
    draw = ImageDraw.Draw(image)
    # Keep the mark legible at launcher size: a clean capture frame, not a generic
    # checkmark, dollar sign, or oversized decorative background shape.
    white = COLORS["white"]
    accent = "#9fc0ff"
    stroke = 20
    left, top, right, bottom = 82, 82, 430, 430
    corner = 88
    bracket = "#dbeafe"
    rounded_line(draw, ((left + corner, top), (left + 28, top)), bracket, stroke)
    rounded_line(draw, ((left, top + 28), (left, top + corner)), bracket, stroke)
    rounded_line(draw, ((right - corner, top), (right - 28, top)), bracket, stroke)
    rounded_line(draw, ((right, top + 28), (right, top + corner)), bracket, stroke)
    rounded_line(draw, ((left + corner, bottom), (left + 28, bottom)), bracket, stroke)
    rounded_line(draw, ((left, bottom - 28), (left, bottom - corner)), bracket, stroke)
    rounded_line(draw, ((right - corner, bottom), (right - 28, bottom)), bracket, stroke)
    rounded_line(draw, ((right, bottom - 28), (right, bottom - corner)), bracket, stroke)

    receipt_x, receipt_y, receipt_w, receipt_h = 154, 112, 204, 292
    paper = [(receipt_x, receipt_y), (receipt_x + receipt_w - 54, receipt_y), (receipt_x + receipt_w, receipt_y + 54),
             (receipt_x + receipt_w, receipt_y + receipt_h - 20), (receipt_x + receipt_w - 22, receipt_y + receipt_h),
             (receipt_x + receipt_w - 46, receipt_y + receipt_h - 22), (receipt_x + receipt_w - 70, receipt_y + receipt_h),
             (receipt_x + receipt_w - 94, receipt_y + receipt_h - 22), (receipt_x + receipt_w - 118, receipt_y + receipt_h),
             (receipt_x + receipt_w - 142, receipt_y + receipt_h - 22), (receipt_x, receipt_y + receipt_h)]
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.polygon([(x + 8, y + 12) for x, y in paper], fill=(8, 23, 64, 70))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(10)))
    draw = ImageDraw.Draw(image)
    draw.polygon(paper, fill=white)
    draw.polygon([(receipt_x + receipt_w - 54, receipt_y), (receipt_x + receipt_w - 54, receipt_y + 54),
                  (receipt_x + receipt_w, receipt_y + 54)], fill=accent)
    rounded_line(draw, ((receipt_x + 34, receipt_y + 96), (receipt_x + 150, receipt_y + 96)), COLORS["blue"], 12)
    rounded_line(draw, ((receipt_x + 34, receipt_y + 140), (receipt_x + 166, receipt_y + 140)), COLORS["blue_dark"], 12)
    rounded_line(draw, ((receipt_x + 34, receipt_y + 184), (receipt_x + 148, receipt_y + 184)), COLORS["blue_dark"], 12)
    rounded_line(draw, ((receipt_x + 34, receipt_y + 228), (receipt_x + 108, receipt_y + 228)), COLORS["blue"], 12)
    image.convert("RGB").save(path, "PNG", optimize=True)


def make_adaptive_foreground(path, size):
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    scale = size / 512
    draw = ImageDraw.Draw(image)
    white = COLORS["white"]
    accent = "#9fc0ff"
    stroke = max(2, round(20 * scale))
    left, top, right, bottom = [round(value * scale) for value in (82, 82, 430, 430)]
    corner = round(88 * scale)
    bracket = "#dbeafe"
    rounded_line(draw, ((left + corner, top), (left + 28 * scale, top)), bracket, stroke)
    rounded_line(draw, ((left, top + 28 * scale), (left, top + corner)), bracket, stroke)
    rounded_line(draw, ((right - corner, top), (right - 28 * scale, top)), bracket, stroke)
    rounded_line(draw, ((right, top + 28 * scale), (right, top + corner)), bracket, stroke)
    rounded_line(draw, ((left + corner, bottom), (left + 28 * scale, bottom)), bracket, stroke)
    rounded_line(draw, ((left, bottom - 28 * scale), (left, bottom - corner)), bracket, stroke)
    rounded_line(draw, ((right - corner, bottom), (right - 28 * scale, bottom)), bracket, stroke)
    rounded_line(draw, ((right, bottom - 28 * scale), (right, bottom - corner)), bracket, stroke)

    receipt_x, receipt_y, receipt_w, receipt_h = [round(value * scale) for value in (154, 112, 204, 292)]
    paper = [(receipt_x, receipt_y), (receipt_x + receipt_w - round(54 * scale), receipt_y),
             (receipt_x + receipt_w, receipt_y + round(54 * scale)),
             (receipt_x + receipt_w, receipt_y + receipt_h - round(20 * scale)),
             (receipt_x + receipt_w - round(22 * scale), receipt_y + receipt_h),
             (receipt_x + receipt_w - round(46 * scale), receipt_y + receipt_h - round(22 * scale)),
             (receipt_x + receipt_w - round(70 * scale), receipt_y + receipt_h),
             (receipt_x + receipt_w - round(94 * scale), receipt_y + receipt_h - round(22 * scale)),
             (receipt_x + receipt_w - round(118 * scale), receipt_y + receipt_h),
             (receipt_x + receipt_w - round(142 * scale), receipt_y + receipt_h - round(22 * scale)),
             (receipt_x, receipt_y + receipt_h)]
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.polygon([(x + round(8 * scale), y + round(12 * scale)) for x, y in paper], fill=(8, 23, 64, 70))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(max(1, round(10 * scale)))))
    draw = ImageDraw.Draw(image)
    draw.polygon(paper, fill=white)
    fold = round(54 * scale)
    draw.polygon([(receipt_x + receipt_w - fold, receipt_y),
                  (receipt_x + receipt_w - fold, receipt_y + fold),
                  (receipt_x + receipt_w, receipt_y + fold)], fill=accent)
    for y, width, color in ((96, 116, COLORS["blue"]), (140, 132, COLORS["blue_dark"]),
                            (184, 114, COLORS["blue_dark"]), (228, 74, COLORS["blue"])):
        rounded_line(draw, ((receipt_x + round(34 * scale), receipt_y + round(y * scale)),
                            (receipt_x + round((34 + width) * scale), receipt_y + round(y * scale))),
                     color, max(2, round(12 * scale)))
    image.save(path, "PNG", optimize=True)


def make_android_icons():
    resource_root = Path(__file__).resolve().parents[1] / "android" / "app" / "src" / "main" / "res"
    sizes = {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96,
             "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}
    source = OUT / "icon" / "snapreceipt-icon-512.png"
    with Image.open(source) as image:
        for folder, size in sizes.items():
            directory = resource_root / folder
            resized = image.resize((size, size), Image.Resampling.LANCZOS)
            for name in ("ic_launcher.png", "ic_launcher_round.png"):
                resized.save(directory / name, "PNG", optimize=True)
            make_adaptive_foreground(directory / "ic_launcher_foreground.png", size)


def make_wordmark(path, dark=False, scale=2):
    width, height = 720 * scale, 112 * scale
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    ink = COLORS["white"] if dark else COLORS["ink"]
    receipt = "#60a5fa" if dark else COLORS["blue"]
    draw.text((0, 0), "Snap", font=font(72 * scale, bold=True), fill=ink, stroke_width=0)
    draw.text((184 * scale, 0), "Receipt", font=font(72 * scale, bold=True), fill=receipt, stroke_width=0)
    rounded(draw, (568 * scale, 12 * scale, 668 * scale, 100 * scale), 16 * scale, COLORS["blue"])
    label(draw, (618 * scale, 56 * scale), "AI", 54 * scale, COLORS["white"], bold=True, anchor="mm")
    image.save(path, "PNG", optimize=True)


def make_feature_graphic(path):
    image = vertical_gradient((1024, 500), COLORS["blue"], COLORS["blue_dark"])
    draw = ImageDraw.Draw(image)
    draw.ellipse((610, -270, 1180, 300), fill=(255, 255, 255, 22))
    draw.ellipse((720, 260, 1190, 700), fill=(8, 36, 100, 52))
    label(draw, (64, 66), "SNAPRECEIPT", 17, "#bcd4ff", bold=True)
    label(draw, (64, 112), "Scan receipts.", 54, COLORS["white"], bold=True, serif=True)
    label(draw, (64, 174), "Export clean reports.", 54, COLORS["white"], bold=True, serif=True)
    label(draw, (68, 258), "From receipt photo to organized expense records", 23, "#d9e7ff")
    label(draw, (68, 290), "without manual key-ins.", 23, "#d9e7ff")
    rounded(draw, (68, 370, 366, 436), 18, COLORS["white"])
    label(draw, (217, 403), "Built for faster admin", 18, COLORS["blue_ink"], bold=True, anchor="mm")
    draw_phone(image, 676, 28, 258, 444, "excel")
    image.convert("RGB").save(path, "PNG", optimize=True)


def make_portrait(path, headline, subhead, variant, size):
    width, height = size
    scale = width / 1080
    image = Image.new("RGBA", size, COLORS["blue_faint"])
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, int(530 * scale)), fill=COLORS["blue_pale"])
    draw.ellipse((width - int(250 * scale), -int(190 * scale), width + int(90 * scale), int(150 * scale)), fill=(37, 99, 235, 22))
    draw.line((width - int(230 * scale), int(100 * scale), width - int(80 * scale), int(100 * scale)), fill=(37, 99, 235, 55), width=max(2, int(5 * scale)))
    label(draw, (74 * scale, 78 * scale), "SNAPRECEIPT", int(18 * scale), COLORS["blue"], bold=True)
    label(draw, (74 * scale, 130 * scale), headline, int(62 * scale), COLORS["blue_ink"], bold=True, serif=True)
    lines = wrapped_lines(draw, subhead, int(900 * scale), int(28 * scale))
    for index, line in enumerate(lines):
        label(draw, (78 * scale, (238 + index * 40) * scale), line, int(28 * scale), COLORS["muted"])
    phone_width = int(670 * scale)
    phone_height = int(1280 * scale)
    draw_phone(image, int((width - phone_width) / 2), int(530 * scale), phone_width, phone_height, variant)
    image.convert("RGB").save(path, "PNG", optimize=True)


def make_landscape(path, headline, subhead, variant):
    image = Image.new("RGBA", (2560, 1440), COLORS["blue_faint"])
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 1110, 1440), fill=COLORS["blue"])
    draw.line((145, 150, 500, 150), fill=(255, 255, 255, 70), width=5)
    draw.line((145, 166, 350, 166), fill=(255, 255, 255, 42), width=3)
    draw.ellipse((720, 1040, 1120, 1440), fill=(8, 36, 100, 45))
    label(draw, (140, 230), "SNAPRECEIPT", 25, "#bcd4ff", bold=True)
    label(draw, (140, 305), headline, 78, COLORS["white"], bold=True, serif=True)
    lines = wrapped_lines(draw, subhead, 760, 35)
    for index, line in enumerate(lines):
        label(draw, (145, 465 + index * 50), line, 35, "#d9e7ff")
    rounded(draw, (145, 700, 515, 780), 22, COLORS["white"])
    label(draw, (330, 740), "No manual key-ins", 24, COLORS["blue_ink"], bold=True, anchor="mm")
    draw_desktop(image, 1230, 180, 1160, 850, variant)
    image.convert("RGB").save(path, "PNG", optimize=True)


def main():
    for folder in ["icon", "feature-graphic", "phone", "tablet-7-inch", "tablet-10-inch", "chromebook"]:
        (OUT / folder).mkdir(parents=True, exist_ok=True)

    make_icon(OUT / "icon" / "snapreceipt-icon-512.png")
    make_android_icons()
    make_wordmark(OUT / "snapreceipt-wordmark.png")
    make_wordmark(OUT / "snapreceipt-wordmark-dark.png", dark=True)
    make_feature_graphic(OUT / "feature-graphic" / "snapreceipt-feature-1024x500.png")

    assets = [
        ("01-scan-receipts.png", "From paper to expense record", "Snap a receipt and get the important details organized in seconds.", "scan"),
        ("02-no-manual-keyins.png", "Skip the spreadsheet key-ins", "Review extracted details instead of typing merchant, date and amount.", "review"),
        ("03-dashboard.png", "Know where every ringgit goes", "Keep receipts, categories and totals together in one clear workspace.", "dashboard"),
        ("04-excel-export.png", "Export to Excel in one tap", "Create clean reports for bookkeeping, claims, petty cash and reimbursement.", "excel"),
    ]
    for filename, headline, subhead, variant in assets:
        make_portrait(OUT / "phone" / filename, headline, subhead, variant, (1080, 1920))
        make_portrait(OUT / "tablet-7-inch" / filename, headline, subhead, variant, (1440, 2560))
        make_portrait(OUT / "tablet-10-inch" / filename, headline, subhead, variant, (1440, 2560))
        make_landscape(OUT / "chromebook" / filename, headline, subhead, variant)
    print(OUT)


if __name__ == "__main__":
    main()
