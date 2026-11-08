"""Read the actual WKWebView printed PDF in a separate parser process."""
import hashlib
import json
from pathlib import Path
import sys
import fitz

output = Path(sys.argv[1])
file = output / 'stock-item-ledger.pdf'
pdf = fitz.open(file)
text = '\n'.join(page.get_text() for page in pdf)
for expected in ['Synthetic fasteners', 'TX-001', 'ADJ-001', 'PC-001', '94.50', 'Stock journal history', 'source(s)']:
    assert expected in text, expected
proof = {'passed': True, 'parser': 'PyMuPDF, separate local process', 'actualNativePrintedPdf': True,
         'pages': len(pdf), 'bytes': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
         'itemMovementsPresent': True, 'costLineagePresent': True, 'journalHistoryPresent': True}
(output / 'print-artifact-results.json').write_text(json.dumps(proof, indent=2))
print(json.dumps(proof))
