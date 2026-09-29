"""生データの取得（自分のPCで実行する）。

  python -m fire_data.fetch [SOURCE_ID ...]

url が定義されたソースを data/raw/<raw_file> にダウンロードし、SHA-256 を表示する。
※ このスクリプトは開発環境（外部通信不可のサンドボックス）では未実行・未検証。
   取得できない場合は、各サイトから手動でダウンロードして同じパスに置けばよい。
   ライセンス状態が cleared でないソースも取得自体はできるが、ビルドでは既定で使われない。
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

from .config import RAW_DIR, SOURCES

USER_AGENT = "real-fire-simulator-data-pipeline/0.1 (portfolio project)"


def download(url: str, dest: Path) -> str:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310（固定URLのみ）
        data = resp.read()
    dest.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def main(argv: list[str] | None = None) -> int:
    ids = argv if argv else list(SOURCES)
    rc = 0
    for sid in ids:
        src = SOURCES.get(sid)
        if src is None:
            print(f"未知のソース: {sid}", file=sys.stderr)
            rc = 1
            continue
        if src.url is None:
            print(f"[{sid}] 手動配置: {RAW_DIR / src.raw_file}\n  {src.manual_hint}")
            continue
        try:
            digest = download(src.url, RAW_DIR / src.raw_file)
            print(f"[{sid}] OK sha256={digest[:16]}… → {src.raw_file}")
        except Exception as e:  # noqa: BLE001
            print(f"[{sid}] 取得失敗: {e}\n  手動で {src.url} から取得し {src.raw_file} に置いてください", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
