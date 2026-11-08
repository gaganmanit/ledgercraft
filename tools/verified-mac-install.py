"""Fingerprint and explicitly install a tested public Ledgercraft candidate."""
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.error import URLError
from urllib.request import urlopen

PROJECT = Path(__file__).resolve().parents[1]
def digest(file):
    h = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def tree(directory):
    return {file.relative_to(directory).as_posix(): digest(file) for file in sorted(directory.rglob("*")) if file.is_file()}

def launcher_code_hash(file):
    # Signing binds Info.plist and resource paths into the signature, without
    # changing the launcher code. Hash an unsigned copy; never mutate the app.
    with tempfile.TemporaryDirectory(prefix="ledgercraft-launcher-hash-") as temporary:
        copy = Path(temporary) / file.name
        shutil.copyfile(file, copy)
        copy.chmod(0o700)
        subprocess.run(["/usr/bin/codesign", "--remove-signature", str(copy)], check=True, capture_output=True)
        return digest(copy)

def info(app):
    props = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if props["CFBundleIdentifier"] != "org.ledgercraft.desktop":
        raise ValueError("Choose a Ledgercraft application bundle")
    return props

def identity(app, compare_source=False):
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], check=True, capture_output=True)
    props = info(app)
    resources = app / "Contents/Resources"
    book = resources / props["FinancerBookResources"]
    entries = tree(book)
    if compare_source:
        expected = {f:digest(PROJECT/f) for f in ("server.js","package.json")}
        for sub in ("lib","public","data/companies/specimen-8fe3bf"):
            expected.update({sub+"/"+name:value for name,value in tree(PROJECT/sub).items()})
        if entries != expected:
            raise ValueError("Current app sources differ from the staged release")
    return {"version":props["CFBundleShortVersionString"], "build":props["CFBundleVersion"],
            "resourcesSHA256": hashlib.sha256(json.dumps(entries,sort_keys=True).encode()).hexdigest(),
            "launcherCodeSHA256":launcher_code_hash(app/"Contents/MacOS"/props["CFBundleExecutable"]),
            "runtimeSHA256":digest(resources/props.get("FinancerRuntimeResources","runtime")/"node")}

def current_desk():
    def get(route):
        with urlopen("http://127.0.0.1:4173/"+route,timeout=4) as response:
            return response.read()
    try:
        health=get("api/health")
        if json.loads(health).get("app") != "financer":
            return None
    except (URLError,ValueError):
        return None
    return (health,get("app.js"),get("gst-ui.js"),get("styles.css"))

def install(candidate, destination, expected_previous, proof):
    tests = (proof/"packaged-tests.txt").read_text()
    counts = {name:int(count) for name,count in re.findall(r"^ℹ (tests|pass|fail|skipped|cancelled|todo) (\d+)$",tests,re.M)}
    if not counts.get("tests") or counts.get("pass") != counts["tests"] or any(counts.get(k)!=0 for k in ("fail","skipped","cancelled","todo")):
        raise ValueError("A complete successful packaged test run is required")
    tested = json.loads((proof/"tested-build.json").read_text())
    if tested != identity(candidate, compare_source=True) or not json.loads((proof/"native-launch.json").read_text()).get("nativeLauncherStarted"):
        raise ValueError("The staged app differs from the verified build")
    previous=destination
    if previous.exists() and info(previous)["CFBundleShortVersionString"] != expected_previous:
        raise ValueError("The installed application version changed since release preparation")
    books=Path.home()/"Library/Application Support/Ledgercraft/data/companies"
    before, live = tree(books), current_desk()
    subprocess.run([sys.executable,PROJECT/"mac/install.py",candidate,destination],check=True)
    subprocess.run(["codesign","--verify","--deep","--strict",destination],check=True)
    if identity(destination, compare_source=True) != tested:
        raise ValueError("Installed payload differs from the tested build")
    preserved = current_desk() == live if live else None
    report={**tested,"installed":str(destination),"packagedTestsPassed":counts["pass"],"codeSignaturePassed":True,
            "installedResourcesMatchTestedSource":True,"existingServerActive":bool(live),"existingServerPreserved":preserved,
            "liveCompanyFilesCompared":len(before),"liveCompanyHashesIdentical":before==tree(books)}
    (proof/"installation.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report,indent=2))
    if preserved is False or not report["liveCompanyHashesIdentical"]:
        raise ValueError("The running desk or company files changed during installation; inspect the installation receipt")

if __name__ == "__main__":
    if len(sys.argv)==3 and sys.argv[1]=="fingerprint":
        print(json.dumps(identity(Path(sys.argv[2])),indent=2))
    elif len(sys.argv)==6 and sys.argv[1]=="install":
        install(Path(sys.argv[2]),Path(sys.argv[3]),sys.argv[4],Path(sys.argv[5]))
    else:
        sys.exit("Pass fingerprint APP, or install CANDIDATE DESTINATION EXPECTED_PREVIOUS_VERSION PROOF_DIRECTORY")
