"""web/ の部品とデータを結合して 1 ファイルの HTML を生成する。

  python pipeline/build_web.py            # dist/io-flow.html（ライブラリ同梱・オフライン動作）
  python pipeline/build_web.py --cdn      # dist/io-flow.cdn.html（ライブラリは CDN から読み込み）

--inline 版は node_modules/ または vendor/ の d3 を同梱する。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DIST = ROOT / "dist"

CDN = [
    "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js",
    "https://cdn.jsdelivr.net/npm/d3-sankey@0.12.3/dist/d3-sankey.min.js",
]
VENDOR = [ROOT / "vendor" / "d3.min.js", ROOT / "vendor" / "d3-sankey.min.js"]

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700'
         '&family=IBM+Plex+Mono:wght@400;500&family=Zen+Kaku+Gothic+New:wght@500;700&display=swap">')


def build(cdn: bool, skeleton: bool) -> str:
    data = (ROOT / "data" / "processed" / "io.json").read_text(encoding="utf-8").replace("</", "<\\/")
    css = (WEB / "style.css").read_text(encoding="utf-8")
    body = (WEB / "body.html").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")
    if cdn:
        libs = "\n".join(f'<script src="{u}"></script>' for u in CDN)
    else:
        libs = "\n".join(f"<script>{p.read_text(encoding='utf-8')}</script>" for p in VENDOR)
    head = (
        "<title>産業連関フロー</title>\n"
        '<meta name="claude:viewport-fit-sides" content="cover">\n'
        f"{FONTS}\n<style>\n{css}</style>\n"
    )
    page = (
        f"{head}{body}\n"
        f'<script id="io-data" type="application/json">{data}</script>\n'
        f"{libs}\n<script>\n{js}</script>\n"
    )
    if skeleton:
        page = ('<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                f"{head}</head>\n<body>\n{body}\n"
                f'<script id="io-data" type="application/json">{data}</script>\n'
                f"{libs}\n<script>\n{js}</script>\n</body>\n</html>\n")
    return page


def main() -> None:
    DIST.mkdir(exist_ok=True)
    if "--cdn" in sys.argv:
        out = DIST / "io-flow.cdn.html"
        out.write_text(build(cdn=True, skeleton="--fragment" not in sys.argv), encoding="utf-8")
    else:
        out = DIST / "io-flow.html"
        out.write_text(build(cdn=False, skeleton=True), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
