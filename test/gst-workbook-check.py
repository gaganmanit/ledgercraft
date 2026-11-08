import datetime
from decimal import Decimal
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
import re
import sys
import warnings
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import openpyxl

warnings.filterwarnings("ignore", message="Data Validation extension is not supported")
output, template, manifest_path, expected_path = map(Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text())
expected = json.loads(expected_path.read_text())
columns = json.loads((manifest_path.parent / "gstr1-columns.json").read_text())
workbook = openpyxl.load_workbook(output, data_only=False, read_only=True)
cached = openpyxl.load_workbook(output, data_only=True, read_only=True)
assert workbook.sheetnames == [sheet["name"] for sheet in manifest["sheets"]]
assert len(workbook._external_links) == 0
assert cached["master"].sheet_state == "hidden"

ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with ZipFile(template) as original, ZipFile(output) as generated:
    assert original.read("xl/worksheets/sheet32.xml") == generated.read("xl/worksheets/sheet32.xml")
    assert hashlib.sha256(generated.read("xl/worksheets/sheet32.xml")).hexdigest() == manifest["masterXmlSHA256"]
    assert not any("externalLinks/" in name for name in generated.namelist())
    assert "xl/calcChain.xml" not in generated.namelist()
    for name in generated.namelist():
        if name.endswith(".rels"):
            relationships = ET.fromstring(generated.read(name))
            assert all(rel.attrib.get("TargetMode") != "External" for rel in relationships)
    workbook_xml = ET.fromstring(generated.read("xl/workbook.xml"))
    for name in workbook_xml.findall("m:definedNames/m:definedName", ns):
        assert not re.search(r"\[\d+\]", name.text or "")
    strings = ["".join(item.itertext()) for item in ET.fromstring(original.read("xl/sharedStrings.xml"))]
    for sheet in manifest["sheets"]:
        if sheet["name"] in ["master", "Help Instruction"]:
            continue
        reference_headers = []
        with original.open(sheet["path"]) as source:
            for event, row in ET.iterparse(source, events=("end",)):
                if row.tag.rsplit("}", 1)[-1] != "row":
                    continue
                if int(row.attrib["r"]) == 4:
                    for cell in row:
                        value = cell.find("m:v", ns)
                        if value is not None:
                            reference_headers.append(strings[int(value.text)] if cell.attrib.get("t") == "s" else value.text)
                    break
        actual_headers = [cell.value for row in workbook[sheet["name"]].iter_rows(min_row=4, max_row=4, max_col=len(reference_headers)) for cell in row]
        assert actual_headers == reference_headers, (sheet["name"], actual_headers, reference_headers)

numeric_headers = {
    "Invoice Value", "Taxable Value", "Cess Amount", "Note Value", "Total Value", "Integrated Tax Amount",
    "Central Tax Amount", "State/UT Tax Amount", "Nil Rated Supplies", "Exempted(other than nil rated/non GST supply)",
    "Non-GST Supplies", "Rate", "Applicable % of Tax Rate", "Total Quantity", "Total Number", "Cancelled",
}
normalize = lambda text: re.sub(r"\s+", "", text).lower()
for sheet_name, rows in expected["report"]["sheets"].items():
    if not rows:
        continue
    sheet = workbook[sheet_name]
    headers = [cell.value for row in sheet.iter_rows(min_row=4, max_row=4, max_col=len(columns[sheet_name])) for cell in row]
    source_indexes = {normalize(header): index for index, header in enumerate(columns[sheet_name])}
    for number, source_row in enumerate(rows, start=5):
        for column, header in enumerate(headers, start=1):
            cell = sheet.cell(number, column)
            value = source_row[source_indexes[normalize(header)]]
            if value == "" or value is None:
                assert cell.value is None, (sheet_name, cell.coordinate, cell.value)
            elif re.search(r"\bdate$", header, re.I):
                text = str(value)
                wanted = datetime.datetime.strptime(text, "%Y-%m-%d" if re.match(r"\d{4}-", text) else "%d-%b-%Y" if len(text.rsplit("-", 1)[-1]) == 4 else "%d-%b-%y")
                assert cell.data_type == "d" and cell.value == wanted, (sheet_name, cell.coordinate, cell.value, wanted)
            elif header in numeric_headers:
                assert cell.data_type == "n", (sheet_name, cell.coordinate, cell.data_type)
                assert Decimal(str(cell.value)) == Decimal(str(value)), (sheet_name, cell.coordinate, cell.value, value)
            else:
                assert cell.data_type == "s" and cell.value == str(value), (sheet_name, cell.coordinate, cell.value, value)

for check in expected["cached"]:
    formula = workbook[check["sheet"]][check["cell"]].value
    assert isinstance(formula, str) and formula.startswith("="), (check, formula)
    if "formulaContains" in check:
        assert check["formulaContains"] in formula, (check, formula)
    value = cached[check["sheet"]][check["cell"]].value
    assert Decimal(str(value)) == Decimal(str(check["value"])), (check, value)

if expected.get("mode") == "end-to-end":
    hsn_value = sum(Decimal(str(cached[name][f"E{row}"].value)) for name in ["hsn(b2b)", "hsn(b2c)"] for row in range(5, cached[name].max_row + 1))
    hsn_taxable = sum(Decimal(str(cached[name][f"G{row}"].value)) for name in ["hsn(b2b)", "hsn(b2c)"] for row in range(5, cached[name].max_row + 1))
    assert hsn_value == Decimal(str(expected["netValuePaise"])) / 100
    assert hsn_taxable == Decimal(str(expected["netTaxablePaise"])) / 100
    assert Decimal(str(cached["b2b,sez,de"]["E3"].value)) - Decimal(str(cached["cdnr"]["I3"].value)) == hsn_value

recalculated = False
if expected.get("recalculate") and os.environ.get("FINANCER_TEST_RECALCULATE") == "1":
    with tempfile.TemporaryDirectory(prefix="financer-xlsx-recalculate-") as temporary:
        temporary = Path(temporary)
        subprocess.run([os.environ.get("LEDGERCRAFT_SOFFICE", "soffice"), "-env:UserInstallation=" + (temporary / "profile").as_uri(), "--headless", "--convert-to", "xlsx", "--outdir", str(temporary), str(output.resolve())], check=True, capture_output=True, timeout=90)
        result = openpyxl.load_workbook(temporary / output.name, data_only=True, read_only=True)
        for check in expected["cached"]:
            value = result[check["sheet"]][check["cell"]].value
            assert Decimal(str(value)) == Decimal(str(check["value"])), ("recalculated", check, value)
        result.close()
        recalculated = True

assert str(expected["report"]["registration"]["gstin"]) in workbook.properties.title
assert expected["report"]["month"] in workbook.properties.title
workbook.close()
cached.close()
print(json.dumps({"passed": True, "sheets": 32, "masterListsUnchanged": True, "externalLinks": 0, "mode": expected.get("mode", "fixture"), "recalculated": recalculated}))
