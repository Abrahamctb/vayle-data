"""One-stock gap card from vayle-data history.json.
usage: python3 make_stock_card.py history.json TICKER [hours=72] [out=TICKER-card.png]"""
import sys, json, datetime as dt
from PIL import Image, ImageDraw, ImageFont

FD = "/usr/share/fonts/opentype/inter/"
F = {"xb": FD + "InterDisplay-ExtraBold.otf", "b": FD + "Inter-Bold.otf", "s": FD + "Inter-SemiBold.otf",
     "r": FD + "Inter-Regular.otf", "m": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"}
BG, PANEL, LINE = (10, 13, 20), (16, 21, 31), (46, 56, 76)
INK, MUTE, AMBER = (240, 243, 248), (140, 150, 168), (255, 181, 71)
S, W, H = 2, 1600, 900


def font(k, px):
    return ImageFont.truetype(F[k], int(px * S))


def build(hist_path, sym, hours=72, out=None):
    h = json.load(open(hist_path))
    t_end = h[-1]["t"]
    pts = [(r["t"], r["s"][sym][0]) for r in h if r["t"] >= t_end - hours * 3600 and sym in r["s"]]
    if len(pts) < 2:
        raise SystemExit("not enough readings for " + sym)
    out = out or sym + "-card.png"
    im = Image.new("RGB", (W * S, H * S), BG)
    d = ImageDraw.Draw(im)
    X = lambda v: int(v * S)

    def text(s, x, y, k, px, col=INK, anchor="la"):
        d.text((X(x), X(y)), s, font=font(k, px), fill=col, anchor=anchor)

    peak_t, peak = max(pts, key=lambda p: abs(p[1]))
    last = pts[-1][1]
    a = dt.datetime.fromtimestamp(pts[0][0], dt.timezone.utc)
    b = dt.datetime.fromtimestamp(t_end, dt.timezone.utc)
    text(sym, 80, 50, "xb", 92)
    text("Pool price vs Chainlink, in bps", 80, 160, "r", 30, MUTE)
    text("%s to %s UTC" % (a.strftime("%d %b %H:%M"), b.strftime("%d %b %H:%M")), 1520, 78, "m", 20, MUTE, "ra")
    text("peak", 1000, 118, "r", 22, MUTE)
    text("%+.0f bps" % peak, 1000, 146, "xb", 54, AMBER if abs(peak) >= 100 else INK)
    text("now", 1290, 118, "r", 22, MUTE)
    text(("%+.0f bps" % last) if round(last) else "0 bps", 1290, 146, "xb", 54, AMBER if abs(last) >= 100 else INK)

    x0, x1, y0, y1 = 110, 1520, 245, 800
    d.rounded_rectangle((X(70), X(y0 - 25), X(1530), X(y1 + 30)), radius=X(16), fill=PANEL)
    gmax = max(120.0, max(g for _, g in pts) * 1.12)
    gmin = min(-120.0, min(g for _, g in pts) * 1.12)
    yy = lambda g: y1 - (g - gmin) / (gmax - gmin) * (y1 - y0)
    d.rectangle((X(x0), X(yy(100)), X(x1), X(yy(-100))), fill=(24, 33, 50))
    for g in (100, 0, -100):
        d.line((X(x0), X(yy(g)), X(x1), X(yy(g))), fill=LINE, width=X(1.5))
        text("%+d" % g if g else "0", x0 - 14, yy(g), "m", 20, MUTE, "rm")
    t0, t1 = pts[0][0], pts[-1][0]
    px = lambda t: x0 + (t - t0) / max(t1 - t0, 1) * (x1 - x0)
    xy = [(X(px(t)), X(yy(g))) for t, g in pts]
    d.line(xy, fill=AMBER, width=X(4), joint="curve")
    ex, ey = xy[-1]
    d.ellipse((ex - X(8), ey - X(8), ex + X(8), ey + X(8)), fill=AMBER)
    pxp, pyp = X(px(peak_t)), X(yy(peak))
    d.ellipse((pxp - X(7), pyp - X(7), pxp + X(7), pyp + X(7)), outline=INK, width=X(3))
    # day ticks
    day = dt.datetime.fromtimestamp(t0, dt.timezone.utc).replace(hour=0, minute=0, second=0)
    while day.timestamp() <= t1:
        if day.timestamp() >= t0:
            xx = px(day.timestamp())
            text(day.strftime("%d %b"), xx, y1 + 4, "m", 18, MUTE, "ma")
        day += dt.timedelta(days=1)
    text("Shaded band = within 100 bps. Hourly snapshots. Gap = pool price vs Chainlink price.", 80, 856, "r", 20, MUTE)
    text("usevayle.com", 1520, 856, "s", 22, INK, "ra")
    im.resize((W, H), Image.LANCZOS).save(out)
    return out, round(peak, 1), round(last, 1)


if __name__ == "__main__":
    hp, sym = sys.argv[1], sys.argv[2].upper()
    hours = float(sys.argv[3]) if len(sys.argv) > 3 else 72
    print(build(hp, sym, hours, sys.argv[4] if len(sys.argv) > 4 else None))
