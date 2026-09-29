"""パイプラインのテスト。市場データではなく、答えが手計算できる合成データを使う。

（本物のデータでの妥当性は、validate.py のサニティ警告とインフレ突き合わせ、
  およびフェーズ2の既知結果テストで見る。）
"""

from __future__ import annotations

import json
import math
import tempfile
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from fire_data import build, config, convert_jp_cpi, parse, transform, validate

# ---------- 合成データのヘルパ ----------


def monthly_growth(y: int) -> float:
    """年ごとに違う月次インフレ（年オフセットのずれを検出できるようにする）。"""
    return 0.001 + 0.0005 * (y % 5)


def annual_infl(y: int) -> float:
    return (1 + monthly_growth(y)) ** 12 - 1


def cpi_text(first_year: int, last_year: int) -> str:
    """FRED 月次CPI形式（月初日付）。12月/前年12月 = (1+g_y)^12 になるように作る。"""
    lines, level = ["observation_date,CPIAUCNS"], 10.0
    for y in range(first_year, last_year + 1):
        for m in range(1, 13):
            level *= 1 + monthly_growth(y)
            lines.append(f"{y}-{m:02d}-01,{level:.8f}")
    return "\n".join(lines)


def damodaran_raw(years, sp, gold, infl, scale: float = 1.0, with_inflation_col: bool = True) -> pd.DataFrame:
    """histretSP.xls に似た header=None の生 DataFrame（タイトル行・複数行見出し・要約行つき）。"""
    header = ["Year", "S&P 500 \n(includes dividends)", "US Small cap", "3-month T.Bill", "US T. Bond",
              "Baa Corporate Bond", "Real Estate", "Gold*"]
    if with_inflation_col:
        header.append("Inflation Rate")
    width = len(header)
    rows = [["Annual Returns on Investments in", *[None] * (width - 1)],
            [None] * width,
            header]
    for y, s, g, i in zip(years, sp, gold, infl):
        row = [float(y), s * scale, 0.1, 0.03, 0.05, 0.06, 0.04, g * scale]
        if with_inflation_col:
            row.append(i * scale)
        rows.append(row)
    tail = [0.03] if with_inflation_col else []
    rows.append(["Arithmetic Average 1928-2025", 0.1, 0.1, 0.03, 0.05, 0.06, 0.04, 0.05, *tail])
    rows.append(["Geometric Average 1928-2025", 0.09, 0.1, 0.03, 0.05, 0.06, 0.04, 0.04, *tail])
    return pd.DataFrame(rows)


# ---------- パーサ: FRED / 手動CSV ----------


def test_fred_parse_handles_missing_dot():
    s = parse.parse_fred_text("observation_date,DEXJPUS\n1971-12-30,350.0\n1971-12-31,.\n")
    assert s.iloc[0] == 350.0 and math.isnan(s.iloc[1])


def test_fred_monthly_dates_become_month_end_and_cpi_dec_over_dec():
    text = "observation_date,CPIAUCNS\n" + "\n".join(
        f"{y}-{m:02d}-01,{100.0 if y == 2019 else 103.0}" for y in (2019, 2020) for m in range(1, 13))
    s = parse.parse_fred_text(text, monthly=True)
    assert s.index[0] == pd.Timestamp("2019-01-31") and s.index[-1] == pd.Timestamp("2020-12-31")
    ch = transform.annual_change(transform.year_end_levels(s))
    assert list(ch.index) == [2020] and abs(ch[2020] - 0.03) < 1e-12
    # monthly=False のままだと月初日付のため「年末まで揃った年」と判定されない（回帰防止）
    assert len(transform.year_end_levels(parse.parse_fred_text(text, monthly=False))) == 0


def test_level_csv_date_forms_and_bad_header():
    s = parse.parse_level_csv("date,value\n2000,100\n2001-06,110\n2001-12-28,120\n")
    assert list(s.index.strftime("%Y-%m-%d")) == ["2000-12-31", "2001-06-30", "2001-12-28"]
    try:
        parse.parse_level_csv("year,price\n2000,1\n")
    except ValueError:
        return
    raise AssertionError("不正な見出しを受理した")


# ---------- パーサ: Damodaran ----------


