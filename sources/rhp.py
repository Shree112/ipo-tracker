"""The red herring prospectus, as searchable text for the "Ask the prospectus" chat.

The RHP link on an issue is either the PDF itself or SEBI's filing page, which
wraps the PDF in a viewer. Either way we find the PDF, download it (capped),
pull the text page by page with PyMuPDF, and cut it into overlapping chunks
that keep their page number. Postgres full-text search then finds the few
chunks relevant to a question - no embeddings, no extra model, no bill.

Robots rules are checked for every host we read from.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import unquote, urljoin

import requests

import config
from .chatter import robots_allowed

MAX_BYTES = 80 * 1024 * 1024
CHUNK = 1400
OVERLAP = 200
_PDF_IN_PAGE = re.compile(r"""(?:file=|src=|href=)["']?([^"'\s>]+?\.pdf)""", re.I)


class RhpError(RuntimeError):
    pass


def _get(url: str, stream: bool = False) -> requests.Response:
    r = requests.get(url, headers={"User-Agent": config.USER_AGENT}, timeout=60, stream=stream, allow_redirects=True)
    r.raise_for_status()
    return r


def pdf_url(url: str) -> str:
    """Follow a SEBI-style filing page to the PDF it shows."""
    if url.lower().split("?")[0].endswith(".pdf"):
        return url
    if not robots_allowed(url):
        raise RhpError(f"robots.txt disallows {url}")
    page = _get(url)
    if "pdf" in page.headers.get("content-type", ""):
        return url
    for m in _PDF_IN_PAGE.finditer(page.text):
        cand = unquote(m.group(1))
        if "?file=" in cand:
            cand = cand.split("?file=", 1)[1]
        return urljoin(url, cand)
    raise RhpError("no PDF link found on the filing page")


def download(url: str) -> bytes:
    if not robots_allowed(url):
        raise RhpError(f"robots.txt disallows {url}")
    r = _get(url, stream=True)
    size = int(r.headers.get("content-length") or 0)
    if size > MAX_BYTES:
        raise RhpError(f"PDF is {size / 1e6:.0f} MB, over the {MAX_BYTES / 1e6:.0f} MB cap")
    buf = bytearray()
    for part in r.iter_content(1 << 16):
        buf += part
        if len(buf) > MAX_BYTES:
            raise RhpError("PDF over the size cap")
    if not bytes(buf[:5]).startswith(b"%PDF"):
        raise RhpError("the link did not return a PDF")
    return bytes(buf)


def chunks(pdf: bytes) -> tuple[int, list[dict[str, Any]]]:
    """-> (page count, [{page, content}])"""
    import pymupdf  # imported here so the rest of the pipeline doesn't need it

    doc = pymupdf.open(stream=pdf, filetype="pdf")
    out: list[dict[str, Any]] = []
    for pno in range(doc.page_count):
        text = re.sub(r"[ \t]+", " ", doc[pno].get_text("text") or "")
        text = re.sub(r"\n{2,}", "\n", text).strip()
        if len(text) < 80:  # cover pages, blank pages, charts with no text
            continue
        start = 0
        while start < len(text):
            piece = text[start:start + CHUNK]
            out.append({"page": pno + 1, "content": piece})
            if start + CHUNK >= len(text):
                break
            start += CHUNK - OVERLAP
    return doc.page_count, out
