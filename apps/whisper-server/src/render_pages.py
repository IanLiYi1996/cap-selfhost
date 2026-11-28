"""Page images and per-page text for meeting materials.

Office files go through LibreOffice to PDF first, so a Word document gets real
page numbers and a deck one page per slide; every page is then rendered to a
JPEG the Q&A model can look at, and its text layer read with PyMuPDF.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

INDEX_VERSION = 1
MAX_PAGES = 500
OUTPUT_WIDTH = 1280
MAX_ZOOM = 4.0
JPEG_QUALITY = 80
CONVERT_TIMEOUT_SECONDS = 600

OFFICE_EXTENSIONS = {".docx", ".pptx", ".xlsx", ".doc", ".ppt", ".xls"}


def page_key(prefix: str, number: int) -> str:
    return f"{prefix.rstrip('/')}/{number:04d}.jpg"


def zoom_for(width_points: float) -> float:
    if width_points <= 0:
        return 1.0
    return max(0.5, min(MAX_ZOOM, OUTPUT_WIDTH / width_points))


def convert_to_pdf(path: str, workdir: str) -> str:
    # A private profile directory: LibreOffice refuses to start when the
    # default one is missing or locked, and the task's home is not writable.
    profile = f"file://{os.path.join(workdir, 'lo-profile')}"
    subprocess.run(
        [
            "soffice",
            f"-env:UserInstallation={profile}",
            "--headless",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            workdir,
            path,
        ],
        check=True,
        timeout=CONVERT_TIMEOUT_SECONDS,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    pdf = os.path.join(workdir, os.path.splitext(os.path.basename(path))[0] + ".pdf")
    if not os.path.exists(pdf):
        raise RuntimeError("LibreOffice produced no PDF")
    return pdf


def render(pdf_path: str, max_pages: int = MAX_PAGES):
    """Yield (number, jpeg_bytes, width, height, text) for each page, 1-based."""
    import pymupdf

    with pymupdf.open(pdf_path) as document:
        total = document.page_count
        for index in range(min(total, max_pages)):
            page = document.load_page(index)
            zoom = zoom_for(page.rect.width)
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            text = page.get_text("text").strip()
            yield (
                index + 1,
                pixmap.tobytes("jpeg", jpg_quality=JPEG_QUALITY),
                pixmap.width,
                pixmap.height,
                text,
            )


def page_count(pdf_path: str) -> int:
    import pymupdf

    with pymupdf.open(pdf_path) as document:
        return document.page_count


def run(s3, bucket: str, input_key: str, output_key: str, pages_prefix: str) -> dict:
    extension = os.path.splitext(input_key)[1].lower()
    with tempfile.TemporaryDirectory() as workdir:
        source = os.path.join(workdir, f"source{extension}")
        s3.download_file(bucket, input_key, source)
        pdf = convert_to_pdf(source, workdir) if extension in OFFICE_EXTENSIONS else source

        total = page_count(pdf)
        pages: list[dict] = []

        def upload(item) -> dict:
            number, jpeg, width, height, text = item
            key = page_key(pages_prefix, number)
            s3.put_object(Bucket=bucket, Key=key, Body=jpeg, ContentType="image/jpeg")
            return {"n": number, "key": key, "width": width, "height": height, "text": text}

        with ThreadPoolExecutor(max_workers=8) as pool:
            pages = list(pool.map(upload, render(pdf)))

    index = {
        "version": INDEX_VERSION,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "pageCount": total,
        "pages": sorted(pages, key=lambda page: page["n"]),
    }
    # Written last: its presence tells the web app the pages are all there.
    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=json.dumps(index, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    return index
