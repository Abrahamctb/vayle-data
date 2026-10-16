"""Gap card: biggest gaps of the last N hours, from vayle-data history.json.
usage: python3 make_card.py history.json [hours=72] [out=gap-card.png] [rows=6]
Gap = (pool USD - Chainlink USD) / Chainlink, in bps. Each point is an hourly snapshot."""
import sys, json, datetime as dt
from PIL import Image, ImageDraw, ImageFont

FD = "/usr/share/fonts/opentype/inter/"
F = {"xb": FD + "InterDisplay-ExtraBold.otf", "b": FD + "Inter-Bold.otf", "s": FD + "Inter-SemiBold.otf",
     "r": FD + "Inter-Regular.otf", "m": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"}
BG, PANEL, LINE = (10, 13, 20), (16, 21, 31), (38, 46, 62)
INK, MUTE, AMBER, BLUE = (240, 243, 248), (140, 150, 168), (255, 181, 71), (120, 170, 255)
S = 2  # supersample
W, H = 1600, 900


def font(k, px):
    return ImageFont.truetype(F[k], int(px * S))


def build(hist_path, hours=72, out="gap-card.png", rows=6):
    h = json.load(open(hist_path))
    t_end = h[-1]["t"]
    win = [r for r in h if r["t"] >= t_end - hours * 3600]
    series = {}
    for r in win:
        for k, v in r["s"].items():
            series.setdefault(k, []).append((r["t"], v[0]))
    rank = sorted(series.items(), key=lambda kv: -max(abs(g) for _, g in kv[1]))[:rows]

    im = Image.new("RGB", (W * S, H * S), BG)
    d = ImageDraw.Draw(im)
    X = lambda v: int(v * S)

    def text(s, x, y, k, px, col=INK, anchor="la"):
        d.text((X(x), X(y)), s, font=font(k, px), fill=col, anchor=anchor)

    a = dt.datetime.fromtimestamp(win[0]["t"], dt.timezone.utc)
    b = dt.datetime.fromtimestamp(t_end, dt.timezone.utc)
    text("Biggest gaps", 80, 60, "xb", 64)
    text("Tokenized stocks on Robinhood Chain vs Chainlink", 80, 138, "r", 28, MUTE)
    text("%s to %s UTC" % (a.strftime("%d %b %H:%M"), b.strftime("%d %b %H:%M")), 1520, 78, "m", 22, MUTE, "ra")

    top, rh = 215, 96
    cx0, cx1 = 330, 1090       # sparkline area
    for i, (sym, pts) in enumerate(rank):
        y0 = top + i * rh
        d.rounded_rectangle((X(70), X(y0), X(1530), X(y0 + rh - 12)), radius=X(14), fill=PANEL)
        peak = max(pts, key=lambda p: abs(p[1]))[1]
        last = pts[-1][1]
        text(sym, 100, y0 + 26, "xb", 36)
        mid = y0 + (rh - 12) / 2
        rng = max(150.0, max(abs(g) for _, g in pts) * 1.15)
        # +-100 bps band and zero line
        yy = lambda g: mid - g / rng * (rh - 12) / 2 * 0.9
        d.rectangle((X(cx0), X(yy(100)), X(cx1), X(yy(-100))), fill=(24, 33, 50))
        d.line((X(cx0), X(mid), X(cx1), X(mid)), fill=LINE, width=X(1.5))
        t0, t1 = pts[0][0], pts[-1][0]
        xy = [(X(cx0 + (t - t0) / max(t1 - t0, 1) * (cx1 - cx0)), X(yy(g))) for t, g in pts]
        d.line(xy, fill=AMBER, width=X(3.2), joint="curve")
        d.ellipse((xy[-1][0] - X(6), xy[-1][1] - X(6), xy[-1][0] + X(6), xy[-1][1] + X(6)), fill=AMBER)
        text("peak", 1150, y0 + 14, "r", 18, MUTE)
        text("%+.0f bps" % peak, 1150, y0 + 38, "b", 28, AMBER if abs(peak) >= 100 else INK)
        text("now", 1330, y0 + 14, "r", 18, MUTE)
        text(("%+.0f bps" % last) if round(last) else "0 bps", 1330, y0 + 38, "b", 28, AMBER if abs(last) >= 100 else INK)
    text("Shaded band = within 100 bps. Each row has its own scale. Gap = pool price vs Chainlink price. Hourly snapshots.", 80, 846, "r", 20, MUTE)
    text("usevayle.com", 1520, 846, "s", 22, INK, "ra")
    im = im.resize((W, H), Image.LANCZOS)
    im.save(out)
    return out, [(s, round(max(abs(g) for _, g in p), 1)) for s, p in rank]


if __name__ == "__main__":
    hp = sys.argv[1]
    hours = float(sys.argv[2]) if len(sys.argv) > 2 else 72
    out = sys.argv[3] if len(sys.argv) > 3 else "gap-card.png"
    rows = int(sys.argv[4]) if len(sys.argv) > 4 else 6
    print(build(hp, hours, out, rows))
