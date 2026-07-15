#!/usr/bin/env python3
"""
Build compact front-end data from the raw aggregates.

Inputs:  data/raw_complaints.json, data/raw_arrests.json, data/precincts_raw.geojson
Outputs: data/data.json   (offenses, precincts, rows for both lenses)
         data/precincts.json (simplified geojson w/ borough)
         data/classification.csv (transparency: every offense -> group)

Offense classification (the analytical core)
--------------------------------------------
Each offense is assigned to one of three groups:

  proactive  - "enforcement-sensitive": discretionary, officer-initiated
               offenses whose recorded counts move with policing strategy
               (drugs, trespass, fare evasion, prostitution, disorderly
               conduct, weapon possession, traffic-law arrests, etc.)
  victim     - "complaint-driven": offenses typically reported by a victim
               or witness (petit larceny, assault 3, harassment, criminal
               mischief, sex crimes, fraud, etc.)
  other      - administrative / mixed / ambiguous catch-alls, plus offenses
               that arise downstream of police contact (resisting/OGA),
               public-order grab-bags, and uncoded entries.

This mapping is a documented editorial judgment, exported to
data/classification.csv so anyone can inspect or contest it.
"""
import csv
import json
import os

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "data")

# --- offense canonicalization: raw NYPD ofns_desc (UPPER) -> canonical label ---
# Merges truncated spellings and arrest/complaint variants of the same offense.
ALIASES = {
    "OFFENSES AGAINST PUBLIC ADMINI": "Offenses against public administration",
    "OFFENSES AGAINST PUBLIC ADMINISTRATION": "Offenses against public administration",
    "CRIMINAL MISCHIEF & RELATED OF": "Criminal mischief",
    "CRIMINAL MISCHIEF & RELATED OFFENSES": "Criminal mischief",
    "OFF. AGNST PUB ORD SENSBLTY &": "Offense against public order/sensibility",
    "OFF. AGNST PUB ORD SENSBLTY & RGHTS TO PRIV": "Offense against public order/sensibility",
    "OTHER OFFENSES RELATED TO THEFT": "Other theft-related offenses",
    "OTHER OFFENSES RELATED TO THEF": "Other theft-related offenses",
    "OTHER STATE LAWS (NON PENAL LAW)": "Other state laws (non-penal)",
    "OTHER STATE LAWS (NON PENAL LA": "Other state laws (non-penal)",
    "OTHER STATE LAWS": "Other state laws",
    "POSSESSION OF STOLEN PROPERTY": "Possession of stolen property",
    "POSSESSION OF STOLEN PROPERTY 5": "Possession of stolen property",
    "UNAUTHORIZED USE OF A VEHICLE": "Unauthorized use of a vehicle",
    "UNAUTHORIZED USE OF A VEHICLE 3 (UUV)": "Unauthorized use of a vehicle",
    "LOITERING/GAMBLING (CARDS, DIC": "Loitering/gambling",
    "LOITERING/GAMBLING (CARDS, DICE, ETC)": "Loitering/gambling",
    "DISRUPTION OF A RELIGIOUS SERV": "Disruption of a religious service",
    "DISRUPTION OF A RELIGIOUS SERVICE": "Disruption of a religious service",
    "UNLAWFUL POSS. WEAP. ON SCHOOL": "Unlawful possession of weapon on school grounds",
    "UNLAWFUL POSS. WEAP. ON SCHOOL GROUNDS": "Unlawful possession of weapon on school grounds",
    "ADMINISTRATIVE CODE": "Administrative code",
    "ADMINISTRATIVE CODES": "Administrative code",
    "HARRASSMENT 2": "Harassment 2",
    "HARASSMENT": "Harassment 2",
    "PETIT LARCENY": "Petit larceny",
    "PETIT LARCENY OF MOTOR VEHICLE": "Petit larceny of a motor vehicle",
    "ASSAULT 3 & RELATED OFFENSES": "Assault 3 & related offenses",
    "FELONY ASSAULT": "Assault 3 & related offenses",
    "SEX CRIMES": "Sex crimes",
    "FORCIBLE TOUCHING": "Forcible touching",
    "OFFENSES AGAINST THE PERSON": "Offenses against the person",
    "FRAUDS": "Frauds",
    "OFFENSES INVOLVING FRAUD": "Offenses involving fraud",
    "ENDAN WELFARE INCOMP": "Endangering welfare",
    "OFFENSES RELATED TO CHILDREN": "Offenses related to children",
    "DANGEROUS DRUGS": "Dangerous drugs",
    "CANNABIS RELATED OFFENSES": "Cannabis-related offenses",
    "LOITERING FOR DRUG PURPOSES": "Loitering for drug purposes",
    "UNDER THE INFLUENCE OF DRUGS": "Under the influence of drugs",
    "CRIMINAL TRESPASS": "Criminal trespass",
    "THEFT OF SERVICES": "Theft of services (fare evasion)",
    "GAMBLING": "Gambling",
    "LOITERING": "Loitering",
    "PROSTITUTION & RELATED OFFENSES": "Prostitution & related offenses",
    "DISORDERLY CONDUCT": "Disorderly conduct",
    "DANGEROUS WEAPONS": "Dangerous weapons (possession)",
    "INTOXICATED & IMPAIRED DRIVING": "Intoxicated/impaired driving (DWI)",
    "VEHICLE AND TRAFFIC LAWS": "Vehicle and traffic laws",
    "OTHER TRAFFIC INFRACTION": "Other traffic infraction",
    "ALCOHOLIC BEVERAGE CONTROL LAW": "Alcoholic beverage control law",
    "FRAUDULENT ACCOSTING": "Fraudulent accosting",
    "JOSTLING": "Jostling (pickpocketing)",
    "BURGLAR'S TOOLS": "Burglar's tools",
    "FORTUNE TELLING": "Fortune telling",
    "MISCELLANEOUS PENAL LAW": "Miscellaneous penal law",
    "AGRICULTURE & MRKTS LAW-UNCLASSIFIED": "Agriculture & markets law",
    "OFFENSES AGAINST PUBLIC SAFETY": "Offenses against public safety",
    "ANTICIPATORY OFFENSES": "Anticipatory offenses (attempt/conspiracy)",
    "ESCAPE 3": "Escape 3",
    "NYS LAWS-UNCLASSIFIED VIOLATION": "NYS laws (unclassified)",
    "NEW YORK CITY HEALTH CODE": "NYC health code",
    "OFFENSES AGAINST MARRIAGE UNCL": "Offenses against marriage",
    "(NULL)": "Uncoded / unknown",
    "UNKNOWN": "Uncoded / unknown",
}

