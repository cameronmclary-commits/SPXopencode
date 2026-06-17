import sys, os, json, warnings
warnings.filterwarnings("ignore")
import databento as db
import pandas as pd

API_KEY = os.environ.get("DATABENTO_API_KEY", "")

def parse_spxw(symbol: str, file_date: str):
    if not symbol.startswith("SPXW"):
        return None
    exp = symbol[4:10]
    if exp != file_date:
        return None
    typ = "call" if symbol[10] == "C" else "put"
    strike = int(symbol[11:19]) / 1000
    return {"strike": strike, "type": typ}

def estimate_spot(df: pd.DataFrame):
    calls = df[df["type"] == "call"].set_index("strike")
    puts = df[df["type"] == "put"].set_index("strike")
    common = calls.index.intersection(puts.index)
    if len(common) < 5:
        return 0
    mids = []
    for st in common:
        mid_c = (float(calls.loc[st, "bid"]) + float(calls.loc[st, "ask"])) / 2
        mid_p = (float(puts.loc[st, "bid"]) + float(puts.loc[st, "ask"])) / 2
        if mid_c > 0 and mid_p > 0:
            mids.append(st + mid_c - mid_p)
    if not mids:
        return 0
    mids.sort()
    return round(mids[len(mids) // 2], 2)

def main():
    date_str = sys.argv[1]
    file_date = date_str[2:4] + date_str[5:7] + date_str[8:10]
    cache_dir = os.path.join(os.path.dirname(__file__), "..", "snapshot-cache")
    os.makedirs(cache_dir, exist_ok=True)
    cache_path = os.path.join(cache_dir, f"{file_date}.json")

    if os.path.exists(cache_path):
        with open(cache_path) as f:
            sys.stdout.write(f.read())
        return

    client = db.Historical(API_KEY)

    data = client.timeseries.get_range(
        dataset="OPRA.PILLAR",
        schema="cbbo-1m",
        start=f"{date_str}T13:30:00",
        end=f"{date_str}T20:00:00",
        symbols="ALL_SYMBOLS",
        stype_in="raw_symbol",
    )

    df = data.to_df()
    if df.empty:
        sys.stdout.write("[]")
        return

    df["ts_event"] = pd.to_datetime(df["ts_event"], utc=True)
    df["minute_key"] = df["ts_event"].dt.strftime("%Y-%m-%dT%H:%M")

    parsed = df["symbol"].apply(lambda s: parse_spxw(s, file_date))
    valid = parsed.notna()
    df = df[valid].copy()
    df["strike"] = parsed[valid].apply(lambda x: x["strike"])
    df["type"] = parsed[valid].apply(lambda x: x["type"])

    if df.empty:
        sys.stdout.write("[]")
        return

    df["bid"] = pd.to_numeric(df["bid_px"], errors="coerce").fillna(0)
    df["ask"] = pd.to_numeric(df["ask_px"], errors="coerce").fillna(0)
    mask = (df["bid"] > 0) & (df["ask"] > 0) & (df["bid"] < 10000) & (df["ask"] < 10000)
    df = df[mask]

    snapshots = []
    for minute, grp in df.groupby("minute_key", sort=True):
        spot = estimate_spot(grp)
        if spot <= 0:
            continue
        filt = grp[grp["strike"].between(spot - 40, spot + 40)]
        if filt.empty:
            continue
        calls = filt[filt["type"] == "call"].sort_values("strike")
        puts_ = filt[filt["type"] == "put"].sort_values("strike")
        chain = []
        for _, row in pd.concat([calls, puts_]).iterrows():
            bid = round(float(row["bid"]), 2)
            ask = round(float(row["ask"]), 2)
            chain.append({
                "strike": row["strike"],
                "type": row["type"],
                "bid": bid,
                "ask": ask,
                "mid": round((bid + ask) / 2, 2),
                "last": 0,
                "volume": 0,
                "openInterest": 0,
            })
        snapshots.append({"time": minute, "spot": spot, "chain": chain})

    if not snapshots:
        sys.stdout.write("[]")
        return

    with open(cache_path, "w") as f:
        json.dump(snapshots, f)

    sys.stdout.write(json.dumps(snapshots))

if __name__ == "__main__":
    main()
