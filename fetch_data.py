#!/usr/bin/env python3
"""
Fetch aggregated NYC low-level-crime data (misdemeanors + violations) for the
NYC Misdemeanor & Violation Map.

Two lenses, two datasets each:

  COMPLAINTS (reported crime)
    - qgea-i56i  NYPD Complaint Data Historic     -> 2015 .. last full year
    - 5uac-w243  NYPD Complaint Data Current (YTD) -> current year to date

  ARRESTS (enforcement activity)
    - 8h9b-rp9u  NYPD Arrests Data Historic        -> 2015 .. last full year
    - uip8-fykc  NYPD Arrest Data Year to Date      -> current year to date

We aggregate server-side (SoQL GROUP BY) to:
    precinct x year x offense x law_cat -> count

Complaints are dated by RPT_DT (report date), per editorial standard.
Arrests are dated by ARREST_DATE.

The current year is capped at the latest COMPLETE calendar quarter (Q1 ends
Mar 31, Q2 Jun 30, Q3 Sep 30, Q4 Dec 31). The cap is detected automatically
from each YTD dataset's newest record, so no hand-editing is needed when a new
quarter lands -- just re-run. The resolved window is written to data/meta.json
for the build step and the front end.

Output: data/raw_complaints.json, data/raw_arrests.json, data/meta.json
"""
import json
import time
import urllib.parse
import urllib.request
import os
from datetime import date

DOMAIN = "https://data.cityofnewyork.us/resource"
OUT_DIR = os.path.join(os.path.dirname(__file__), "data")

HISTORY_START = "2015-01-01T00:00:00"

# (dataset ids and their field names) --------------------------------------
COMPLAINT_HIST = "qgea-i56i"
COMPLAINT_YTD = "5uac-w243"
ARREST_HIST = "8h9b-rp9u"
ARREST_YTD = "uip8-fykc"


def _get(url):
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "nyc-misdemeanor-map/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            print(f"  retry {attempt+1} ({url[:60]}...): {e}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed: {url}")


def max_date(dataset_id, field):
    """Newest record date in a dataset (YYYY-MM-DD), or None."""
    url = f"{DOMAIN}/{dataset_id}.json?" + urllib.parse.urlencode(
        {"$select": f"max({field}) AS mx"})
    rows = _get(url)
    mx = rows[0].get("mx") if rows else None
    return mx[:10] if mx else None


def latest_complete_quarter(d):
    """Latest quarter-end date on or before `d` (a datetime.date)."""
    ends = [date(d.year, 3, 31), date(d.year, 6, 30),
            date(d.year, 9, 30), date(d.year, 12, 31),
            date(d.year - 1, 12, 31)]
    return max(e for e in ends if e <= d)


def resolve_window():
    """Detect the latest complete quarter across both YTD datasets."""
    c_max = max_date(COMPLAINT_YTD, "rpt_dt")
    a_max = max_date(ARREST_YTD, "arrest_date")
    caps = []
    for mx in (c_max, a_max):
        if mx:
            caps.append(latest_complete_quarter(date.fromisoformat(mx)))
    if not caps:
        raise RuntimeError("could not read YTD dataset dates")
    cap = min(caps)                      # only include a quarter both datasets have
    cur_year = cap.year
    q = (cap.month - 1) // 3 + 1
    partial = (cap.month, cap.day) != (12, 31)
    return {
        "cap": cap,
        "cur_year": cur_year,
        "quarter_label": f"Q{q} {cur_year}",
        "partial": partial,
    }


