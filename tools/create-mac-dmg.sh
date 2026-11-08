#!/bin/bash
# Build and verify a public release image. No installed application is read or changed.
set -euo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
exec python3 - "$SCRIPT" "$@" <<'PY'
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile

script = Path(sys.argv[1])
repo = script.parents[1]
parser = argparse.ArgumentParser(description="Build an isolated public Ledgercraft disk image from committed source")
parser.add_argument("--source-ref", default="HEAD")
parser.add_argument("--output-dir", type=Path, default=repo / "dist")
args = parser.parse_args(sys.argv[2:])
if platform.system() != "Darwin":
    parser.error("Disk-image packaging requires macOS and Xcode Command Line Tools")
os.environ["TZ"] = "UTC"
time.tzset()
epoch = 978307200  # Fixed public file date: 01-01-2001, UTC.

def run(command, **options):
    try:
        return subprocess.run([str(part) for part in command], check=True, **options)
    except subprocess.CalledProcessError as error:
        detail = error.stderr or error.stdout
        if detail:
            if isinstance(detail, bytes): detail = detail.decode("utf-8", errors="replace")
            print(detail, file=sys.stderr, flush=True)
        raise

def digest(file):
    h = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def tree(directory):
    return {file.relative_to(directory).as_posix(): digest(file) for file in sorted(directory.rglob("*")) if file.is_file()}

def save(file, content):
    file.write_text(json.dumps(content, indent=2, sort_keys=True) + "\n")

commit = run(["git", "-C", repo, "rev-parse", "--verify", args.source_ref + "^{commit}"], capture_output=True, text=True).stdout.strip()
committed_script = run(["git", "-C", repo, "show", commit + ":tools/create-mac-dmg.sh"], capture_output=True).stdout
if committed_script != script.read_bytes():
    sys.exit("Commit the packaging tool before building a release from that revision")
info = plistlib.loads(run(["git", "-C", repo, "show", commit + ":mac/Info.plist"], capture_output=True).stdout)
version = info["CFBundleShortVersionString"]
arch = platform.machine()
filename = f"Ledgercraft-{version}-macOS-{arch}.dmg"
output = args.output_dir.resolve()
output.mkdir(parents=True, exist_ok=True)
final = output / filename
partial = output / (filename + ".partial.dmg")
proof = output / "DMG-proof"
if final.exists() or partial.exists() or proof.exists():
    sys.exit("Release image or proof destination already exists; choose a fresh --output-dir")
proof.mkdir()
private = [str(Path.home()), str(repo), pwd.getpwuid(os.getuid()).pw_name, socket.gethostname()]
private = [value.encode() for value in private if len(value) >= 4]
mounted = None
success = False

def normalize_dates(directory):
    entries = sorted(directory.rglob("*"), key=lambda file: len(file.parts), reverse=True) + [directory]
    for begin in range(0, len(entries), 64):
        run(["/usr/bin/SetFile", "-P", "-d", "01/01/2001 00:00:00", "-m", "01/01/2001 00:00:00", *entries[begin:begin + 64]], capture_output=True)
    for file in entries:
        os.utime(file, (epoch, epoch), follow_symlinks=False)