# canonical label -> group
GROUP = {
    # proactive / enforcement-sensitive
    "Dangerous drugs": "proactive",
    "Cannabis-related offenses": "proactive",
    "Loitering for drug purposes": "proactive",
    "Under the influence of drugs": "proactive",
    "Criminal trespass": "proactive",
    "Theft of services (fare evasion)": "proactive",
    "Gambling": "proactive",
    "Loitering/gambling": "proactive",
    "Loitering": "proactive",
    "Prostitution & related offenses": "proactive",
    "Disorderly conduct": "proactive",
    "Dangerous weapons (possession)": "proactive",
    "Unlawful possession of weapon on school grounds": "proactive",
    "Intoxicated/impaired driving (DWI)": "proactive",
    "Vehicle and traffic laws": "proactive",
    "Other traffic infraction": "proactive",
    "Alcoholic beverage control law": "proactive",
    "Fraudulent accosting": "proactive",
    "Jostling (pickpocketing)": "proactive",
    "Burglar's tools": "proactive",
    "Fortune telling": "proactive",
    # victim / complaint-driven
    "Petit larceny": "victim",
    "Petit larceny of a motor vehicle": "victim",
    "Harassment 2": "victim",
    "Assault 3 & related offenses": "victim",
    "Criminal mischief": "victim",
    "Sex crimes": "victim",
    "Forcible touching": "victim",
    "Offenses against the person": "victim",
    "Frauds": "victim",
    "Offenses involving fraud": "victim",
    "Unauthorized use of a vehicle": "victim",
    "Possession of stolen property": "victim",
    "Other theft-related offenses": "victim",
    "Endangering welfare": "victim",
    "Offenses related to children": "victim",
    "Disruption of a religious service": "victim",
    # other / mixed / administrative / downstream-of-enforcement
    "Offenses against public administration": "other",
    "Offense against public order/sensibility": "other",
    "Administrative code": "other",
    "Miscellaneous penal law": "other",
    "Other state laws": "other",
    "Other state laws (non-penal)": "other",
    "Agriculture & markets law": "other",
    "Offenses against public safety": "other",
    "Anticipatory offenses (attempt/conspiracy)": "other",
    "Escape 3": "other",
    "NYS laws (unclassified)": "other",
    "NYC health code": "other",
    "Offenses against marriage": "other",
    "Uncoded / unknown": "other",
}


