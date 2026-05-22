#!/usr/bin/env python3
"""
Fetch aggregated NYC low-level-crime data (misdemeanors + violations) for the
NYC Misdemeanor & Violation Map.

Two lenses, two datasets each:

  COMPLAINTS (reported crime)
    - qgea-i56i  NYPD Complaint Data Historic        (2006-2025)  -> 2015-2025
    - 5uac-w243  NYPD Complaint Data Current (YTD)    (2026)       -> 2026 Q1

  ARRESTS (enforcement activity)
    - 8h9b-rp9u  NYPD Arrests Data Historic           (2006-2025)  -> 2015-2025
    - uip8-fykc  NYPD Arrest Data Year to Date        (2026)       -> 2026 Q1

We aggregate server-side (SoQL GROUP BY) to:
    precinct x year x offense x law_cat -> count

Complaints are dated by RPT_DT (report date), per editorial standard.
Arrests are dated by ARREST_DATE.
2026 is capped at Q1 (Jan 1 - Mar 31) to match the requested window and avoid
misleading partial-year totals.

Output: data/raw_complaints.json, data/raw_arrests.json
"""
import json
import time
import urllib.parse
import urllib.request
import os

DOMAIN = "https://data.cityofnewyork.us/resource"
OUT_DIR = os.path.join(os.path.dirname(__file__), "data")

Q1_END = "2026-04-01T00:00:00"  # exclusive upper bound = through Mar 31 2026

# (dataset_id, date_field, precinct_field, offense_field, lawcat_field, where, label)
COMPLAINT_SOURCES = [
    {
        "id": "qgea-i56i", "date": "rpt_dt", "pct": "addr_pct_cd",
        "ofns": "ofns_desc", "lawcat": "law_cat_cd",
        "where": "rpt_dt >= '2015-01-01T00:00:00' AND rpt_dt < '2026-01-01T00:00:00' "
                 "AND (law_cat_cd='MISDEMEANOR' OR law_cat_cd='VIOLATION')",
    },
    {
        "id": "5uac-w243", "date": "rpt_dt", "pct": "addr_pct_cd",
        "ofns": "ofns_desc", "lawcat": "law_cat_cd",
        "where": f"rpt_dt >= '2026-01-01T00:00:00' AND rpt_dt < '{Q1_END}' "
                 "AND (law_cat_cd='MISDEMEANOR' OR law_cat_cd='VIOLATION')",
    },
]

# Arrests use single-letter law_cat_cd: M=misdemeanor, V=violation
ARREST_SOURCES = [
    {
        "id": "8h9b-rp9u", "date": "arrest_date", "pct": "arrest_precinct",
        "ofns": "ofns_desc", "lawcat": "law_cat_cd",
        "where": "arrest_date >= '2015-01-01T00:00:00' AND arrest_date < '2026-01-01T00:00:00' "
                 "AND (law_cat_cd='M' OR law_cat_cd='V')",
    },
    {
        "id": "uip8-fykc", "date": "arrest_date", "pct": "arrest_precinct",
        "ofns": "ofns_desc", "lawcat": "law_cat_cd",
        "where": f"arrest_date >= '2026-01-01T00:00:00' AND arrest_date < '{Q1_END}' "
                 "AND (law_cat_cd='M' OR law_cat_cd='V')",
    },
]


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
        for attempt in range(5):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "nyc-misdemeanor-map/1.0"})
                with urllib.request.urlopen(req, timeout=120) as resp:
                    batch = json.loads(resp.read().decode())
                break
            except Exception as e:
                print(f"  retry {attempt+1} ({source['id']} offset {offset}): {e}")
                time.sleep(3 * (attempt + 1))
        else:
            raise RuntimeError(f"failed: {source['id']} offset {offset}")
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


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    run(COMPLAINT_SOURCES, "complaints")
    run(ARREST_SOURCES, "arrests")
    print("done.")
