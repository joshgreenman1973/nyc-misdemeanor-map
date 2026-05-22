# NYC misdemeanors & violations map (2015 – Q1 2026)

An interactive, searchable precinct-level map of New York City's lowest-level offenses —
misdemeanors and violations — with two lenses (**complaints** = reported crime, **arrests** =
enforcement activity) and an enforcement-sensitivity breakout that separates proactively policed
offenses from victim-reported ones.

Features: precinct choropleth (incident count or enforcement-sensitive share), year slider with
play-through, offense search/filter, citywide trend by offense group, a reported-vs-enforced
comparison, borough trends, precinct ranking, and per-precinct drill-down.

## Data

All from [NYC Open Data](https://opendata.cityofnewyork.us/):

| Dataset | ID |
| --- | --- |
| NYPD Complaint Data Historic | `qgea-i56i` |
| NYPD Complaint Data Current (YTD) | `5uac-w243` |
| NYPD Arrests Data Historic | `8h9b-rp9u` |
| NYPD Arrest Data Year to Date | `uip8-fykc` |
| Police Precincts (boundaries) | `y76i-bdw7` |

Complaints dated by report date (`RPT_DT`); arrests by `ARREST_DATE`. Misdemeanor + violation only.
2026 is the first quarter (through March 31).

## Rebuild the data

```bash
python3 fetch_data.py    # pull aggregates from the NYPD datasets (no API key needed)
python3 build_data.py    # classify offenses, simplify boundaries, write data/*.json + classification.csv
```

## Run locally

```bash
python3 -m http.server 8129
# open http://localhost:8129
```

See [methodology.html](methodology.html) for the full method, the offense classification, and limitations.