def test_damodaran_parser_basic_and_stops_at_summary_rows():
    years = range(1928, 1933)
    df = parse.parse_damodaran_returns(damodaran_raw(years, [0.1, 0.2, -0.3, -0.4, 0.5],
                                                     [0.0, 0.0, 0.0, 0.69, 0.0], [0.01] * 5))
    assert list(df.index) == [1928, 1929, 1930, 1931, 1932]  # 平均行は含まれない
    assert list(df.columns) == ["sp500", "gold", "inflation"]
    assert df.loc[1930, "sp500"] == -0.3 and df.loc[1931, "gold"] == 0.69
    assert (df["inflation"] == 0.01).all()


def test_damodaran_parser_ignores_later_tables_with_year_rows():
    """要約行の後ろに別の表（年の行）が続いても、最初の表だけを読む。"""
    raw = damodaran_raw(range(1928, 1931), [0.1, 0.2, 0.3], [0.0, 0.0, 0.0], [0.01] * 3)
    width = raw.shape[1]
    later = pd.DataFrame([[None] * width, [2001.0, 9.9, 0.1, 0.1, 0.1, 0.1, 0.1, 9.9, 9.9],
                          [2002.0, 9.9, 0.1, 0.1, 0.1, 0.1, 0.1, 9.9, 9.9]])
    df = parse.parse_damodaran_returns(pd.concat([raw, later], ignore_index=True))
    assert list(df.index) == [1928, 1929, 1930]


def test_damodaran_parser_normalizes_percent_units():
    raw = damodaran_raw(range(1928, 1933), [0.1, 0.2, -0.3, -0.4, 0.5], [0.0, 0.0, 0.0, 0.69, 1.26], [0.01] * 5,
                        scale=100.0)
    df = parse.parse_damodaran_returns(raw)
    assert abs(df.loc[1932, "gold"] - 1.26) < 1e-12 and abs(df.loc[1928, "sp500"] - 0.1) < 1e-12


def test_damodaran_parser_inflation_column_is_optional():
    raw = damodaran_raw(range(1928, 1931), [0.1, 0.2, 0.3], [0.0, 0.0, 0.0], [0.0] * 3, with_inflation_col=False)
    assert parse.parse_damodaran_returns(raw)["inflation"].isna().all()


REAL_DAMODARAN_HEADER = [
    "Year", "S&P 500 (includes dividends)", "US Small cap (bottom decile)", "3-month T.Bill",
    "US T. Bond (10-year)", "Baa Corporate Bond", "Real Estate", "Gold*",
    "S&P 500 (includes dividends)3", "US Small cap (bottom decile) Cum Value", "3-month T.Bill4",
    "US T. Bond5", "Baa Corporate Bond2", "Real Estate2", "Gold2", "Stocks - Bills", "Stocks - Bonds",
    "Small Cap Premium (S&P 500 minus Bottom Decile)", "Stocks - Baa Corp Bond", "Historical ERP",
    "Inflation Rate", "S&P 500 (includes dividends)2", "US Small cap (bottom decile)22",
    "3-month T. Bill (Real)", "!0-year T.Bonds", "Baa Corp Bonds", "Real Estate3", "Gold",
    "S&P 500 (includes dividends)3", "US Small cap (bottom decile)22", "3-month T.Bill4",
    "US T. Bond5", "Baa Corporate Bond2", "Real Estate2", "Gold2", "Stocks minus T. Bills",
    "Stocks minus T.Bonds",
]


def test_damodaran_parser_real_layout_uses_nominal_block_only():
    """実ファイル（Returns by year）と同じ見出し・列数。右側の累積値・実質値のブロックは読まない。"""
    n = len(REAL_DAMODARAN_HEADER)
    top = [["Date updated:", *[None] * (n - 1)] for _ in range(18)]
    rows = [*top, [None, "Annual Returns on Investments in", *[None] * (n - 2)], REAL_DAMODARAN_HEADER]
    for y, sp, gold, infl in ((1928, 0.438112, 0.000969, -0.011561), (1929, -0.082979, -0.001452, 0.005848)):
        row = [777.0] * n  # 他ブロックは大きな別の値（誤って読むと検出できる）
        row[0], row[1], row[7], row[20] = float(y), sp, gold, infl
        rows.append(row)
    rows.append([None] * n)
    rows.append(["Arithmetic Average Historical Return", *[None] * (n - 1)])
    rows.append(["1928-2025", 0.1185, *[None] * (n - 2)])
    df = parse.parse_damodaran_returns(pd.DataFrame(rows))
    assert list(df.index) == [1928, 1929]
    assert df.loc[1928, "sp500"] == 0.438112 and df.loc[1929, "gold"] == -0.001452
    assert df.loc[1928, "inflation"] == -0.011561