def privacy_check(app, check_attributes=True):
    if any(file.is_symlink() for file in app.rglob("*")):
        raise ValueError("Unexpected symbolic link in public bundle")
    files = [file for file in app.rglob("*") if file.is_file()]
    for file in files:
        if file.is_symlink() or file.name in {".DS_Store", ".localized"} or file.name.startswith("._"):
            raise ValueError("Unexpected symbolic link or Finder metadata in public bundle")
        chunks = [file.read_bytes()]
        if zipfile.is_zipfile(file):
            with zipfile.ZipFile(file) as archive:
                chunks.extend(archive.read(entry) for entry in archive.infolist() if not entry.is_dir())
        if any(term in content for content in chunks for term in private):
            raise ValueError("Local build identity found in bundle file: " + file.relative_to(app).as_posix())
    attributes = run(["/usr/bin/xattr", "-r", app], capture_output=True, text=True).stdout.splitlines() if check_attributes else []
    generic_markers = 0
    empty_finder_info = 0
    for entry in attributes:
        if not entry.strip(): continue
        file, attribute_name = entry.rsplit(": ", 1)
        marker = bytes.fromhex(run(["/usr/bin/xattr", "-px", attribute_name, file], capture_output=True, text=True).stdout)
        if attribute_name == "com.apple.FinderInfo" and marker == bytes(32):
            empty_finder_info += 1
            continue
        if attribute_name != "com.apple.provenance":
            raise ValueError("Unexpected extended attribute in public bundle")
        # Some macOS versions regenerate this fixed, empty two-byte marker even
        # after deletion. It has no per-file, machine, account or path payload.
        if marker not in (b"\x01\x02", b"\x01\x02\x00" + bytes(8)):
            raise ValueError("Non-generic provenance metadata in public bundle")
        generic_markers += 1
    return {"filesChecked": len(files), "localIdentityMatches": 0, "attributesChecked": check_attributes,
            "emptyFinderInfoRecords": empty_finder_info, "genericProvenanceMarkers": generic_markers,
            "genericProvenanceMarkerHex": "0102" if generic_markers else None,
            "upstreamNodeCodeNotPatched": True, "vendorMetadata": "Official Node runtime retains its public upstream build metadata; it is not local build-machine information."}

@contextmanager
def release_workspace():
    global mounted
    temporary = Path(tempfile.mkdtemp(prefix="ledgercraft-dmg-", dir="/tmp"))
    try:
        yield str(temporary)
    finally:
        if mounted is not None:
            run(["/usr/bin/hdiutil", "detach", mounted], capture_output=True)
            mounted = None
        removed = sum(file.stat().st_size for file in temporary.rglob("*") if file.is_file() and not file.is_symlink())
        shutil.rmtree(temporary)
        save(proof / "cleanup.json", {"path": str(temporary), "bytesRemoved": removed,
             "reason": "Task-created source archive, build and disk-image intermediates; final image and proof retained separately"})

