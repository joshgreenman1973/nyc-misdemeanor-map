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

    years = list(range(2015, 2027))

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

    data = {
        "generated": "2026-05-21",
        "window": {"start": "2015-01-01", "end": "2026-03-31",
                   "note": "2026 is partial (Q1 only: Jan 1 - Mar 31). Compare 2026 against prior Q1s, not full years."},
        "years": years,
        "lawcats": ["Misdemeanor", "Violation"],
        "groups": {
            "proactive": "Enforcement-sensitive (proactive)",
            "victim": "Complaint-driven (victim-reported)",
            "other": "Other / administrative / mixed",
        },
        "offenses": offense_list,
        "precincts": precinct_meta,
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

    # simplify geojson: topology-preserving simplify + round coords, attach borough
    from shapely.geometry import shape, mapping
    g = json.load(open(os.path.join(DATA, "precincts_raw.geojson")))

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