def test_damodaran_parser_errors():
    good = damodaran_raw(range(1928, 1931), [0.1, 0.2, 0.3], [0.0, 0.0, 0.0], [0.0] * 3)
    no_header = pd.DataFrame([["a", "b"], ["c", "d"]])
    dup_year = pd.concat([good.iloc[:4], good.iloc[[3]], good.iloc[4:]], ignore_index=True)  # 1928 行をデータ内で重複
    ambiguous = good.copy()
    ambiguous.iat[2, 2] = "S&P 500 (large cap)"  # 'S&P 500' を含む列が2つ
    for raw in (no_header, dup_year, ambiguous):
        try:
            parse.parse_damodaran_returns(raw)
        except ValueError:
            continue
        raise AssertionError("例外が出なかった")


# ---------- 日本CPI（統計局CSVの変換） ----------


def estat_text(months, extra_rows=()) -> str:
    """e-Stat「品目別価格指数（全国・月次）」に似たCSV（行=年月、列=品目、総合は2列目）。"""
    head = ["類・品目,総合,食料", "Group/Item,All items,Food", "類・品目符号,0001,0002",
            "含類総連番,001,002", "ウエイト,3543757090,975803165", "ウエイト１万分比,10000,2754"]
    body = [f"{ym},{100 + i}.0,{50 + i}.0" for i, ym in enumerate(months)]
    return "\n".join([*head, *body, *extra_rows]) + "\n"


def test_convert_jp_cpi_reads_all_items_column_and_feeds_pipeline():
    months = [f"{y}{m:02d}" for y in (2019, 2020) for m in range(1, 13)]
    out = convert_jp_cpi.convert(estat_text(months))
    assert out[0] == ("2019-01", 100.0) and out[-1] == ("2020-12", 123.0) and len(out) == 24
    csv_text = "date,value\n" + "".join(f"{d},{v}\n" for d, v in out)
    ch = transform.annual_change(transform.year_end_levels(parse.parse_level_csv(csv_text)))
    assert list(ch.index) == [2020] and abs(ch[2020] - (123.0 / 111.0 - 1)) < 1e-12  # 12月/前年12月


def test_convert_jp_cpi_encodings_and_errors():
    months = [f"2020{m:02d}" for m in range(1, 13)]
    text = estat_text(months)
    assert convert_jp_cpi._decode(text.encode("cp932")) == text  # 統計局は CP932
    assert convert_jp_cpi._decode(text.encode("utf-8-sig")) == text
    cases = [
        estat_text(months[:5] + months[6:]),  # 欠けた月
        estat_text(months, extra_rows=["202001,1.0,1.0"]),  # 重複
        estat_text(months).replace("類・品目,総合,食料", "類・品目,食料,穀類"),  # 総合列なし
        estat_text(months).replace("100.0,50.0", "x,50.0"),  # 数値でない
        "a,b\n1,2\n",  # 見出しなし
    ]
    for bad in cases:
        try:
            convert_jp_cpi.convert(bad)
        except ValueError:
            continue
        raise AssertionError("例外が出なかった")


# ---------- 変換 ----------


def test_year_end_levels_drops_incomplete_year():
    s = parse.parse_fred_text("date,v\n1971-12-30,350\n1972-06-01,300\n1972-12-29,320\n1973-06-01,310\n")
    assert list(transform.year_end_levels(s).index) == [1971, 1972]  # 1973 は年末未到達


def test_annual_change_requires_consecutive_years():
    ch = transform.annual_change(pd.Series({1971: 350.0, 1972: 320.0, 1974: 400.0}))
    assert list(ch.index) == [1972] and abs(ch[1972] - (320 / 350 - 1)) < 1e-12


