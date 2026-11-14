"""取引基本表 Excel を解析・検証し、可視化用 JSON を生成する。

入力: data/sources.json と data/raw/*.xlsx
出力: data/processed/io.json
  {
    "meta": {...},
    "sources": [...],                      # 出典（ページのフッターに表示）
    "levels": {
      "37": {
        "sectors": [{"code","name"}...],   # 内生部門（名称は最新年のもの）
        "years": {
          "2015": {
            "Z": [[...]],                  # 中間取引 n×n（行=販売元, 列=購入先）
            "va": [{"code","name","values"}],
            "fd": [{"code","name","values"}],
            "imports": [n],                # (控除)輸入計（負値）
            "X": [n],                      # 国内生産額
            "basis": "接続表(2015年基準)"
          }, ...
        }
      }
    }
  }
値の単位はすべて 10億円。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import openpyxl

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SOURCES = ROOT / "data" / "sources.json"
OUT = ROOT / "data" / "processed" / "io.json"

TOTAL_NAMES = {"内生部門計", "粗付加価値部門計", "国内生産額", "国内最終需要計", "国内需要合計",
               "輸出計", "最終需要計", "需要合計", "（控除）輸入計", "最終需要部門計"}
IMPORT_NAMES = {"（控除）輸入", "（控除）関税", "（控除）輸入品商品税"}
SHORT = {
    "家計外消費支出（行）": "家計外消費支出",
    "家計外消費支出（列）": "家計外消費支出",
    "間接税（関税・輸入品商品税を除く。）": "間接税",
    "（控除）経常補助金": "経常補助金(控除)",
    "国内総固定資本形成": "総固定資本形成",
    "国内総固定資本形成（公的）": "総固定資本形成(公的)",
    "国内総固定資本形成（民間）": "総固定資本形成(民間)",
    "一般政府消費支出（社会資本等減耗分）": "政府消費(社会資本減耗)",
    "資本減耗引当（社会資本等減耗分）": "資本減耗(社会資本)",
    "ダブルインフレーション調整項": "ダブルインフレ調整",
}


def num(v) -> float:
    return float(v) if isinstance(v, (int, float)) else 0.0


def parse_table(path: Path, sheet, scale: float) -> dict:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[sheet] if isinstance(sheet, int) else wb[sheet]
    rows = list(ws.iter_rows(values_only=True))
    col_codes, col_names = rows[1], rows[2]
    body = [r for r in rows[3:] if r[0] is not None and r[1] is not None]
    v = lambda x: num(x) * scale

    row_names = [r[1] for r in body]
    n = row_names.index("内生部門計")
    sectors = [{"code": str(r[0]), "name": r[1]} for r in body[:n]]
    fc = 2
    assert [str(col_codes[fc + i]) for i in range(n)] == [s["code"] for s in sectors], f"{path.name}:{sheet} 行と列の部門コード不一致"

    cols = {nm: j for j, (c, nm) in enumerate(zip(col_codes, col_names)) if c is not None and nm is not None}
    Z = [[v(body[i][fc + j]) for j in range(n)] for i in range(n)]
    col_vec = lambda j: [v(body[i][j]) for i in range(n)]

    fd, imports = [], None
    for j in range(cols["内生部門計"] + 1, len(col_names)):
        nm = col_names[j]
        if nm is None or col_codes[j] is None:
            continue
        if nm == "（控除）輸入計":
            imports = col_vec(j)
        if nm in TOTAL_NAMES or nm in IMPORT_NAMES:
            continue
        if nm.startswith("輸出"):
            nm = "輸出"
        fd.append({"code": str(col_codes[j]), "name": SHORT.get(nm, nm), "values": col_vec(j)})
    if not any(f["name"] == "輸出" for f in fd):
        fd.append({"code": "81", "name": "輸出", "values": col_vec(cols["輸出計"])})
    X = col_vec(cols["国内生産額"])

    va = []
    for r in body[n + 1:]:
        if r[1] in TOTAL_NAMES:
            continue
        vals = [v(r[fc + j]) for j in range(n)]
        if all(abs(x) < 1e-9 for x in vals):   # 名目表のダブルインフレ調整項（すべて0）など
            continue
        va.append({"code": str(r[0]), "name": SHORT.get(r[1], r[1]), "values": vals})
    x_row = next(r for r in body if r[1] == "国内生産額")
    X_col = [v(x_row[fc + j]) for j in range(n)]

    # 整合性チェック（行バランス・列バランス）
    Zm, Xa = np.array(Z), np.array(X)
    tol = 0.5 + 1e-3 * np.abs(Xa)
    row_sum = Zm.sum(1) + np.sum([f["values"] for f in fd], 0) + np.array(imports)
    col_sum = Zm.sum(0) + np.sum([x["values"] for x in va], 0)
    assert np.all(np.abs(row_sum - Xa) < tol), f"{path.name}:{sheet} 行バランス不一致 {np.max(np.abs(row_sum - Xa))}"
    assert np.all(np.abs(col_sum - np.array(X_col)) < tol), f"{path.name}:{sheet} 列バランス不一致"
    assert np.all(np.abs(Xa - np.array(X_col)) < tol), f"{path.name}:{sheet} 行/列の国内生産額不一致"
    return {"sectors": sectors, "Z": Z, "va": va, "fd": fd, "imports": imports, "X": X}


def leontief_inverse(t: dict) -> np.ndarray:
    """競争輸入型 [I-(I-M^)A]^-1（ビューアの JS 実装と同じ式）。"""
    Z, X = np.array(t["Z"]), np.array(t["X"])
    A = Z / np.where(X == 0, 1, X)[None, :]
    dd = Z.sum(1) + sum(np.array(f["values"]) for f in t["fd"] if f["name"] != "輸出")
    m = np.where(dd != 0, -np.array(t["imports"]) / dd, 0)
    n = len(X)
    return np.linalg.inv(np.eye(n) - (np.eye(n) - np.diag(m)) @ A)


def official_inverse(path: Path, n: int) -> np.ndarray:
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    return np.array([[num(x) for x in r[2:2 + n]] for r in rows[3:3 + n]])


def rounded(t: dict, basis: str) -> dict:
    r = lambda a: [round(x, 1) for x in a]
    return {
        "Z": [r(row) for row in t["Z"]],
        "va": [{**x, "values": r(x["values"])} for x in t["va"]],
        "fd": [{**f, "values": r(f["values"])} for f in t["fd"]],
        "imports": r(t["imports"]),
        "X": r(t["X"]),
        "basis": basis,
    }


def main() -> None:
    src = json.loads(SOURCES.read_text(encoding="utf-8"))
    parsed: dict[str, dict[str, dict]] = {}
    basis_of: dict[tuple, str] = {}
    for f in src["files"]:
        if f["kind"] != "io":
            continue
        for tb in f["tables"]:
            t = parse_table(RAW / f["file"], tb["sheet"], f["unit_scale"])
            parsed.setdefault(f["level"], {})[tb["year"]] = t
            basis_of[(f["level"], tb["year"])] = f["title"]

    levels = {}
    for level, by_year in parsed.items():
        years = sorted(by_year)
        latest = by_year[years[-1]]
        codes = [s["code"] for s in latest["sectors"]]
        for y in years:
            assert [s["code"] for s in by_year[y]["sectors"]] == codes, f"{level}部門 {y}年: 部門コードが最新年と一致しません"
        for y in years:
            t = by_year[y]
            msg = f"{level:>3}部門 {y}年: 国内生産額計={sum(t['X'])/1000:,.1f}兆円"
            inv = next((f for f in src["files"] if f["kind"] == "inverse" and f["level"] == level and f["year"] == y), None)
            if inv and (RAW / inv["file"]).exists():
                err = float(np.max(np.abs(leontief_inverse(t) - official_inverse(RAW / inv["file"], len(codes)))))
                msg += f", 公式逆行列との最大誤差={err:.1e}"
                assert err < 1e-3, "逆行列が公式表と一致しません"
            print(msg)
        levels[level] = {
            "sectors": latest["sectors"],
            "years": {y: rounded(by_year[y], basis_of[(level, y)]) for y in years},
        }

    out = {
        "meta": {
            "title": "産業連関表 取引基本表（生産者価格評価表・名目）",
            "unit": "10億円",
            "source_page": "https://www.e-stat.go.jp/stat-search/files?toukei=00200603",
        },
        "sources": [{"title": f["title"], "statInfId": f["statInfId"]} for f in src["files"] if f["kind"] == "io"],
        "levels": dict(sorted(levels.items(), key=lambda kv: int(kv[0]))),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