# --- precinct populations + neighborhoods -----------------------------------
# Residential population per precinct from the decennial censuses, apportioned
# to 2020 NYPD precinct boundaries by John Keefe's census-by-precincts crosswalk
# (github.com/jkeefe/census-by-precincts). Because precinct populations change
# over time, per-capita rates use a population that VARIES BY YEAR: the two
# decennial counts are anchors, linearly interpolated for the intercensal years
# (2015-2020) and held at the 2020 count thereafter (no reliable annual
# precinct-level population exists after 2020). Precinct 116 (operational since
# 2024, carved out of the 105th) has no crosswalk population and is excluded
# from rates. Precinct 22 (Central Park) has a negligible residential base and
# is likewise excluded; Midtown precincts 14/18 carry a daytime-population flag.
POP_2010 = {  # 2010 Census, mapped to 2020 precinct boundaries (Keefe crosswalk)
    1: 66679, 5: 52568, 6: 62226, 7: 56355, 9: 76443, 10: 50180, 13: 93640, 14: 20651, 17: 79126,
    18: 54066, 19: 208259, 20: 102624, 22: 25, 23: 73106, 24: 106460, 25: 47405, 26: 49508,
    28: 44781, 30: 60685, 32: 70942, 33: 76958, 34: 113062, 40: 91497, 41: 52246, 42: 79762,
    43: 172122, 44: 146441, 45: 120833, 46: 128200, 47: 152374, 48: 83266, 49: 114712, 50: 101720,
    52: 139307, 60: 104278, 61: 159645, 62: 181981, 63: 108646, 66: 191382, 67: 155252, 68: 124491,
    69: 84480, 70: 160664, 71: 98429, 72: 126230, 73: 86468, 75: 183328, 76: 43694, 77: 90744,
    78: 66664, 79: 90263, 81: 62722, 83: 112634, 84: 48196, 88: 51421, 90: 116836, 94: 56247,
    100: 47913, 101: 67065, 102: 144215, 103: 105803, 104: 170190, 105: 188582, 106: 122441,
    107: 151107, 108: 113200, 109: 247354, 110: 172634, 111: 116431, 112: 112070, 113: 120132,
    114: 202766, 115: 171576, 120: 113008, 121: 118708, 122: 138982, 123: 98032,
}