def test_real_return_usd_and_jpy():
    r, us, fx, jp = 0.10, 0.02, 0.05, 0.01
    usd = float(transform.real_return(r, us, currency="USD"))
    jpy = float(transform.real_return(r, us, currency="JPY", fx_change=fx, jp_inflation=jp))
    assert abs(usd - (1.10 / 1.02 - 1)) < 1e-12
    assert abs(jpy - (1.10 * 1.05 / 1.01 - 1)) < 1e-12


def test_jpy_equals_usd_when_fx_zero_and_inflation_equal():
    """spec.md 6.1 の性質7の元になる恒等式（Python リファレンス側）。"""
    rng = np.random.default_rng(0)
    r, pi = rng.normal(0.06, 0.15, 200), rng.uniform(0.0, 0.05, 200)
    usd = transform.real_return(r, pi, currency="USD")
    jpy = transform.real_return(r, pi, currency="JPY", fx_change=np.zeros(200), jp_inflation=pi)
    assert np.allclose(usd, jpy, atol=1e-15)


def test_real_return_rejects_unknown_currency_and_missing_inputs():
    for kwargs in ({"currency": "EUR"}, {"currency": "JPY"}):
        try:
            transform.real_return(0.1, 0.02, **kwargs)
        except ValueError:
            continue
        raise AssertionError(f"例外が出なかった: {kwargs}")


# ---------- JST（先進国株式） ----------


def jst_panel(years, countries=12, eq=0.10, fx_by_year=None) -> pd.DataFrame:
    rows = []
    for c in range(countries):
        for y in years:
            fx = 100.0 if fx_by_year is None else fx_by_year(y)
            rows.append({"year": y, "country": f"C{c}", "iso": f"C{c}", "eq_tr": eq, "xrusd": fx})
    return pd.DataFrame(rows)


def test_jst_parser_columns_case_and_errors():
    df = jst_panel([2000, 2001]).rename(columns={"eq_tr": "EQ_TR"})
    out = parse.parse_jst_panel(df)
    assert {"year", "country", "eq_tr", "xrusd"} <= set(out.columns) and len(out) == 24
    for bad in (df.drop(columns=["xrusd"]), pd.concat([df, df.iloc[:1]]), df.assign(EQ_TR=float("nan"))):
        try:
            parse.parse_jst_panel(bad)
        except ValueError:
            continue
        raise AssertionError("例外が出なかった")
    try:
        parse.parse_jst_panel(df.assign(EQ_TR=50.0))  # % 表記の疑い
    except ValueError:
        pass
    else:
        raise AssertionError("例外が出なかった")


def test_jst_parser_tolerates_hyperinflation_outliers_but_rejects_percent_units():
    df = jst_panel(range(1920, 1930))
    df.loc[(df.country == "C0") & (df.year == 1923), "eq_tr"] = 2.6e9  # 戦間期ドイツ型の外れ値
    out = parse.parse_jst_panel(df)
    assert out["eq_tr"].max() == 2.6e9
    try:
        parse.parse_jst_panel(jst_panel([2000, 2001], eq=12.0))  # 中央値 12 → % 表記
    except ValueError:
        pass
    else:
        raise AssertionError("例外が出なかった")


def test_dm_equity_fx_direction_and_equal_weight():
    # 全国 eq_tr=10%。為替: 現地通貨/USD が 100 → 80（現地通貨高）なら USD リターンは 1.1*100/80-1
    panel = jst_panel([2000, 2001], fx_by_year=lambda y: 100.0 if y == 2000 else 80.0)
    dm = transform.dm_equity_usd(panel, min_countries=10)
    assert list(dm.index) == [2001] and abs(dm[2001] - (1.1 * 100 / 80 - 1)) < 1e-12
    # 等ウェイト: 半数の国が +20%、半数が 0% → 平均 +10%
    p2 = jst_panel([2000, 2001], countries=10)
    p2.loc[(p2.year == 2001) & (p2.country.isin([f"C{i}" for i in range(5)])), "eq_tr"] = 0.20
    p2.loc[(p2.year == 2001) & (~p2.country.isin([f"C{i}" for i in range(5)])), "eq_tr"] = 0.0
    assert abs(transform.dm_equity_usd(p2, 10)[2001] - 0.10) < 1e-12