try:
    with release_workspace() as temporary:
        work = Path(temporary)
        private.append(str(work).encode())
        source = work / "source"
        source.mkdir()
        archive = work / "source.tar"
        run(["git", "-C", repo, "archive", "--format=tar", "--output=" + str(archive), commit])
        run(["/usr/bin/tar", "-xf", archive, "-C", source])
        archive.unlink()
        for name in ("GSTR1_Excel_Workbook_Template_V2.2.xlsx", "hsn-sac.json"):
            shutil.copyfile(repo / "lib/resources" / name, source / "lib/resources" / name)
        with (proof / "public-resources.json").open("w") as stream:
            run(["python3", source / "tools/prepare-resources.py", "--check"], stdout=stream)
        expected = {name: digest(source / name) for name in ("server.js", "package.json")}
        for name in ("lib", "public", "data/companies/specimen-8fe3bf"):
            expected.update({name + "/" + path: value for path, value in tree(source / name).items()})
        save(proof / "source-files.json", expected)
        source_hash = hashlib.sha256(json.dumps(expected, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        print("Building standalone public app from " + commit[:12], flush=True)
        candidate = work / "Ledgercraft.app"
        run(["bash", source / "mac/build.sh", candidate], cwd=source)
        app_info = plistlib.loads((candidate / "Contents/Info.plist").read_bytes())
        if app_info["CFBundleIdentifier"] != "org.ledgercraft.desktop":
            raise ValueError("Only the public Ledgercraft bundle identifier can be packaged")
        notices = candidate / "Contents/Resources/Notices"
        notices.mkdir()
        for name in ("LICENSE", "THIRD-PARTY.md"):
            shutil.copyfile(source / name, notices / name)
        run(["/usr/bin/xattr", "-cr", candidate])
        run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", "--timestamp=none", candidate], capture_output=True)
        run(["/usr/bin/xattr", "-cr", candidate])
        normalize_dates(candidate)
        privacy_check(candidate, check_attributes=False)
        resources = candidate / "Contents/Resources" / app_info["FinancerBookResources"]
        if tree(resources) != expected:
            raise ValueError("Bundled accounting sources differ from the selected public revision")
        runtime = candidate / "Contents/Resources/runtime/node"
        runtime_version = run([runtime, "--version"], capture_output=True, text=True).stdout.strip()
        runtime_arch = run(["/usr/bin/lipo", "-archs", runtime], capture_output=True, text=True).stdout.strip()
        stage = work / "image-root"
        stage.mkdir()
        shutil.move(candidate, stage / "Ledgercraft.app")
        normalize_dates(stage)
        writable = work / "release-master.iso"
        print("Creating release disk image", flush=True)
        # UDF preserves executable modes without synthesizing FinderInfo
        # attributes that invalidate signed resources. Avoid UDF symlink issues.
        run(["/usr/bin/hdiutil", "makehybrid", "-udf", "-udf-volume-name", "Ledgercraft " + version, "-o", writable, stage])
        mount = work / "image-mount"
        mount.mkdir()
        with writable.open("rb") as image:
            previous = b""
            for chunk in iter(lambda: image.read(1024 * 1024), b""):
                content = previous + chunk
                if any(term in content for term in private):
                    raise ValueError("Local build identity found in mastered disk-image bytes")
                previous = content[-max(map(len, private)):]
        run(["/usr/bin/hdiutil", "convert", writable, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", partial])
        run(["/usr/bin/xattr", "-c", partial])
        with (proof / "hdiutil-verify.txt").open("w") as stream:
            run(["/usr/bin/hdiutil", "verify", partial.name], cwd=output, stdout=stream, stderr=subprocess.STDOUT)
        print("Verifying read-only image and isolated native launch", flush=True)
        run(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-owners", "off", "-mountpoint", mount, partial], capture_output=True)
        mounted = mount
        if {file.name for file in mount.iterdir()} != {"Ledgercraft.app"}:
            raise ValueError("Unexpected disk-image root contents")
        packaged = mount / "Ledgercraft.app"
        signature = run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", packaged], capture_output=True, text=True)
        (proof / "codesign-verify.txt").write_text((signature.stdout + signature.stderr).replace(str(packaged), "Ledgercraft.app"))
        if tree(packaged / "Contents/Resources" / app_info["FinancerBookResources"]) != expected:
            raise ValueError("Read-only disk-image sources differ from the selected public revision")
        save(proof / "privacy.json", privacy_check(packaged))
        with (proof / "native-launch.json").open("w") as stream:
            run(["python3", source / "tools/verify-native-launch.py", packaged], stdout=stream)
        after = tree(packaged)
        run(["/usr/bin/codesign", "--verify", "--deep", "--strict", packaged], capture_output=True)
        run(["/usr/bin/hdiutil", "detach", mount], capture_output=True)
        mounted = None
        partial.rename(final)
        os.utime(final, (epoch, epoch))
        checksum = digest(final)
        (output / (filename + ".sha256")).write_text(checksum + "  " + filename + "\n")
        receipt = {"file": filename, "sourceCommit": commit, "sourceFilesSHA256": source_hash,
                   "version": version, "architecture": runtime_arch, "minimumMacOS": app_info["LSMinimumSystemVersion"],
                   "nodeVersion": runtime_version, "bytes": final.stat().st_size, "sha256": checksum,
                   "codeSignature": "ad-hoc; deep strict verification passed", "appleNotarized": False,
                   "diskImageVerification": True, "readOnlyMountVerified": True, "isolatedNativeLaunch": True,
                   "packagedFiles": len(after), "fileMetadataEpoch": "2001-01-01T00:00:00Z", "privacyHardBlockers": []}
        save(proof / "release.json", receipt)
        (proof / "release-notes.md").write_text(f"# Ledgercraft {version} for Mac\n\nStandalone {runtime_arch} application for macOS {app_info['LSMinimumSystemVersion']} or later, with Node {runtime_version} bundled.\n\nBuilt from public source revision `{commit}`. Open the disk image and copy Ledgercraft.app to Applications.\n\nThe application is locally ad hoc signed and is not Apple-notarized.\n\nIf Ledgercraft.app already exists with a different bundle identifier, keep it and copy this public app under another filename, such as Ledgercraft Public.app. The public bundle identifier is `org.ledgercraft.desktop`; its books use Application Support/Ledgercraft.\n\nSHA-256: `{checksum}`\n")
        success = True
        print(json.dumps(receipt, indent=2), flush=True)
finally:
    if mounted is not None:
        subprocess.run(["/usr/bin/hdiutil", "detach", str(mounted)], capture_output=True)
    if not success and partial.exists():
        partial.unlink()
PY
