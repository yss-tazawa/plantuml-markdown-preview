#!/usr/bin/env python3
"""Generate extension icon with darker, more visible colors."""

from PIL import Image, ImageDraw

def rounded_rect(draw, xy, radius, fill=None, outline=None, width=1):
    """Draw a rounded rectangle."""
    x0, y0, x1, y1 = xy
    r = radius
    draw.pieslice([x0, y0, x0 + 2*r, y0 + 2*r], 180, 270, fill=fill, outline=outline, width=width)
    draw.pieslice([x1 - 2*r, y0, x1, y0 + 2*r], 270, 360, fill=fill, outline=outline, width=width)
    draw.pieslice([x0, y1 - 2*r, x0 + 2*r, y1], 90, 180, fill=fill, outline=outline, width=width)
    draw.pieslice([x1 - 2*r, y1 - 2*r, x1, y1], 0, 90, fill=fill, outline=outline, width=width)
    draw.rectangle([x0 + r, y0, x1 - r, y1], fill=fill)
    draw.rectangle([x0, y0 + r, x0 + r, y1 - r], fill=fill)
    draw.rectangle([x1 - r, y0 + r, x1, y1 - r], fill=fill)
    if outline:
        draw.line([x0 + r, y0, x1 - r, y0], fill=outline, width=width)
        draw.line([x0 + r, y1, x1 - r, y1], fill=outline, width=width)
        draw.line([x0, y0 + r, x0, y1 - r], fill=outline, width=width)
        draw.line([x1, y0 + r, x1, y1 - r], fill=outline, width=width)