POP_2020 = {  # 2020 Census (Keefe census-by-precincts crosswalk)
    1: 84799, 5: 50598, 6: 64643, 7: 57985, 9: 75951, 10: 65570, 13: 100050, 14: 28050, 17: 89367,
    18: 67528, 19: 220261, 20: 114575, 22: 129, 23: 74769, 24: 107489, 25: 50996, 26: 50002,
    28: 49200, 30: 60456, 32: 81240, 33: 71598, 34: 108608, 40: 100929, 41: 54454, 42: 93755,
    43: 188015, 44: 150436, 45: 130799, 46: 132584, 47: 163539, 48: 89216, 49: 119881, 50: 106976,
    52: 146888, 60: 109024, 61: 169513, 62: 198870, 63: 112652, 66: 205377, 67: 162446, 68: 136071,
    69: 90763, 70: 164568, 71: 102000, 72: 133230, 73: 98506, 75: 200994, 76: 47789, 77: 101267,
    78: 73203, 79: 106039, 81: 68921, 83: 120747, 84: 65597, 88: 64372, 90: 131377, 94: 72748,
    100: 50809, 101: 73376, 102: 153297, 103: 121059, 104: 178948, 105: 199218, 106: 129391,
    107: 161402, 108: 137962, 109: 269581, 110: 181051, 111: 122211, 112: 119739, 113: 135221,
    114: 208525, 115: 179134, 120: 122308, 121: 128149, 122: 144552, 123: 100738,
}

PRECINCT_NEIGHBORHOODS = {
    1: "Tribeca, Wall St", 5: "Chinatown, Little Italy", 6: "Greenwich Village",
    7: "Lower East Side", 9: "East Village", 10: "Chelsea", 13: "Gramercy, Stuy Town",
    14: "Midtown South", 17: "Midtown East", 18: "Midtown North", 19: "Upper East Side",
    20: "Upper West Side", 22: "Central Park", 23: "East Harlem South", 24: "Morningside Heights",
    25: "East Harlem North", 26: "Manhattanville", 28: "Central Harlem", 30: "Hamilton Heights",
    32: "Central Harlem North", 33: "Washington Heights", 34: "Inwood, Wash. Heights",
    40: "Mott Haven", 41: "Hunts Point", 42: "Morrisania", 43: "Soundview", 44: "Highbridge",
    45: "Co-op City", 46: "Fordham", 47: "Wakefield", 48: "East Tremont", 49: "Pelham Parkway",
    50: "Riverdale", 52: "Bedford Park", 60: "Coney Island", 61: "Sheepshead Bay",
    62: "Bensonhurst", 63: "Flatlands", 66: "Borough Park", 67: "East Flatbush", 68: "Bay Ridge",
    69: "Canarsie", 70: "Flatbush", 71: "Crown Heights South", 72: "Sunset Park",
    73: "Brownsville", 75: "East New York", 76: "Red Hook", 77: "Crown Heights North",
    78: "Park Slope", 79: "Bed-Stuy West", 81: "Bed-Stuy East", 83: "Bushwick",
    84: "Brooklyn Heights, DUMBO", 88: "Fort Greene", 90: "Williamsburg", 94: "Greenpoint",
    100: "Rockaways", 101: "Far Rockaway", 102: "Richmond Hill", 103: "Jamaica",
    104: "Ridgewood, Maspeth", 105: "Queens Village", 106: "Ozone Park", 107: "Fresh Meadows",
    108: "Long Island City", 109: "Flushing", 110: "Elmhurst", 111: "Bayside", 112: "Forest Hills",
    113: "South Jamaica", 114: "Astoria", 115: "Jackson Heights", 120: "St. George",
    121: "Bulls Head", 122: "New Dorp", 123: "Tottenville",
}

# per-capita rates use residential population only; these precincts are unreliable
POP_RATE_EXCLUDE = {22, 116}   # 22 = Central Park (negligible residents); 116 = new 2024 precinct, no crosswalk
POP_DAYTIME_FLAG = {14, 18}    # Midtown: large daytime/commuter population inflates a residential rate


def population_for(pct, year):
    """Residential population estimate for a precinct in a given year.

    Anchored on the 2010 and 2020 decennial counts (same 2020 boundaries).
    Linearly interpolated for 2011-2020; held at the 2020 count for later years
    (no reliable annual precinct-level population exists after 2020)."""
    if pct not in POP_2020:
        return None
    p10, p20 = POP_2010[pct], POP_2020[pct]
    ey = min(year, 2020)
    return round(p10 + (p20 - p10) * (ey - 2010) / 10)


