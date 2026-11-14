"""data/sources.json に列挙した e-Stat の Excel ファイルをダウンロードする。

  python pipeline/fetch.py            # 未取得のファイルだけ取得
  python pipeline/fetch.py --force    # すべて取得し直す（e-Stat の正誤情報が出たときなど）
  python pipeline/fetch.py --check    # 取得し直して、内容が変わったファイルを報告するだけ（CI 用）

取得したファイルの SHA-256 と取得日時は data/raw/manifest.lock.json に記録する。
--check は内容が変わっていれば終了コード 2 を返す。
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "data" / "sources.json"
RAW = ROOT / "data" / "raw"
LOCK = RAW / "manifest.lock.json"


def download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "io-flow/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if not data.startswith(b"PK"):
                raise RuntimeError("xlsx ではない応答を受信しました")
            return data
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError


def main() -> None:
    force = "--force" in sys.argv
    check = "--check" in sys.argv
    src = json.loads(SOURCES.read_text(encoding="utf-8"))
    RAW.mkdir(parents=True, exist_ok=True)
    lock = json.loads(LOCK.read_text(encoding="utf-8")) if LOCK.exists() else {}
    changed = []
    for f in src["files"]:
        dest = RAW / f["file"]
        if dest.exists() and not (force or check):
            print(f"skip  {f['file']}")
            continue
        data = download(src["download_url"].format(statInfId=f["statInfId"]))
        sha = hashlib.sha256(data).hexdigest()
        old = lock.get(f["file"], {}).get("sha256")
        status = "new" if old is None else ("changed" if old != sha else "same")
        print(f"{status:7} {f['file']} (statInfId={f['statInfId']})")
        if status != "same":
            changed.append(f["file"])
        if not check:
            dest.write_bytes(data)
        if not check and status != "same":   # 内容が同じなら記録（取得日時）を変えない
            lock[f["file"]] = {
                "statInfId": f["statInfId"],
                "sha256": sha,
                "bytes": len(data),
                "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            }
        time.sleep(1)
    if not check:
        LOCK.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if check and changed:
        print("更新されたファイル:", ", ".join(changed))
        sys.exit(2)


if __name__ == "__main__":
    main()