def draw_icon(size):
    """Generate icon at given size."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    s = size / 512

    # No background (transparent)

    # --- Document (left side, drawn first so diagram overlaps it) ---
    doc_x = int(40 * s)
    doc_y = int(70 * s)
    doc_w = int(240 * s)
    doc_h = int(360 * s)
    fold = int(42 * s)

    doc_fill = (250, 235, 200)        # warm cream/amber
    doc_outline = (185, 155, 100)     # warm brown border
    border_w = max(int(5 * s), 2)

    doc_points = [
        (doc_x, doc_y),
        (doc_x + doc_w - fold, doc_y),
        (doc_x + doc_w, doc_y + fold),
        (doc_x + doc_w, doc_y + doc_h),
        (doc_x, doc_y + doc_h),
    ]
    draw.polygon(doc_points, fill=doc_fill, outline=doc_outline, width=border_w)

    fold_points = [
        (doc_x + doc_w - fold, doc_y),
        (doc_x + doc_w - fold, doc_y + fold),
        (doc_x + doc_w, doc_y + fold),
    ]
    draw.polygon(fold_points, fill=(225, 205, 165), outline=doc_outline, width=border_w)

    # Text lines on document
    line_y_start = doc_y + int(60 * s)
    line_h = max(int(14 * s), 2)
    line_gap = int(32 * s)
    line_x = doc_x + int(22 * s)

    draw.rectangle([line_x, line_y_start, line_x + int(130 * s), line_y_start + line_h],
                   fill=(80, 65, 40))
    draw.rectangle([line_x, line_y_start + line_gap, line_x + int(100 * s), line_y_start + line_gap + line_h],
                   fill=(170, 150, 115))
    draw.rectangle([line_x, line_y_start + 2 * line_gap, line_x + int(120 * s), line_y_start + 2 * line_gap + line_h],
                   fill=(170, 150, 115))
    draw.rectangle([line_x, line_y_start + 3 * line_gap, line_x + int(85 * s), line_y_start + 3 * line_gap + line_h],
                   fill=(80, 65, 40))
    draw.rectangle([line_x, line_y_start + 4 * line_gap, line_x + int(110 * s), line_y_start + 4 * line_gap + line_h],
                   fill=(170, 150, 115))
    draw.rectangle([line_x, line_y_start + 5 * line_gap, line_x + int(95 * s), line_y_start + 5 * line_gap + line_h],
                   fill=(170, 150, 115))

    # --- Arrow (center) ---
    arrow_cx = int(265 * s)
    arrow_cy = int(250 * s)
    arrow_size = int(26 * s)
    arrow_color = (225, 110, 20)
    arrow_points = [
        (arrow_cx - int(8 * s), arrow_cy - arrow_size),
        (arrow_cx + arrow_size, arrow_cy),
        (arrow_cx - int(8 * s), arrow_cy + arrow_size),
    ]
    draw.polygon(arrow_points, fill=arrow_color)

    # --- Diagram boxes (right side, overlapping document) ---
    box_w = int(210 * s)
    box_h = int(145 * s)
    box_x = int(260 * s)   # shifted left to overlap document
    box1_y = int(55 * s)
    box2_y = int(310 * s)
    box_radius = int(12 * s)
    box_border = max(int(6 * s), 2)

    box_border_color = (35, 85, 175)
    box_fill = (205, 222, 248)
    header_fill = (35, 85, 175)
    content_bar = (140, 160, 195)

    # Bottom box: wider, shifted left
    box2_x = int(180 * s)
    box2_w = int(260 * s)

    for i, box_y in enumerate([box1_y, box2_y]):
        bx = box_x if i == 0 else box2_x
        bw = box_w if i == 0 else box2_w

        rounded_rect(draw,
                     [bx, box_y, bx + bw, box_y + box_h],
                     box_radius, fill=box_fill, outline=box_border_color, width=box_border)

        header_h = int(35 * s)
        header_margin = int(12 * s)
        draw.rectangle([bx + header_margin, box_y + int(10 * s),
                        bx + bw - header_margin, box_y + int(10 * s) + header_h],
                       fill=header_fill)

        sep_y = box_y + int(50 * s)
        draw.line([bx + int(8 * s), sep_y, bx + bw - int(8 * s), sep_y],
                  fill=box_border_color, width=max(int(2 * s), 1))

        bar_h = max(int(12 * s), 2)
        bar_y1 = box_y + int(65 * s)
        bar_y2 = box_y + int(90 * s)
        bar_y3 = box_y + int(115 * s)
        draw.rectangle([bx + header_margin, bar_y1,
                        bx + int(140 * s), bar_y1 + bar_h], fill=content_bar)
        draw.rectangle([bx + header_margin, bar_y2,
                        bx + int(120 * s), bar_y2 + bar_h], fill=content_bar)
        draw.rectangle([bx + header_margin, bar_y3,
                        bx + int(100 * s), bar_y3 + bar_h], fill=content_bar)

    # --- Connection arrow between boxes (diagonal) ---
    conn_x1 = box_x + box_w // 2          # top box center
    conn_y1 = box1_y + box_h + int(4 * s)
    conn_x2 = box2_x + box2_w // 2        # bottom box center
    conn_y2 = box2_y - int(4 * s)
    arrow_w = max(int(5 * s), 2)
    conn_color = (35, 85, 175)  # same blue as box borders, visible on dark bg

    draw.line([conn_x1, conn_y1, conn_x2, conn_y2], fill=conn_color, width=arrow_w)
    # Arrowhead pointing along the diagonal
    import math
    angle = math.atan2(conn_y2 - conn_y1, conn_x2 - conn_x1)
    ah_size = int(34 * s)
    spread = 0.65  # half-angle of arrowhead (wider)
    draw.polygon([
        (conn_x2, conn_y2),
        (int(conn_x2 - ah_size * math.cos(angle - spread)),
         int(conn_y2 - ah_size * math.sin(angle - spread))),
        (int(conn_x2 - ah_size * math.cos(angle + spread)),
         int(conn_y2 - ah_size * math.sin(angle + spread))),
    ], fill=conn_color)

    return img


if __name__ == '__main__':
    import os
    base_dir = os.path.dirname(os.path.abspath(__file__))

    icon_128 = draw_icon(128)
    icon_128.save(os.path.join(base_dir, 'icon.png'))
    print('Generated icon.png (128x128)')

    icon_512 = draw_icon(512)
    icon_512.save(os.path.join(base_dir, 'icon_512.png'))
    print('Generated icon_512.png (512x512)')