def canon(raw):
    return ALIASES.get(raw.strip().upper(), raw.strip().title())


def borough(pct):
    if 1 <= pct <= 34:
        return "Manhattan"
    if 40 <= pct <= 52:
        return "Bronx"
    if 60 <= pct <= 94:
        return "Brooklyn"
    if 100 <= pct <= 116:
        return "Queens"
    if 120 <= pct <= 123:
        return "Staten Island"
    return "Unknown"


LAWCAT = {"MISDEMEANOR": "M", "VIOLATION": "V", "M": "M", "V": "V"}
LAWCAT_IDX = {"M": 0, "V": 1}

# Precinct 483 is an invalid code (3 stray records) -> drop. (Precinct 116,
# operational since 2024 in SE Queens, is present in both data and boundaries.)
PCT_REMAP = {}
PCT_DROP = {483}


def load(name):
    return json.load(open(os.path.join(DATA, f"raw_{name}.json")))


def main():
    complaints = load("complaints")
    arrests = load("arrests")

    # Collect canonical offenses actually present, with their group
    offense_set = {}
    for rows in (complaints, arrests):
        for r in rows:
            label = canon(r["ofns"])
            grp = GROUP.get(label, "other")
            offense_set[label] = grp

    # stable order: group then label
    order = {"proactive": 0, "victim": 1, "other": 2}
    offenses = sorted(offense_set.items(), key=lambda kv: (order[kv[1]], kv[0]))
    offense_list = [{"label": l, "group": g} for l, g in offenses]
    oid = {l: i for i, (l, g) in enumerate(offenses)}

    max_year = max([r["yr"] for r in complaints] + [r["yr"] for r in arrests] + [2026])
    years = list(range(2015, max_year + 1))

    def pack(rows):
        agg = {}
        for r in rows:
            lc = LAWCAT.get(r["lawcat"])
            if lc is None:
                continue
            pct = r["pct"]
            if pct in PCT_DROP:
                continue
            pct = PCT_REMAP.get(pct, pct)
            key = (r["yr"], pct, oid[canon(r["ofns"])], LAWCAT_IDX[lc])
            agg[key] = agg.get(key, 0) + r["n"]
        return [[y, p, o, l, n] for (y, p, o, l), n in sorted(agg.items())]

    crows = pack(complaints)
    arows = pack(arrests)

    # precinct list (union) with borough
    pcts = sorted({r[1] for r in crows} | {r[1] for r in arows})
    precinct_meta = [{"pct": p, "boro": borough(p)} for p in pcts]

    # per-year population (varies by year) + neighborhoods, keyed by precinct
    populations = {p: [population_for(p, y) for y in years] for p in pcts}
    neighborhoods = {p: PRECINCT_NEIGHBORHOODS.get(p) for p in pcts}
    pop_meta = {
        "source": "U.S. Census 2010 & 2020, apportioned to 2020 NYPD precinct "
                  "boundaries (John Keefe, census-by-precincts).",
        "method": "Population varies by year: linear interpolation between the "
                  "2010 and 2020 counts for 2015-2020, held at the 2020 count for "
                  "2021 onward (no reliable annual precinct-level population exists "
                  "after 2020).",
        "unit": "incidents per 1,000 residents",
        "rateExclude": sorted(POP_RATE_EXCLUDE),
        "daytimeFlag": sorted(POP_DAYTIME_FLAG),
        "excludeNote": {
            "22": "Central Park — negligible residential population; no meaningful rate.",
            "116": "Operational since 2024; carved from the 105th, no census crosswalk yet.",
        },
    }

    # window / freshness: read data/meta.json (written by fetch_data.py) when
    # present so labels track the actual data; otherwise fall back to the years.
    meta = {}
    meta_path = os.path.join(DATA, "meta.json")
    if os.path.exists(meta_path):
        meta = json.load(open(meta_path))
    import datetime
    latest_year = max(years)
    window = {
        "start": meta.get("start", "2015-01-01"),
        "end": meta.get("data_through", f"{latest_year}-03-31"),
        "quarterLabel": meta.get("quarter_label", "Q1 2026"),
        "partial": meta.get("partial", True),
        "partialYear": meta.get("partial_year", latest_year),
        "note": meta.get(
            "note",
            "The final year is partial. Compare it against the same period in "
            "prior years, not against full years."),
    }

    data = {
        "generated": meta.get("generated", datetime.date.today().isoformat()),
        "window": window,
        "years": years,
        "lawcats": ["Misdemeanor", "Violation"],
        "groups": {
            "proactive": "Enforcement-sensitive (proactive)",
            "victim": "Complaint-driven (victim-reported)",
            "other": "Other / administrative / mixed",
        },
        "offenses": offense_list,
        "precincts": precinct_meta,
        "neighborhoods": neighborhoods,
        "populations": populations,
        "popMeta": pop_meta,
        "complaints": crows,
        "arrests": arows,
    }
    with open(os.path.join(DATA, "data.json"), "w") as f:
        json.dump(data, f, separators=(",", ":"))

    # transparency export
    with open(os.path.join(DATA, "classification.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["offense", "group", "complaints_2015_2026q1", "arrests_2015_2026q1"])
        ctot = {}
        atot = {}
        for r in crows:
            ctot[r[2]] = ctot.get(r[2], 0) + r[4]
        for r in arows:
            atot[r[2]] = atot.get(r[2], 0) + r[4]
        for i, o in enumerate(offense_list):
            w.writerow([o["label"], o["group"], ctot.get(i, 0), atot.get(i, 0)])

    # simplify geojson: topology-preserving simplify + round coords, attach borough.
    # Boundaries change rarely, and the raw geojson is gitignored, so skip this step
    # when it's absent (e.g. in CI) and keep the already-committed precincts.json.
    raw_geo = os.path.join(DATA, "precincts_raw.geojson")
    if os.path.exists(raw_geo):
        from shapely.geometry import shape, mapping
        g = json.load(open(raw_geo))

        def round_coords(c):
            if isinstance(c[0], (int, float)):
                return [round(c[0], 5), round(c[1], 5)]
            return [round_coords(x) for x in c]

        for feat in g["features"]:
            p = int(feat["properties"]["precinct"])
            feat["properties"] = {"pct": p, "boro": borough(p)}
            geom = shape(feat["geometry"]).simplify(0.0001, preserve_topology=True)
            feat["geometry"] = mapping(geom)
            feat["geometry"]["coordinates"] = round_coords(feat["geometry"]["coordinates"])
        with open(os.path.join(DATA, "precincts.json"), "w") as f:
            json.dump(g, f, separators=(",", ":"))
    else:
        print("  precincts_raw.geojson absent -> keeping existing precincts.json")

    # report
    cby = {"proactive": 0, "victim": 0, "other": 0}
    aby = {"proactive": 0, "victim": 0, "other": 0}
    for r in crows:
        cby[offense_list[r[2]]["group"]] += r[4]
    for r in arows:
        aby[offense_list[r[2]]["group"]] += r[4]
    print(f"offenses: {len(offense_list)}  precincts: {len(pcts)}")
    print(f"complaint rows: {len(crows):,}  arrest rows: {len(arows):,}")
    print(f"complaints by group: {cby}")
    print(f"arrests by group:    {aby}")
    print(f"data.json: {os.path.getsize(os.path.join(DATA,'data.json'))/1e6:.2f} MB")
    print(f"precincts.json: {os.path.getsize(os.path.join(DATA,'precincts.json'))/1e6:.2f} MB")


if __name__ == "__main__":
    main()