def test_dm_equity_drops_thin_years_and_gaps():
    panel = jst_panel([2000, 2001, 2002], countries=12)
    panel.loc[(panel.year == 2001) & (panel.country != "C0"), "eq_tr"] = float("nan")  # 2001年は1か国のみ
    dm = transform.dm_equity_usd(panel, min_countries=10)
    assert list(dm.index) == [2002]  # 2001は国数不足、2002は前年xrusdはあるが有効国数OK
    # 年が飛んでいる国は前年比が作れない
    gap = jst_panel([2000, 2002], countries=12)
    assert len(transform.dm_equity_usd(gap, 10)) == 0


# ---------- ビルド ----------


def synthetic_raw(shift_damodaran_inflation: int = 0) -> build.RawData:
    years = list(range(1928, 1991))
    sp = [0.05 + 0.01 * (y % 7) for y in years]
    gold = [0.02 * (y % 9) for y in years]
    infl = [annual_infl(y + shift_damodaran_inflation) for y in years]
    raw = build.RawData()
    raw.damodaran = parse.parse_damodaran_returns(damodaran_raw(years, sp, gold, infl))
    raw.us_cpi = parse.parse_fred_text(cpi_text(1927, 1995), monthly=True)
    raw.jst = parse.parse_jst_panel(jst_panel(range(1945, 1991)))
    raw.fx = parse.parse_fred_text(
        "date,v\n" + "\n".join(f"{y}-12-29,{100 + 5 * (y - 1971)}" for y in range(1971, 1981)))
    raw.jp_cpi = parse.parse_level_csv(
        "date,value\n" + "\n".join(f"{y}-12,{100 + 3 * (y - 1970)}" for y in range(1970, 1981)))
    for sid in ("DAMODARAN", "JST", "FRED_DEXJPUS", "FRED_CPIAUCNS", "JP_CPI"):
        raw.source_meta[sid] = {"license_status": "cleared"}
    return raw


def good_doc() -> dict:
    return build.assemble(synthetic_raw(), generated_at="2026-01-01T00:00:00+00:00")


def test_assemble_structure_and_values():
    doc = good_doc()
    assert doc["schema_version"] == config.SCHEMA_VERSION
    assert set(doc["assets"]) == {"SP500", "GOLD", "WORLD_DM"}
    assert set(doc["macro"]) == {"us_inflation", "usdjpy_change", "jp_inflation"}
    sp = doc["assets"]["SP500"]
    assert sp["source"] == "DAMODARAN" and sp["start_year"] == 1928 and len(sp["values"]) == 63
    assert abs(sp["values"][0] - (0.05 + 0.01 * (1928 % 7))) < 1e-9
    dm = doc["assets"]["WORLD_DM"]
    assert dm["source"] == "JST" and dm["start_year"] == 1950  # 1945〜1949 は下限で除外
    assert dm["values"][0] == 0.1 and len(dm["values"]) == 41  # 為替不変・全国+10%
    assert doc["macro"]["us_inflation"]["source"] == "FRED_CPIAUCNS"
    assert doc["macro"]["us_inflation"]["start_year"] == 1928  # 1927年12月が基準
    assert abs(doc["macro"]["us_inflation"]["values"][0] - annual_infl(1928)) < 1e-6
    assert doc["macro"]["usdjpy_change"]["start_year"] == 1972
    assert abs(doc["macro"]["usdjpy_change"]["values"][0] - 0.05) < 1e-9


def test_gold_is_trimmed_to_free_market_years_with_note():
    gold = good_doc()["assets"]["GOLD"]
    floor, reason = config.ASSET_START_FLOOR["GOLD"]
    assert gold["start_year"] == floor == 1972 and len(gold["values"]) == 1990 - 1972 + 1
    assert abs(gold["values"][0] - 0.02 * (1972 % 9)) < 1e-9  # 1972年の値から始まる
    assert gold["notes"] == [reason]
    assert "notes" not in good_doc()["assets"]["SP500"]


def test_assemble_rejects_gaps():
    raw = synthetic_raw()
    raw.damodaran.loc[1950, "sp500"] = float("nan")  # 欠番になる
    try:
        build.assemble(raw)
    except ValueError as e:
        assert "連続" in str(e)
        return
    raise AssertionError("年の欠番を検出できなかった")