def build_sources(win):
    cur_year = win["cur_year"]
    cur_start = f"{cur_year}-01-01T00:00:00"
    # exclusive upper bound = day after the quarter-end
    cap = win["cap"]
    cap_excl = date(cap.year, cap.month, cap.day)
    cap_excl_str = f"{cap_excl.isoformat()}T00:00:00"
    # Socrata WHERE wants strictly-less-than the day AFTER the cap. Add a day:
    from datetime import timedelta
    cap_excl_str = f"{(cap + timedelta(days=1)).isoformat()}T00:00:00"
    hist_end = cur_start                 # historic: up to (not incl) current year

    complaints = [
        {"id": COMPLAINT_HIST, "date": "rpt_dt", "pct": "addr_pct_cd",
         "ofns": "ofns_desc", "lawcat": "law_cat_cd",
         "where": f"rpt_dt >= '{HISTORY_START}' AND rpt_dt < '{hist_end}' "
                  "AND (law_cat_cd='MISDEMEANOR' OR law_cat_cd='VIOLATION')"},
        {"id": COMPLAINT_YTD, "date": "rpt_dt", "pct": "addr_pct_cd",
         "ofns": "ofns_desc", "lawcat": "law_cat_cd",
         "where": f"rpt_dt >= '{cur_start}' AND rpt_dt < '{cap_excl_str}' "
                  "AND (law_cat_cd='MISDEMEANOR' OR law_cat_cd='VIOLATION')"},
    ]
    arrests = [
        {"id": ARREST_HIST, "date": "arrest_date", "pct": "arrest_precinct",
         "ofns": "ofns_desc", "lawcat": "law_cat_cd",
         "where": f"arrest_date >= '{HISTORY_START}' AND arrest_date < '{hist_end}' "
                  "AND (law_cat_cd='M' OR law_cat_cd='V')"},
        {"id": ARREST_YTD, "date": "arrest_date", "pct": "arrest_precinct",
         "ofns": "ofns_desc", "lawcat": "law_cat_cd",
         "where": f"arrest_date >= '{cur_start}' AND arrest_date < '{cap_excl_str}' "
                  "AND (law_cat_cd='M' OR law_cat_cd='V')"},
    ]
    return complaints, arrests


def fetch(source):
    """Run one grouped SoQL query, paging through results."""
    select = (
        f"date_extract_y({source['date']}) AS yr, "
        f"{source['pct']} AS pct, "
        f"{source['ofns']} AS ofns, "
        f"{source['lawcat']} AS lawcat, "
        f"count(*) AS n"
    )
    group = "yr, pct, ofns, lawcat"
    rows = []
    offset = 0
    page = 50000
    while True:
        params = {
            "$select": select,
            "$where": source["where"],
            "$group": group,
            "$order": "yr, pct",
            "$limit": page,
            "$offset": offset,
        }
        url = f"{DOMAIN}/{source['id']}.json?" + urllib.parse.urlencode(params)
        batch = _get(url)
        rows.extend(batch)
        print(f"  {source['id']}: +{len(batch)} (total {len(rows)})")
        if len(batch) < page:
            break
        offset += page
    return rows


def normalize(rows):
    """Coerce types; drop rows with no precinct."""
    out = []
    for r in rows:
        pct = r.get("pct")
        if pct in (None, "", "(null)"):
            continue
        try:
            pct = int(float(pct))
        except (ValueError, TypeError):
            continue
        try:
            yr = int(float(r["yr"]))
        except (ValueError, TypeError):
            continue
        ofns = (r.get("ofns") or "UNKNOWN").strip().upper()
        lawcat = (r.get("lawcat") or "").strip().upper()
        n = int(float(r.get("n", 0)))
        out.append({"yr": yr, "pct": pct, "ofns": ofns, "lawcat": lawcat, "n": n})
    return out


def run(sources, name):
    print(f"== {name} ==")
    all_rows = []
    for s in sources:
        all_rows.extend(fetch(s))
    norm = normalize(all_rows)
    total = sum(r["n"] for r in norm)
    print(f"  {name}: {len(norm)} agg rows, {total:,} incidents")
    path = os.path.join(OUT_DIR, f"raw_{name}.json")
    with open(path, "w") as f:
        json.dump(norm, f)
    print(f"  wrote {path}")
    return norm


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    win = resolve_window()
    print(f"latest complete quarter: {win['quarter_label']} "
          f"(through {win['cap'].isoformat()}), partial={win['partial']}")
    complaints, arrests = build_sources(win)
    run(complaints, "complaints")
    run(arrests, "arrests")

    cap = win["cap"]
    q = (cap.month - 1) // 3 + 1
    if win["partial"]:
        note = (f"{win['cur_year']} is partial ({win['quarter_label']} only, "
                f"through {cap.strftime('%b %-d')}). Compare it against the same "
                f"period in prior years, not against full years.")
    else:
        note = f"Data runs through the full year {win['cur_year']}."
    meta = {
        "generated": date.today().isoformat(),
        "start": "2015-01-01",
        "data_through": cap.isoformat(),
        "quarter_label": win["quarter_label"],
        "partial": win["partial"],
        "partial_year": win["cur_year"],
        "note": note,
    }
    with open(os.path.join(OUT_DIR, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"  wrote data/meta.json: {meta['quarter_label']} "
          f"(through {meta['data_through']})")
    print("done.")


if __name__ == "__main__":
    main()
