"""Classify anchor investors and summarise an anchor book.

The anchor list only gives names, so the category is inferred from the name.
It's approximate and labelled as such wherever it's shown - but "who" is the
point of reading an anchor book: domestic mutual funds and long-only names
read very differently from a book of one-off offshore funds.

Order matters: insurance first (ADITYA BIRLA SUN LIFE INSURANCE is not the
AMC), then offshore markers (ASHOKA WHITEOAK ICAV is not WhiteOak's Indian
MF), then AIF markers, then the domestic AMC brands.
"""
from __future__ import annotations

import re

INSURANCE = re.compile(r"INSURANCE|ASSURANCE|\bLIFE INS")
FOREIGN = re.compile(
    r"\bICAV\b|\bSICAV\b|\bPLC\b|\bPTE\b|\bLLC\b|\bL\.?P\.?$|\bLP\b|MAURITIUS|SINGAPORE|CAYMAN|"
    r"LUXEMBOURG|IRELAND|COLLECTIVE TRUST|MASTER FUND|EMERGING MARKET|\bGLOBAL\b|INTERNATIONAL|"
    r"BORDER TO COAST|GOVERNMENT OF|MONETARY AUTHORITY|ABU DHABI|\bASIA\b|SOCIETE GENERALE|"
    r"MORGAN STANLEY|GOLDMAN SACHS|BNP PARIBAS ARBITRAGE|CITIGROUP|NOMURA|JUPITER|EASTSPRING|"
    r"VANGUARD|BLACKROCK|FIDELITY|T\.? ?ROWE|ABERDEEN|NEUBERGER|MATTHEWS|COPTHALL|NEW WORLD FUND|"
    r"\bVCC\b|\bPCC\b|-ODI\b|\bODI\b|AMUNDI|\bSA\b|FUND LTD\.?$|ACORN FUND"
)
AIF = re.compile(r"\bAIF\b|SERIES\s+[IVX\d]+|CATEGORY\s+(I|II|III)\b|ALTERNATIVE|VENTURE|\bPMS\b|\bLLP\b")
MF_BRANDS = re.compile(
    r"^(NIPPON INDIA|ADITYA BIRLA SUN LIFE|HDFC|ICICI PRUDENTIAL|SBI|KOTAK|AXIS|UTI|DSP|MIRAE ASSET|"
    r"TATA|FRANKLIN|EDELWEISS|BANDHAN|CANARA ROBECO|SUNDARAM|QUANT\b|PGIM INDIA|MAHINDRA MANULIFE|"
    r"UNION|BARODA BNP PARIBAS|WHITEOAK CAPITAL|BAJAJ FINSERV|HSBC|MOTILAL OSWAL|INVESCO INDIA|360 ONE|"
    r"HELIOS|ITI|JM FINANCIAL|LIC MF|NAVI|NJ|OLD BRIDGE|SAMCO|SHRIRAM|TRUST MF|ZERODHA|GROWW|QUANTUM|"
    r"TAURUS|IDFC|L&T|PPFAS|PARAG PARIKH|UNIFI|CHOICE|ANGEL ONE|JIO BLACKROCK|CAPITALMIND|JM\b)"
)
MF_WORDS = re.compile(r"MUTUAL FUND|\bMF\b|\bFUND\b")
# Specialised investment funds (SIFs: long-short strategies) are launched by
# mutual funds under the MF regulations, often under a separate brand.
SIF = re.compile(r"LONG[- ]SHORT|\bSIF\b")

LABELS = {"mf": "Mutual fund / SIF", "insurance": "Insurance", "foreign": "Foreign (FPI)",
          "aif": "AIF", "other": "Other / unclassified"}


def classify(name: str) -> str:
    n = " ".join(name.upper().replace("–", "-").split())
    if INSURANCE.search(n):
        return "insurance"
    if FOREIGN.search(n):
        return "foreign"
    if AIF.search(n):
        return "aif"
    if SIF.search(n) or (MF_BRANDS.search(n) and MF_WORDS.search(n)):
        return "mf"
    return "other"


def summarise(anchor: dict | None) -> dict | None:
    """Adds a category to each investor and returns the book's headline numbers."""
    if not anchor or not anchor.get("investors"):
        return None
    inv = anchor["investors"]
    for i in inv:
        i["category"] = classify(i["name"])
    total = anchor.get("total_amount_cr") or sum(i["amount_cr"] or 0 for i in inv)
    if not total:
        return None
    by_cat: dict[str, float] = {}
    for i in inv:
        by_cat[i["category"]] = by_cat.get(i["category"], 0) + (i["amount_cr"] or 0)
    top5 = sum(sorted((i["amount_cr"] or 0 for i in inv), reverse=True)[:5])
    return {
        "total_cr": round(total, 2),
        "investors": len(inv),
        "top5_pct": round(top5 / total * 100, 1),
        "by_category_pct": {k: round(v / total * 100, 1) for k, v in sorted(by_cat.items(), key=lambda x: -x[1])},
        "mf_pct": round(by_cat.get("mf", 0) / total * 100, 1),
    }
