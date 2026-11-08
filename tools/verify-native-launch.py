"""Launch the packaged Mac app with separate books and an ephemeral loopback port."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

app = Path(sys.argv[1]).resolve()
info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
resources = app / "Contents/Resources"
book = resources / info["FinancerBookResources"]
executable = info["CFBundleExecutable"]
display_name = info.get("CFBundleDisplayName", info["CFBundleName"])
assert isinstance(executable, str) and executable and Path(executable).name == executable
if display_name == "Ledgercraft":
    assert info["CFBundleName"] == executable == "Ledgercraft"
    assert info["CFBundleIdentifier"] == "org.ledgercraft.desktop"
    assert info["CFBundleIconFile"] == "Ledgercraft"
    assert (resources / "Ledgercraft.icns").is_file()
root = Path(tempfile.mkdtemp(prefix="ledgercraft-launch-"))
with socket.socket() as reservation:
    reservation.bind(("127.0.0.1", 0))
    port = reservation.getsockname()[1]
token = secrets.token_hex(24)
launch_environment = dict(os.environ, LEDGERCRAFT_TOKEN=token)
process = subprocess.Popen([app / "Contents/MacOS" / executable, "--test-workstation", root, str(port)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=launch_environment)
base = "http://127.0.0.1:" + str(port)
def get(route):
    request = urllib.request.Request(base + route, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(request, timeout=2) as response:
        return response.read()

try:
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Native launcher exited with status " + str(process.returncode))
        try:
            health = json.loads(get("/api/health"))
            if health["app"] == "financer" and health["instance"]:
                break
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    else:
        raise TimeoutError("Isolated native launch did not become ready")
    native_branding = None
    if display_name == "Ledgercraft":
        native_branding = json.loads((root / "native-branding.json").read_text())
        assert native_branding["windowTitle"] == "Ledgercraft"
        assert native_branding["applicationMenu"] == "Ledgercraft"
        for title in ["About Ledgercraft", "Hide Ledgercraft", "Quit Ledgercraft"]:
            assert title in native_branding["applicationMenuItems"]
        assert ">Ledgercraft</h1>" in native_branding["startupHTML"]
        assert native_branding["frameAutosaveName"] == "LedgercraftMainWindow"
    station = json.loads(get("/api/workstation"))
    assert Path(station["dataDirectory"]).resolve().is_relative_to(root.resolve())
    companies = json.loads(get("/api/companies"))
    assert any(c["name"] == "North Mill Traders" for c in companies.get("companies", []))
    assert get("/app.js") == (book / "public/app.js").read_bytes()
    assert get("/gst-2b-ui.js") == (book / "public/gst-2b-ui.js").read_bytes()
    modules = ["app.js","gst-2b-ui.js","gst-rcm-ui.js"]
    if int(info["CFBundleVersion"]) >= 3: modules += ["stock-ui.js","gst-itc-ui.js"]
    if int(info["CFBundleVersion"]) >= 4: modules += ["gst-amendment-ui.js","gst-amendment-disposition.js","gst-filed-source-ui.js","gst-filed-source-worker.js","gst-filed-source.js"]
    if int(info["CFBundleVersion"]) >= 5: modules += ["tally-tools.js","tally-gst-ui.js","tally-invoice-references.js"]
    for module in modules:
        assert get("/"+module) == (book / "public" / module).read_bytes()
    assert "8541" in get("/api/hsn?q=8541").decode()
    print(json.dumps(dict(version=info["CFBundleShortVersionString"],displayName=display_name,executable=executable,
          nativeBranding=native_branding,nativeLauncherStarted=True,
          isolatedBooks=True, specimenLoaded=True, appJS=hashlib.sha256(get("/app.js")).hexdigest(),
          servedModules=modules, hsnSearch=True),indent=2))
finally:
    process.terminate()
    process.wait(timeout=10)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        try:
            get("/api/health")
        except OSError:
            break
        time.sleep(0.2)
    else:
        raise RuntimeError("Isolated books server is still running in " + str(root))
    shutil.rmtree(root)