def test_inflation_check_passes_when_aligned():
    by = good_doc()["checks"]["damodaran_inflation_vs_fred_cpi"]["mean_abs_diff_by_year_offset"]
    assert by["0"] < 1e-6 and by["-1"] > 1e-4 and by["1"] > 1e-4
    warnings = validate.validate_doc(good_doc())[1]
    assert not any("インフレ突き合わせ" in w for w in warnings)  # 合成の株価・金は想定範囲外になりうるので除外


def test_inflation_check_detects_year_shift():
    doc = build.assemble(synthetic_raw(shift_damodaran_inflation=1))
    by = doc["checks"]["damodaran_inflation_vs_fred_cpi"]["mean_abs_diff_by_year_offset"]
    assert min(by, key=by.get) != "0"
    _, warnings = validate.validate_doc(doc)
    assert any("年がずれている疑い" in w for w in warnings)


def test_load_raw_license_gate_and_missing_files():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "fred").mkdir()
        (root / "fred" / "DEXJPUS.csv").write_text("date,v\n2000-12-29,100\n2001-12-31,110\n")
        (root / "fred" / "CPIAUCNS.csv").write_text("date,v\n2000-12-01,170.0\n2001-12-01,174.0\n")
        (root / "manual").mkdir()
        (root / "manual" / "jp_cpi.csv").write_text("date,value\n2000-12,100\n2001-12,101\n")

        ok = build.load_raw(root, allowed=("cleared",))
        assert ok.fx is not None and ok.us_cpi is not None and ok.jp_cpi is not None
        assert len(ok.source_meta["FRED_DEXJPUS"]["sha256"]) == 64
        reasons = {s["source"]: s["reason"] for s in ok.skipped}
        assert "ファイルなし" in reasons["DAMODARAN"]  # cleared だがファイルが無い

        # cleared のソースを needs-review / blocked に落とすと、読まれず理由が記録される
        original = build.SOURCES["JP_CPI"]
        try:
            build.SOURCES["JP_CPI"] = replace(original, license_status="needs-review")
            strict = build.load_raw(root, allowed=("cleared",))
            assert strict.jp_cpi is None
            assert "needs-review" in {s["source"]: s["reason"] for s in strict.skipped}["JP_CPI"]
            assert build.load_raw(root, allowed=("cleared", "needs-review")).jp_cpi is not None

            build.SOURCES["JP_CPI"] = replace(original, license_status="blocked")
            assert build.load_raw(root, allowed=("cleared", "needs-review")).jp_cpi is None
        finally:
            build.SOURCES["JP_CPI"] = original


def test_config_is_consistent():
    for sid, src in config.SOURCES.items():
        assert src.license_status in {"cleared", "needs-review", "blocked"}, sid
        assert src.attribution_ja and src.attribution_en and src.citation, sid
    for asset_id, (_, sid) in config.ASSETS.items():
        assert sid in config.SOURCES, asset_id
    assert set(config.ASSETS) == {"SP500", "GOLD", "WORLD_DM"}
    assert config.ASSET_START_FLOOR["WORLD_DM"][0] == 1950
    assert config.ASSET_START_FLOOR["GOLD"][0] == 1972


# ---------- 出所・加工表記 ----------


def test_attribution_lists_only_used_sources_and_processing_note():
    doc = good_doc()
    ids = [it["id"] for it in doc["attribution"]["items"]]
    assert ids == ["DAMODARAN", "JST", "FRED_DEXJPUS", "FRED_CPIAUCNS", "JP_CPI"]  # 定義順
    notice = doc["attribution"]["notice_ja"]
    assert "アスワス・ダモダラン教授" in notice
    assert "総務省統計局ホームページ「消費者物価指数（CPI）」をもとに作成" in notice
    assert "開発者が独自に計算・加工して構築したもの" in notice
    assert "各提供元が作成・公表したものではありません" in notice
    assert "CC BY-NC-SA 4.0" in notice and "等ウェイト" in notice and "非営利" in notice

    raw = synthetic_raw()
    raw.jp_cpi = None
    doc2 = build.assemble(raw)
    assert "JP_CPI" not in [it["id"] for it in doc2["attribution"]["items"]]
    assert "総務省統計局" not in doc2["attribution"]["notice_ja"]


