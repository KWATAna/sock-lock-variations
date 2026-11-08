"""Make hook overlays and regenerate the synthetic example from local shapes."""
import argparse
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DARK = "#142624"
MINT = "#DDEDE3"
GREEN = "#275750"
LIME = "#D9F77A"
CREAM = "#F9F7EF"
FONT_FILES = (
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
)


def font(size):
    for file in FONT_FILES:
        if file.is_file():
            return ImageFont.truetype(str(file), size)
    return ImageFont.load_default(size=size)


def wrap_text(text, selected_font, max_width):
    lines = [""]
    for word in text.split():
        if selected_font.getlength(word) > max_width:
            return None
        combined = f"{lines[-1]} {word}".strip()
        if selected_font.getlength(combined) <= max_width:
            lines[-1] = combined
        else:
            lines.append(word)
    return "\n".join(lines) if len(lines) <= 3 else None


def write_overlay(width, height, path, hook):
    image = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(image)
    ratio = width / 720
    left, right = round(width * 0.075), round(width * 0.925)
    top = round(height * 0.138)
    for base_size in (54, 50, 46, 42, 38):
        selected_font = font(max(1, round(base_size * ratio)))
        lines = wrap_text(hook, selected_font, right - left - round(72 * ratio))
        if lines:
            break
    else:
        raise ValueError("Текст не вміщується у три рядки.")

    spacing = round(10 * ratio)
    _, text_top, _, text_bottom = draw.multiline_textbbox(
        (0, 0), lines, font=selected_font, spacing=spacing, align="center"
    )
    padding = round(23 * ratio)
    bottom = top + (text_bottom - text_top) + padding * 2
    draw.rounded_rectangle((left, top, right, bottom), radius=round(30 * ratio), fill=LIME)
    draw.multiline_text(
        (width // 2, top + padding - text_top),
        lines,
        font=selected_font,
        fill=DARK,
        anchor="ma",
        spacing=spacing,
        align="center",
    )
    image.save(path)


def sock(color, accent, angle):
    icon = Image.new("RGBA", (270, 380))
    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle((112, 15, 243, 290), radius=34, fill=color)
    draw.rounded_rectangle((32, 229, 243, 342), radius=51, fill=color)
    draw.rounded_rectangle((112, 15, 243, 63), radius=18, fill=accent)
    draw.rounded_rectangle((32, 243, 93, 332), radius=29, fill=accent)
    draw.rounded_rectangle((198, 233, 243, 306), radius=20, fill=accent)
    draw.ellipse((160, 115, 197, 152), fill=CREAM)
    draw.ellipse((168, 123, 189, 144), fill=DARK)
    return icon.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)


def demo_card(index):
    backgrounds = (CREAM, MINT, DARK)
    foregrounds = (DARK, DARK, CREAM)
    image = Image.new("RGB", (720, 1280), backgrounds[index])
    draw = ImageDraw.Draw(image)
    fg = foregrounds[index]

    draw.text((54, 68), "SOCKLOCK", font=font(45), fill=fg)
    draw.text((54, 128), "SYNTHETIC DEMO  /  PRODUCT CONCEPT", font=font(21), fill=fg)
    draw.rounded_rectangle((54, 416, 666, 967), radius=58, fill=(MINT, CREAM, GREEN)[index])
    for x, y, radius in ((184, 655, 111), (527, 643, 95), (442, 834, 52)):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=CREAM, width=2)
    icons = (
        (sock(GREEN, DARK, 13), (116, 481)),
        (sock(LIME, "#A9C958", -13), (293, 527)),
    )
    for icon, at in icons:
        image.paste(icon, at, icon)

    if index == 0:
        title, subtitle = "MAGNETIC SOCKS", "A sock subscription concept"
    elif index == 1:
        title, subtitle = "FIVE PAIRS", "Shipped every quarter"
    else:
        title, subtitle = "FIND YOUR FIT", "Take the SockLock quiz"
    draw.text((360, 1045), title, font=font(48), fill=fg, anchor="mm")
    draw.text((360, 1115), subtitle, font=font(29), fill=fg, anchor="mm")
    return image


def write_demo(path):
    with tempfile.TemporaryDirectory() as directory:
        images = [Path(directory, f"scene-{index}.png") for index in range(3)]
        inputs = []
        for index, image in enumerate(images):
            demo_card(index).save(image)
            inputs.extend(("-loop", "1", "-framerate", "24", "-t", "4", "-i", str(image)))
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *inputs,
                "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]",
                "-map", "[out]", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
            ],
            check=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    overlay = commands.add_parser("overlay")
    overlay.add_argument("width", type=int)
    overlay.add_argument("height", type=int)
    overlay.add_argument("path", type=Path)
    overlay.add_argument("hook")
    demo = commands.add_parser("demo")
    demo.add_argument("path", type=Path)
    options = parser.parse_args()
    if options.action == "overlay":
        write_overlay(options.width, options.height, options.path, options.hook)
    else:
        write_demo(options.path)


if __name__ == "__main__":
    main()
