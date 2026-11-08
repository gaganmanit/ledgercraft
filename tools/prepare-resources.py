#!/usr/bin/env python3
"""Check, or explicitly fetch, pinned public resources without third-party packages.

No network request or file change occurs without --fetch. Publisher downloads are
local setup inputs, excluded from the public source checkout.
"""
import argparse
import hashlib
import html.parser
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MAX_DOWNLOAD = 64 * 1024 * 1024
MAX_XML = 16 * 1024 * 1024
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
GST_URL = "https://tutorial.gst.gov.in/offlineutilities/returns/gst_offline_tool.zip"
GST_SHA = "f0a7d6f66bf71b30e9ecd045a664dda428c8fac239f51127d656e6faac60e312"
HSN_URL = "https://tutorial.gst.gov.in/downloads/HSN_SAC.xlsx"
HSN_SHA = "051108e31063f1ef0d6dfb005a622bcc848878fa2d94fae51a73e67f8916871e"
HSN_JSON_SHA = "9ed862a9f011446bd974adf7ca51bfa44f9d4a9293f49b563ebe1c8043377538"
TEMPLATE = "GSTR1_Excel_Workbook_Template_V2.2.xlsx"
TEMPLATE_SHA = "425084547928a31eab53123b9247bad9ded1ee421fbc9202d009260e5d9b18e5"
INVOICE_URL = "https://help.tallysolutions.com/sample-xml/"
INVOICE_SHA = "78c57c039080889cd74cd6c980f338e2d53bee24972c07bb46e8fb0dd3930c4d"
INTEGRATION_URL = "https://help.tallysolutions.com/wp-content/uploads/2025/07/Integration_Demo_Samples.zip"
INTEGRATION_SHA = "0999ec4ebdf13f163e5df18cdfb410847f045d7a8b11ef34290c05f5e754a89f"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verified(data, expected, label):
    actual = sha256(data)
    if actual != expected:
        raise ValueError(f"{label}: SHA-256 differs (expected {expected}, got {actual}); no replacement was installed")
    return data