# ---------- 検証 ----------


def test_validate_accepts_good_doc():
    errors, _ = validate.validate_doc(good_doc(), raw_bytes=1000)
    assert errors == [], errors


def test_validate_detects_bad_values_and_size():
    doc = good_doc()
    doc["assets"]["SP500"]["values"][3] = float("nan")
    doc["assets"]["GOLD"]["values"][2] = 7.5
    errors, _ = validate.validate_doc(doc, raw_bytes=config.MAX_OUTPUT_BYTES + 1)
    joined = "\n".join(errors)
    assert "非有限" in joined and "範囲外" in joined and "上限" in joined


def test_validate_requires_us_inflation_and_known_sources():
    doc = good_doc()
    del doc["macro"]["us_inflation"]
    doc["assets"]["GOLD"]["source"] = "UNKNOWN"
    joined = "\n".join(validate.validate_doc(doc)[0])
    assert "us_inflation" in joined and "UNKNOWN" in joined


def test_validate_rejects_incomplete_current_year():
    doc = good_doc()
    doc["assets"]["GOLD"]["start_year"] = datetime.now(timezone.utc).year - 1
    doc["assets"]["GOLD"]["values"] = [0.01, 0.02]
    assert any("未完了" in e for e in validate.validate_doc(doc)[0])


def test_validate_strict_rejects_needs_review():
    doc = good_doc()
    doc["sources"]["DAMODARAN"]["license_status"] = "needs-review"
    assert validate.validate_doc(doc, strict=False)[0] == []
    errors, _ = validate.validate_doc(doc, strict=True)
    assert any("strict" in e and "DAMODARAN" in e for e in errors)


def test_validate_sanity_warnings_on_misaligned_series():
    doc = good_doc()
    doc["assets"]["SP500"]["start_year"] = 1900
    doc["assets"]["SP500"]["values"] = [0.05] * 40  # 1931 が +5% → 警告
    doc["assets"]["GOLD"]["start_year"] = 1972
    doc["assets"]["GOLD"]["values"] = [0.0] * 30  # 1979 が 0% → 警告
    _, warnings = validate.validate_doc(doc)
    assert any("SP500 1931" in w for w in warnings) and any("GOLD 1979" in w for w in warnings)


def test_validate_requires_attribution_for_every_used_source():
    doc = good_doc()
    doc["attribution"]["items"] = [i for i in doc["attribution"]["items"] if i["id"] != "DAMODARAN"]
    assert any("DAMODARAN" in e and "出所表記" in e for e in validate.validate_doc(doc)[0])
    del doc["attribution"]
    assert any("attribution" in e and "ありません" in e for e in validate.validate_doc(doc)[0])


def test_validate_requires_processing_disclaimer_for_jp_cpi():
    doc = good_doc()
    doc["attribution"]["notice_ja"] = doc["attribution"]["notice_ja"].replace("開発者が独自に計算・加工", "加工")
    assert any("日本CPI" in e for e in validate.validate_doc(doc)[0])


def test_validate_requires_jst_license_and_method_notice():
    for phrase in ("CC BY-NC-SA 4.0", "非営利", "等ウェイト"):
        doc = good_doc()
        doc["attribution"]["notice_ja"] = doc["attribution"]["notice_ja"].replace(phrase, "X")
        assert any("JST" in e and phrase in e for e in validate.validate_doc(doc)[0]), phrase


def test_validate_dm_sanity_warning():
    doc = good_doc()
    dm = doc["assets"]["WORLD_DM"]
    dm["start_year"], dm["values"] = 2008, [0.30, 0.30]  # 2008年が+30% → 警告
    _, warnings = validate.validate_doc(doc)
    assert any("WORLD_DM 2008" in w for w in warnings)


def test_output_roundtrips_as_json_and_is_small():
    text = json.dumps(good_doc(), ensure_ascii=False, separators=(",", ":"))
    assert json.loads(text)["schema_version"] == 1
    assert len(text.encode()) < config.MAX_OUTPUT_BYTES
