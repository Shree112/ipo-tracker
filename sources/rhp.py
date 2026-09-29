"""The red herring prospectus, as searchable text for the "Ask the prospectus" chat.

The RHP link on an issue is the PDF itself, SEBI's filing page (which wraps the
PDF in a viewer) or an NSE archive (a .zip holding the PDF). Either way we find
the PDF, download it (capped, resuming if the connection drops),
pull the text page by page with PyMuPDF, and cut it into overlapping chunks
that keep their page number. Postgres full-text search then finds the few
chunks relevant to a question - no embeddings, no extra model, no bill.

Robots rules are checked for every host we read from.
"""
from __future__ import annotations

import io
import re
import time
import zipfile
from typing import Any
from urllib.parse import unquote, urljoin

import requests

import config
from .chatter import robots_allowed

MAX_BYTES = 80 * 1024 * 1024
MAX_PDF_IN_ZIP = 150 * 1024 * 1024
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
    if url.lower().split("?")[0].endswith((".pdf", ".zip")):
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


def download(url: str, attempts: int = 4) -> bytes:
    """The file at url (a PDF, or a zip holding one) -> the PDF's bytes.

    Big prospectuses come off slow government and exchange servers that often
    drop the connection part-way; each retry asks for the rest of the file
    (an HTTP Range request) instead of starting over."""
    if not robots_allowed(url):
        raise RhpError(f"robots.txt disallows {url}")
    buf = bytearray()
    for attempt in range(1, attempts + 1):
        headers = {"User-Agent": config.USER_AGENT}
        if buf:
            headers["Range"] = f"bytes={len(buf)}-"
        try:
            r = requests.get(url, headers=headers, timeout=(15, 60), stream=True, allow_redirects=True)
            if r.status_code in (401, 403):
                raise RhpError(f"the server refused the download ({r.status_code})")
            r.raise_for_status()
            if buf and r.status_code != 206:  # server ignored the Range: start again
                buf = bytearray()
            size = int(r.headers.get("content-length") or 0) + len(buf)
            if size > MAX_BYTES:
                raise RhpError(f"file is {size / 1e6:.0f} MB, over the {MAX_BYTES / 1e6:.0f} MB cap")
            for part in r.iter_content(1 << 16):
                buf += part
                if len(buf) > MAX_BYTES:
                    raise RhpError("file over the size cap")
            break
        except (requests.exceptions.ChunkedEncodingError, requests.exceptions.ConnectionError,
                requests.exceptions.Timeout) as exc:
            if attempt == attempts:
                raise RhpError(f"download kept failing ({len(buf) / 1e6:.1f} MB received): {type(exc).__name__}") from exc
            time.sleep(3 * attempt)
    return _pdf_bytes(bytes(buf))


def _pdf_bytes(data: bytes) -> bytes:
    if data[:5].startswith(b"%PDF"):
        return data
    if data[:2] == b"PK":
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise RhpError("the archive is damaged") from exc
        pdfs = [m for m in zf.infolist() if m.filename.lower().endswith(".pdf") and not m.is_dir()]
        if not pdfs:
            raise RhpError("the archive has no PDF in it")
        best = max(pdfs, key=lambda m: m.file_size)  # the RHP itself, not a cover letter
        if best.file_size > MAX_PDF_IN_ZIP:
            raise RhpError(f"PDF in the archive is {best.file_size / 1e6:.0f} MB, over the cap")
        out = zf.read(best)
        if out[:5].startswith(b"%PDF"):
            return out
        raise RhpError("the file in the archive is not a PDF")
    raise RhpError("the link did not return a PDF")


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