def atomic_write(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.is_symlink():
        raise ValueError(f"Refusing to replace a symbolic link: {file}")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=file.parent, prefix=".resource-", delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
        temporary.replace(file)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def fetch(url, expected, cache, name):
    cached = cache / name
    if expected and cached.is_file() and sha256(cached.read_bytes()) == expected:
        return cached.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": "Ledgercraft-resource-setup/1"})
    with urllib.request.urlopen(request, timeout=60) as response:
        if int(response.headers.get("Content-Length", "0")) > MAX_DOWNLOAD:
            raise ValueError(f"{url}: download exceeds 64 MiB")
        data = response.read(MAX_DOWNLOAD + 1)
    if len(data) > MAX_DOWNLOAD:
        raise ValueError(f"{url}: download exceeds 64 MiB")
    if expected:
        verified(data, expected, url)
        atomic_write(cached, data)
    return data


def zip_member(archive, name):
    matches = [entry for entry in archive.infolist() if entry.filename == name]
    if len(matches) != 1 or matches[0].file_size > MAX_XML:
        raise ValueError(f"Missing, repeated or oversized workbook member: {name}")
    return archive.read(matches[0])


def xml(data):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("XML entity/DTD declarations are not accepted")
    return ET.fromstring(data)


def hsn_json(data):
    """Reproduce the release dataset from its pinned, two-sheet GSTN workbook."""
    rows = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        strings = ["".join(node.itertext()) for node in xml(zip_member(archive, "xl/sharedStrings.xml"))]
        for number, service, expected_header in [(1, False, "HSN_CD"), (2, True, "SAC_CD")]:
            worksheet = xml(zip_member(archive, f"xl/worksheets/sheet{number}.xml"))
            source_rows = worksheet.findall("m:sheetData/m:row", NS)
            values = []
            for row in source_rows:
                fields = {}
                for cell in row.findall("m:c", NS):
                    # Read cached publisher values only; never execute formulas.
                    # Both the complete workbook and generated JSON are pinned.
                    text = cell.findtext("m:v", default="", namespaces=NS)
                    if cell.get("t") == "s":
                        text = strings[int(text)]
                    fields[re.sub(r"\d", "", cell.get("r", ""))] = text
                values.append(fields)
            if not values or values[0].get("A") != expected_header:
                raise ValueError("The pinned HSN worksheet headers changed")
            for fields in values[1:]:
                code = re.sub(r"\s+", "", fields.get("A", ""))
                if not code:
                    continue
                # Some numeric goods cells dropped the chapter's leading zero.
                # Restore the even 2/4/6/8-digit hierarchy used by this release.
                if not service and len(code) % 2:
                    code = "0" + code
                if not re.fullmatch(r"\d{2}|\d{4}|\d{6}|\d{8}", code):
                    raise ValueError("The HSN source has an unsupported code")
                description = re.sub(r"_x([0-9a-fA-F]{4})_", lambda match: chr(int(match[1], 16)), fields.get("B", ""))
                description = re.sub(r"\s+", " ", description).strip()
                rows.append([code, description, service])
    if len(rows) != 22616 or sum(row[2] for row in rows) != 681:
        raise ValueError("HSN/SAC row counts differ from the release dataset")
    dataset = {"source": HSN_URL, "asOf": "2026-11-08", "sourceLastModified": "2026-11-01", "sha256": HSN_SHA, "rows": rows}
    return verified(json.dumps(dataset, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), HSN_JSON_SHA, "Generated hsn-sac.json")


class HtmlText(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, text):
        self.parts.append(text)

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.parts.append("\n")


def invoice_xml(data):
    parser = HtmlText()
    parser.feed(data.decode("utf-8"))
    text = "".join(parser.parts).replace("\u201c", '"').replace("\u201d", '"').replace("\xa0", " ")
    for start in re.finditer(r"<ENVELOPE\b", text, re.IGNORECASE):
        end = re.search(r"</ENVELOPE\s*>", text[start.start():], re.IGNORECASE)
        if not end:
            continue
        try:
            tree = xml(text[start.start():start.start() + end.end()].encode("utf-8"))
        except (ET.ParseError, ValueError):
            continue
        for node in tree.iter():
            node.attrib = dict(sorted(node.attrib.items()))
            if node.text is not None:
                node.text = node.text.strip()
            node.tail = None
        output = ET.tostring(tree, encoding="utf-8", short_empty_elements=True) + b"\n"
        if sha256(output) == INVOICE_SHA:
            return output
    raise ValueError("The official invoice example no longer matches its pinned normalized XML; no fixture was installed")


def resources(include_tests):
    result = [
        {"path": "lib/resources/" + TEMPLATE, "sha256": TEMPLATE_SHA, "kind": "template"},
        {"path": "lib/resources/hsn-sac.json", "sha256": HSN_JSON_SHA, "kind": "hsn"},
    ]
    if include_tests:
        manifest = json.loads((ROOT / "test/fixtures/tally-xlsx/SOURCES.json").read_text())
        for entry in manifest["files"]:
            if (Path(entry["name"]).name != entry["name"] or not entry["name"].endswith(".zip")
                    or not entry["url"].startswith("https://help.tallysolutions.com/")
                    or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"])):
                raise ValueError("The Tally fixture manifest needs safe names, official HTTPS URLs and SHA-256 pins")
            result.append({"path": "test/fixtures/tally-xlsx/" + entry["name"], "sha256": entry["sha256"], "kind": "file", "url": entry["url"], "cache": entry["name"]})
        result += [
            {"path": "test/fixtures/tally/official/Integration_Demo_Samples.zip", "sha256": INTEGRATION_SHA, "kind": "file", "url": INTEGRATION_URL, "cache": "Integration_Demo_Samples.zip"},
            {"path": "test/fixtures/tally/official/TallyHelp-invoice-mode.xml", "sha256": INVOICE_SHA, "kind": "invoice"},
        ]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fetch", action="store_true", help="Explicitly download missing/different public resources, verify pins and install them locally")
    mode.add_argument("--check", action="store_true", help="Check local resources only (the default; no network or writes)")
    parser.add_argument("--tests", action="store_true", help="Also prepare/check official Tally test fixtures")
    parser.add_argument("--cache-dir", type=Path, default=Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "ledgercraft/resources", help="Verified public-download cache (outside the source checkout by default)")
    args = parser.parse_args()
    checked = []
    for item in resources(args.tests):
        target = ROOT / item["path"]
        actual = sha256(target.read_bytes()) if target.is_file() else None
        state = "verified" if actual == item["sha256"] else "missing" if actual is None else "different"
        if state != "verified" and args.fetch:
            if item["kind"] == "template":
                source = fetch(GST_URL, GST_SHA, args.cache_dir, "gst_offline_tool.zip")
                with zipfile.ZipFile(io.BytesIO(source)) as archive:
                    output = zip_member(archive, TEMPLATE)
            elif item["kind"] == "hsn":
                output = hsn_json(fetch(HSN_URL, HSN_SHA, args.cache_dir, "HSN_SAC.xlsx"))
            elif item["kind"] == "invoice":
                output = invoice_xml(fetch(INVOICE_URL, None, args.cache_dir, "TallyHelp-sample-xml.html"))
            else:
                output = fetch(item["url"], item["sha256"], args.cache_dir, item["cache"])
            atomic_write(target, verified(output, item["sha256"], item["path"]))
            state = "installed"
        checked.append({"path": item["path"], "state": state, "sha256": item["sha256"]})
    print(json.dumps({"networkAllowed": args.fetch, "testFixtures": args.tests, "resources": checked}, indent=2))
    if any(item["state"] in {"missing", "different"} for item in checked):
        print("Run python3 tools/prepare-resources.py --fetch" + (" --tests" if args.tests else "") + " to prepare the pinned public downloads.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
        print(f"Resource preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
