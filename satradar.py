#!/usr/bin/env python3
"""
SatRadar - data builder and command-line report.

Data source: CelesTrak (https://celestrak.org), GP orbital elements in the
OMM-based CSV format and the SATCAT CSV. CSV/OMM is used instead of TLE because
new objects (catalog number >= 100000) are not available as TLEs.

Usage:
  python satradar.py build            # download (politely) + write site/data/*.json
  python satradar.py report           # print live analysis from the last build
  python satradar.py build --offline  # rebuild site data from the local cache only

CelesTrak usage policy (https://celestrak.org/usage-policy.php), respected here:
  * one download attempt per file per run, no retries
  * any non-200 response stops the download step and falls back to the cache
  * GP data at most every 2 hours, SATCAT at most once per ~20 hours
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, "cache")
SITE_DATA = os.path.join(ROOT, "site", "data")

GP_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv"
GP_ONE_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR={catnr}&FORMAT=csv"
SATCAT_URL = "https://celestrak.org/pub/satcat.csv"
USER_AGENT = "SatRadar/1.0 (+https://github.com/jarunprasath/sat-radar)"

GP_MIN_AGE_S = 2 * 3600 - 15 * 60  # ~2 h; 15 min slack for GitHub's cron start jitter
SATCAT_MIN_AGE_S = 20 * 3600
N_OLDEST = 15

GP_REQUIRED = ["OBJECT_NAME", "OBJECT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY",
               "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY",
               "NORAD_CAT_ID", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT"]
SATCAT_REQUIRED = ["OBJECT_NAME", "OBJECT_ID", "NORAD_CAT_ID", "OBJECT_TYPE",
                   "OWNER", "LAUNCH_DATE", "DECAY_DATE"]

# Compact row layout shared with site/core.js - keep both in sync.
FIELDS = ["name", "norad", "cospar", "epoch", "mm", "ecc", "inc", "raan", "argp",
          "ma", "bstar", "ndot", "nddot", "launch", "owner", "type", "active"]


class FetchError(RuntimeError):
    pass


def log(msg: str) -> None:
    print(f"[satradar] {msg}", flush=True)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- IO
def fetch(url: str, timeout: int = 120) -> str:
    """Single polite GET. Raises FetchError on anything other than HTTP 200."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                raise FetchError(f"HTTP {resp.status} for {url}")
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        raise FetchError(f"HTTP {e.code} for {url}: {body.strip()}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise FetchError(f"Network error for {url}: {e}") from None


def read_json(path: str, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path: str, obj, compact: bool = True) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
        else:
            json.dump(obj, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def parse_csv(text: str, required: list[str], what: str) -> list[dict]:
    text = text.lstrip("﻿")
    reader = csv.DictReader(io.StringIO(text))
    cols = reader.fieldnames or []
    missing = [c for c in required if c not in cols]
    if missing:
        snippet = text[:200].replace("\n", " | ")
        raise FetchError(f"{what}: unexpected format, missing columns {missing}. Start: {snippet}")
    return [row for row in reader]


def age_s(ts_iso: str | None) -> float:
    if not ts_iso:
        return float("inf")
    try:
        return (now_utc() - datetime.fromisoformat(ts_iso)).total_seconds()
    except ValueError:
        return float("inf")


# --------------------------------------------------------------- download step
def refresh_cache(force: bool = False) -> list[str]:
    """Update cache/ from CelesTrak where it is stale. Returns warnings."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    warnings: list[str] = []

    # 1) GP elements for the 'active' group
    gp_cache = read_json(os.path.join(CACHE_DIR, "gp_active.json"), {})
    if force or age_s(gp_cache.get("fetched_at")) > GP_MIN_AGE_S:
        try:
            log("downloading GP data (GROUP=active, CSV) ...")
            rows = parse_csv(fetch(GP_URL), GP_REQUIRED, "GP")
            if len(rows) < 1000:
                raise FetchError(f"GP: only {len(rows)} rows - refusing to overwrite cache")
            write_json(os.path.join(CACHE_DIR, "gp_active.json"),
                       {"fetched_at": now_utc().isoformat(), "rows": rows})
            log(f"GP: {len(rows)} objects")
        except FetchError as e:
            warnings.append(str(e))
            log(f"WARNING: {e} - using cached GP data")
            return warnings  # stop all further requests after an error (policy)
    else:
        log("GP cache is fresh, not downloading")

    # 2) SATCAT (launch dates, owners) - at most ~daily
    sc_cache = read_json(os.path.join(CACHE_DIR, "satcat_slim.json"), {})
    if force or age_s(sc_cache.get("fetched_at")) > SATCAT_MIN_AGE_S:
        try:
            log("downloading SATCAT CSV ...")
            rows = parse_csv(fetch(SATCAT_URL, timeout=300), SATCAT_REQUIRED, "SATCAT")
            slim = {}
            oldest_candidates = []
            for r in rows:
                if r.get("DECAY_DATE"):
                    continue  # decayed - not in orbit any more
                n = r["NORAD_CAT_ID"].strip()
                slim[n] = [r.get("LAUNCH_DATE", ""), r.get("OWNER", ""), r.get("OBJECT_TYPE", "")]
                if (r.get("OBJECT_TYPE") == "PAY" and r.get("ORBIT_CENTER", "EA") == "EA"
                        and r.get("ORBIT_TYPE", "ORB") == "ORB"
                        and not r.get("DATA_STATUS_CODE") and r.get("LAUNCH_DATE")):
                    oldest_candidates.append((r["LAUNCH_DATE"], n))
            oldest_candidates.sort()
            oldest_ids = [n for _, n in oldest_candidates[:N_OLDEST]]
            sc_cache = {"fetched_at": now_utc().isoformat(), "objects": slim,
                        "oldest_ids": oldest_ids}
            write_json(os.path.join(CACHE_DIR, "satcat_slim.json"), sc_cache)
            log(f"SATCAT: {len(slim)} on-orbit objects, oldest payload ids {oldest_ids[:5]}...")
        except FetchError as e:
            warnings.append(str(e))
            log(f"WARNING: {e} - using cached SATCAT")
            return warnings

        # 3) elements for the oldest on-orbit payloads (most are dead, so not in 'active')
        gp = read_json(os.path.join(CACHE_DIR, "gp_active.json"), {})
        active_ids = {r["NORAD_CAT_ID"].strip() for r in gp.get("rows", [])}
        extras = []
        for n in sc_cache.get("oldest_ids", []):
            if n in active_ids:
                continue
            try:
                rows = parse_csv(fetch(GP_ONE_URL.format(catnr=n)), GP_REQUIRED, f"GP {n}")
                extras.extend(rows[:1])
                time.sleep(1.0)
            except FetchError as e:
                warnings.append(str(e))
                log(f"WARNING: {e} - stopping extra downloads")
                break
        if extras:
            write_json(os.path.join(CACHE_DIR, "gp_extras.json"),
                       {"fetched_at": now_utc().isoformat(), "rows": extras})
            log(f"extras: {len(extras)} oldest-payload element sets")
    else:
        log("SATCAT cache is fresh, not downloading")
    return warnings


# ------------------------------------------------------------------ build step
def _num(v: str) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def to_row(r: dict, meta: dict, active: int) -> list:
    n = r["NORAD_CAT_ID"].strip()
    launch, owner, otype = meta.get(n, ["", "", ""])
    return [r["OBJECT_NAME"].strip(), int(n), r["OBJECT_ID"].strip(), r["EPOCH"].strip(),
            _num(r["MEAN_MOTION"]), _num(r["ECCENTRICITY"]), _num(r["INCLINATION"]),
            _num(r["RA_OF_ASC_NODE"]), _num(r["ARG_OF_PERICENTER"]), _num(r["MEAN_ANOMALY"]),
            _num(r["BSTAR"]), _num(r["MEAN_MOTION_DOT"]), _num(r["MEAN_MOTION_DDOT"]),
            launch, owner, otype or "PAY", active]


def build_site_data(warnings: list[str]) -> dict:
    gp = read_json(os.path.join(CACHE_DIR, "gp_active.json"), {})
    if not gp.get("rows"):
        raise SystemExit("No GP data in cache - cannot build. (First download must succeed.)")
    sc = read_json(os.path.join(CACHE_DIR, "satcat_slim.json"), {})
    meta = sc.get("objects", {})
    ex = read_json(os.path.join(CACHE_DIR, "gp_extras.json"), {})

    rows, seen = [], set()
    for r in gp["rows"]:
        n = r["NORAD_CAT_ID"].strip()
        if n in seen:
            continue
        seen.add(n)
        rows.append(to_row(r, meta, 1))
    for r in ex.get("rows", []):
        n = r["NORAD_CAT_ID"].strip()
        if n in seen:
            continue
        seen.add(n)
        rows.append(to_row(r, meta, 0))

    data = {
        "generated": now_utc().isoformat(timespec="seconds"),
        "gp_fetched": gp.get("fetched_at"),
        "satcat_fetched": sc.get("fetched_at"),
        "source": "CelesTrak GP (OMM CSV) + SATCAT - https://celestrak.org",
        "warnings": warnings,
        "fields": FIELDS,
        "oldest_ids": [int(x) for x in sc.get("oldest_ids", [])],
        "sats": rows,
    }
    write_json(os.path.join(SITE_DATA, "sats.json"), data)
    log(f"wrote site/data/sats.json ({len(rows)} objects)")
    return data


# --------------------------------------------------------------- analysis step
def gmst_rad(jd_ut1: float) -> float:
    """IAU-82 Greenwich mean sidereal time (same model SGP4 libraries use)."""
    t = (jd_ut1 - 2451545.0) / 36525.0
    s = (-6.2e-6 * t ** 3 + 0.093104 * t ** 2
         + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841)
    return (s % 86400.0) / 86400.0 * 2 * math.pi


def analyse(data: dict, when: datetime | None = None, top: int = 10) -> dict:
    import numpy as np
    from sgp4 import omm
    from sgp4.api import Satrec, SatrecArray, jday

    when = when or now_utc()
    fields = data["fields"]
    ix = {f: i for i, f in enumerate(fields)}
    sats, info = [], []
    for row in data["sats"]:
        rec = {"OBJECT_NAME": row[ix["name"]], "OBJECT_ID": row[ix["cospar"]],
               "EPOCH": row[ix["epoch"]], "MEAN_MOTION": str(row[ix["mm"]]),
               "ECCENTRICITY": str(row[ix["ecc"]]), "INCLINATION": str(row[ix["inc"]]),
               "RA_OF_ASC_NODE": str(row[ix["raan"]]), "ARG_OF_PERICENTER": str(row[ix["argp"]]),
               "MEAN_ANOMALY": str(row[ix["ma"]]), "EPHEMERIS_TYPE": "0",
               "CLASSIFICATION_TYPE": "U", "NORAD_CAT_ID": str(row[ix["norad"]]),
               "ELEMENT_SET_NO": "999", "REV_AT_EPOCH": "0", "BSTAR": str(row[ix["bstar"]]),
               "MEAN_MOTION_DOT": str(row[ix["ndot"]]), "MEAN_MOTION_DDOT": str(row[ix["nddot"]])}
        try:
            s = Satrec()
            omm.initialize(s, rec)
        except Exception:
            continue
        sats.append(s)
        info.append(row)

    dt = 10.0
    jd0, fr0 = jday(when.year, when.month, when.day, when.hour, when.minute,
                    when.second + when.microsecond / 1e6)
    jd = np.array([jd0, jd0]); fr = np.array([fr0, fr0 + dt / 86400.0])
    e, r, v = SatrecArray(sats).sgp4(jd, fr)
    ok = (e[:, 0] == 0) & (e[:, 1] == 0) & np.isfinite(r).all(axis=(1, 2))
    r0, r1, v0 = r[:, 0, :], r[:, 1, :], v[:, 0, :]

    def subpoint(rr, jdd):
        g = gmst_rad(jdd)
        lon = np.arctan2(rr[:, 1], rr[:, 0]) - g
        lon = (lon + np.pi) % (2 * np.pi) - np.pi
        lat = np.arctan2(rr[:, 2], np.hypot(rr[:, 0], rr[:, 1]))
        return lat, lon

    lat0, lon0 = subpoint(r0, jd0 + fr0)
    lat1, lon1 = subpoint(r1, jd0 + fr0 + dt / 86400.0)
    h = (np.sin((lat1 - lat0) / 2) ** 2
         + np.cos(lat0) * np.cos(lat1) * np.sin((lon1 - lon0) / 2) ** 2)
    ground_kmh = 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(h, 0, 1))) / dt * 3600
    alt = np.linalg.norm(r0, axis=1) - 6371.0
    speed_kms = np.linalg.norm(v0, axis=1)

    def describe(i):
        row = info[i]
        return {"name": row[ix["name"]], "norad": row[ix["norad"]],
                "cospar": row[ix["cospar"]], "launch": row[ix["launch"]],
                "alt_km": round(float(alt[i]), 1),
                "ground_kmh": round(float(ground_kmh[i]), 1),
                "speed_kms": round(float(speed_kms[i]), 3)}

    idx = np.where(ok)[0]

    # closest pairs via a 3-D grid (cell = 50 km); only pairs < 50 km are considered
    cell = 50.0
    grid: dict[tuple, list[int]] = {}
    for i in idx:
        key = tuple((r0[i] // cell).astype(int))
        grid.setdefault(key, []).append(int(i))
    pairs = []
    offs = [(a, b, c) for a in (-1, 0, 1) for b in (-1, 0, 1) for c in (-1, 0, 1)]
    for key, members in grid.items():
        for o in offs:
            nb = grid.get((key[0] + o[0], key[1] + o[1], key[2] + o[2]))
            if not nb:
                continue
            for i in members:
                for j in nb:
                    if j <= i:
                        continue
                    d = float(np.linalg.norm(r0[i] - r0[j]))
                    if d < cell:
                        pairs.append((d, i, j))
    pairs.sort()

    def launch_of(i):
        c = info[i][ix["cospar"]]
        return c[:8] if c else ""

    closest = [{"km": round(d, 2), "a": describe(i), "b": describe(j),
                "same_launch": bool(launch_of(i) and launch_of(i) == launch_of(j))}
               for d, i, j in pairs[: top * 5]]

    slow = sorted(idx, key=lambda i: ground_kmh[i])[:top]
    dated = [i for i in idx if info[i][ix["launch"]]]
    oldest = sorted(dated, key=lambda i: info[i][ix["launch"]])[:top]
    newest = sorted(dated, key=lambda i: info[i][ix["launch"]], reverse=True)[:top]

    return {"time": when.isoformat(timespec="seconds"), "count": int(len(idx)),
            "closest_pairs": closest,
            "slowest_over_ground": [describe(i) for i in slow],
            "oldest": [describe(i) for i in oldest],
            "newest": [describe(i) for i in newest]}


def print_report(rep: dict, top: int) -> None:
    print(f"\nSatRadar report @ {rep['time']} UTC - {rep['count']} objects propagated\n")
    print("Closest pairs right now (different launches first):")
    diff = [p for p in rep["closest_pairs"] if not p["same_launch"]][:top]
    for p in diff:
        print(f"  {p['km']:8.2f} km  {p['a']['name']} <-> {p['b']['name']}")
    print("\nSlowest over the ground (GEO satellites look 'parked'):")
    for s in rep["slowest_over_ground"][:top]:
        print(f"  {s['ground_kmh']:9.1f} km/h  alt {s['alt_km']:8.0f} km  {s['name']}")
    print("\nOldest launched (in this data set):")
    for s in rep["oldest"][:top]:
        print(f"  {s['launch']}  {s['name']} ({s['norad']})")
    print("\nNewest launched:")
    for s in rep["newest"][:top]:
        print(f"  {s['launch']}  {s['name']} ({s['norad']})")
    print("\nNote: SGP4/GP accuracy is roughly km-level; distances are indicative, "
          "not conjunction assessments.")


# ------------------------------------------------------------------------ main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="download (if stale) and write site/data")
    b.add_argument("--offline", action="store_true", help="do not download, use cache only")
    b.add_argument("--force", action="store_true", help="ignore cache age (use sparingly)")
    rp = sub.add_parser("report", help="print an analysis of the current sky")
    rp.add_argument("--top", type=int, default=10)
    args = ap.parse_args(argv)

    if args.cmd == "build":
        warnings = [] if args.offline else refresh_cache(force=args.force)
        if os.environ.get("GITHUB_ACTIONS"):
            for w in warnings:  # show in the GitHub Actions run summary
                print(f"::warning::{w}")
        data = build_site_data(warnings)
        rep = analyse(data, top=15)
        write_json(os.path.join(SITE_DATA, "report.json"), rep)
        log("wrote site/data/report.json")
        print_report(rep, 5)
        return 0
    if args.cmd == "report":
        data = read_json(os.path.join(SITE_DATA, "sats.json"))
        if not data:
            print("No site/data/sats.json yet - run: python satradar.py build", file=sys.stderr)
            return 1
        print_report(analyse(data, top=args.top), args.top)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
