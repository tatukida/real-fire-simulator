"""データソースの定義・ライセンス状態・出所表記。

license_status の意味:
  cleared       再配布（加工済み年次データの配信）が可能と判断済み。出所表記は必須。
  needs-review  人間の最終確認が必要。既定ではビルド対象外（--allow-review で開発時のみ含める）。
  blocked       再配布不可。使用しない。

状態を変更できるのは人間のみ。変更時は docs/adr/0002-data-sources.md に根拠を残すこと。
出所表記（attribution_*）と加工表記は、アプリ画面に必ず表示する（validate --strict が検査する）。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RAW_DIR = ROOT / "data" / "raw"
PROCESSED_DIR = ROOT / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "returns.json"

SCHEMA_VERSION = 1
MIN_COUNTRIES_DM = 10  # 先進国合成に必要な、その年に有効な国数の下限
MAX_OUTPUT_BYTES = 200_000  # spec.md 5章: data/processed の配信JSON合計 <= 200KB


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    raw_file: str  # RAW_DIR からの相対パス
    url: str | None  # None は手動配置（fetch 対象外）
    license_status: str
    license_note: str
    citation: str
    attribution_ja: str  # 画面に表示する出所（日本語）
    attribution_en: str  # 画面に表示する出所（英語）
    processing_ja: str = ""  # 追加で必須の加工表記（あれば）
    manual_hint: str = ""  # 手動配置の手順


SOURCES: dict[str, Source] = {
    "DAMODARAN": Source(
        id="DAMODARAN",
        label=(
            "Aswath Damodaran (NYU Stern), Historical Returns on Stocks, Bonds and Bills "
            "(histretSP.xls): S&P500（配当込み）・金・インフレ率（年次, 1928年〜）"
        ),
        raw_file="damodaran/histretSP.xls",
        url="https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls",
        license_status="cleared",
        license_note=(
            "人間の判断（2026-09-29）: Damodaran のデータはすべて本人が独自に加工したものであり、"
            "使用に問題なし。参考: 同サイトの Usage rules に 'this data is here for you to use'、"
            "謝辞は任意とある。"
        ),
        citation=(
            "Aswath Damodaran, Stern School of Business, New York University, "
            "Historical Returns on Stocks, Bonds and Bills."
        ),
        attribution_ja=(
            "米国株式（S&P 500・配当込み）・金価格：アスワス・ダモダラン教授"
            "（ニューヨーク大学スターン経営大学院）公開データ"
        ),
        attribution_en=(
            "Data Source: Aswath Damodaran, Stern School of Business, New York University "
            "(Historical Returns on Stocks, Bonds and Bills)"
        ),
    ),
    "JST": Source(
        id="JST",
        label=(
            "Jordà-Schularick-Taylor Macrohistory Database (Release 6): "
            "株式総合リターン eq_tr・対米ドル為替 xrusd（先進18か国, 年次, 1870年〜2020年）"
        ),
        raw_file="jst/JSTdatasetR6.xlsx",
        url="https://www.macrohistory.net/app/download/9834512569/JSTdatasetR6.xlsx",
        license_status="cleared",
        license_note=(
            "人間の判断（2026-09-29）: 本アプリは非営利の無料Webアプリとして公開し、"
            "加工後データを CC BY-NC-SA 4.0 で公開することに問題なし。"
            "ライセンス: CC BY-NC-SA 4.0（表示・非営利・継承）。"
        ),
        citation=(
            "Òscar Jordà, Moritz Schularick, and Alan M. Taylor. The Rate of Return on Everything, "
            "1870-2015. Quarterly Journal of Economics 134(3), 2019; "
            "Macrohistory Database, https://www.macrohistory.net/database/ (Release 6)."
        ),
        attribution_ja=(
            "先進国株式：Jordà-Schularick-Taylor Macrohistory Database（Release 6）"
            "（Jordà, Schularick and Taylor, 2019, Quarterly Journal of Economics）。"
            "ライセンス CC BY-NC-SA 4.0"
        ),
        attribution_en=(
            "Data Source: Jordà, Schularick and Taylor, Macrohistory Database (Release 6), "
            "https://www.macrohistory.net/database/ (CC BY-NC-SA 4.0)"
        ),
        processing_ja=(
            "先進国株式は、上記データベースの先進18か国の株式総合リターン（現地通貨建て）を、"
            "為替で米ドル建てに換算したうえで、開発者が各年の等ウェイト平均として合成したものです"
            "（時価総額加重の指数ではありません）。"
            "この加工後データは非営利目的に限り、CC BY-NC-SA 4.0 の条件で利用できます。"
        ),
    ),
    "FRED_DEXJPUS": Source(
        id="FRED_DEXJPUS",
        label="FRED DEXJPUS: 日本円/米ドル為替レート（日次, 1971年〜, 連邦準備制度理事会 H.10）",
        raw_file="fred/DEXJPUS.csv",
        url="https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXJPUS",
        license_status="cleared",
        license_note="FRED 系列ページに 'Public Domain: Citation Requested' の表示を確認。出所明記で再配布可。",
        citation=(
            "Board of Governors of the Federal Reserve System (US), Japanese Yen to U.S. Dollar "
            "Spot Exchange Rate [DEXJPUS], retrieved from FRED, Federal Reserve Bank of St. Louis."
        ),
        attribution_ja="為替（円/ドル）：連邦準備制度理事会（FRB）H.10 / FRED（セントルイス連邦準備銀行）",
        attribution_en=(
            "Data Source: Board of Governors of the Federal Reserve System (US), "
            "retrieved from FRED, Federal Reserve Bank of St. Louis"
        ),
    ),
    "FRED_CPIAUCNS": Source(
        id="FRED_CPIAUCNS",
        label="FRED CPIAUCNS: 米国消費者物価指数（都市部消費者・総合, 季節調整なし, 月次, 1913年〜, 米国労働統計局）",
        raw_file="fred/CPIAUCNS.csv",
        url="https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCNS",
        license_status="cleared",
        license_note="FRED 系列ページで 'public domain with citation requested'（出所: BLS）を確認（2026-09-29）。",
        citation=(
            "U.S. Bureau of Labor Statistics, Consumer Price Index for All Urban Consumers: All Items "
            "in U.S. City Average [CPIAUCNS], retrieved from FRED, Federal Reserve Bank of St. Louis."
        ),
        attribution_ja="米国CPI：米国労働統計局（BLS）／FRED（セントルイス連邦準備銀行）",
        attribution_en=(
            "Data Source: U.S. Bureau of Labor Statistics, Consumer Price Index for All Urban "
            "Consumers: All Items in U.S. City Average [CPIAUCNS], retrieved from FRED, "
            "Federal Reserve Bank of St. Louis"
        ),
    ),
    "JP_CPI": Source(
        id="JP_CPI",
        label="日本の消費者物価指数（総合, 月次）: 総務省統計局",
        raw_file="manual/jp_cpi.csv",
        url=None,
        license_status="cleared",
        license_note=(
            "人間の判断（2026-09-29）: 出所を明記し、加工したのは開発者である旨を記載すれば利用可"
            "（国が加工後のデータを作成・公表したように見せてはならないルールのため）。"
        ),
        citation="総務省統計局「消費者物価指数（CPI）」",
        attribution_ja="日本CPI（インフレ率）：総務省統計局ホームページ「消費者物価指数（CPI）」をもとに作成",
        attribution_en="Data Source: Statistics Bureau of Japan, Consumer Price Index (processed by the developer)",
        processing_ja=(
            "本アプリのインフレ調整シミュレーションは、総務省統計局の「消費者物価指数（CPI）」の"
            "データを基に、開発者が独自に計算・加工して構築したものです。"
        ),
        manual_hint=(
            "e-Stat（消費者物価指数）の「品目別価格指数（全国・月次）」CSV をダウンロードし、"
            "python -m fire_data.convert_jp_cpi <そのCSV> で data/raw/manual/jp_cpi.csv を作る（data/README.md 参照）。"
        ),
    ),
}

# 出力アセットID → (表示名, 元ソースID)
ASSETS: dict[str, tuple[str, str]] = {
    "SP500": ("S&P500（配当込み）", "DAMODARAN"),
    "WORLD_DM": ("先進国株式（先進18か国の等ウェイト合成・USD建て）", "JST"),
    "GOLD": ("ゴールド（USD建て）", "DAMODARAN"),
}

# アセットごとの使用開始年の下限（それ以前は使わない）と理由
ASSET_START_FLOOR: dict[str, tuple[int, str]] = {
    "WORLD_DM": (
        1950,
        "第二次世界大戦直後の混乱・ハイパーインフレ期の系列を避けるため、1950年以降のみを使用",
    ),
    "GOLD": (
        1972,
        "1971年8月の金兌換停止までは金価格が公定価格で、市場価格の変動を反映しないため、"
        "1972年以降の暦年リターンのみを使用",
    ),
}

# 画面に表示する出所・加工表記（使用したソースのぶんだけ組み立てる）
NOTICE_HEADER_JA = (
    "【使用データおよび出所について】本アプリのシミュレーションには、"
    "以下のオープンデータおよび学術公開データを使用しています。"
)
NOTICE_FOOTER_JA = (
    "※本アプリに搭載されている各種計算結果は、上記出所のデータを基に開発者が独自に"
    "統計・シミュレーション加工を行ったものであり、各提供元が作成・公表したものではありません。"
)
