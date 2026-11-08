"""Install a locally signed Ledgercraft build while preserving an open workstation."""
import ctypes
import hashlib
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile

APP_ID = "org.ledgercraft.desktop"
def info(app):
    with (app / "Contents/Info.plist").open("rb") as f:
        result = plistlib.load(f)
    if result.get("CFBundleIdentifier") != APP_ID:
        raise ValueError("Choose a public Ledgercraft application bundle")
    return result

def file_hash(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.digest()

def tree_hashes(directory):
    return {p.relative_to(directory):file_hash(p) for p in directory.rglob("*") if p.is_file()}

def verify(app):
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],check=True)

def swap(source,destination):
    function = ctypes.CDLL(None,use_errno=True).renamex_np
    function.argtypes = [ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint]
    if function(os.fsencode(source),os.fsencode(destination),2):  # RENAME_SWAP, sys/stdio.h
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))

def install(source,destination):
    if source.is_symlink() or destination.is_symlink() or source.resolve() == destination.resolve():
        raise ValueError("Choose two distinct application bundle paths")
    source = source.resolve()
    destination = destination.resolve()
    verify(source)
    new = info(source)
    key = new.get("FinancerBookResources","")
    if not re.fullmatch(r"app-[0-9]+(?:-[a-f0-9]{16})?",key) or not (source/"Contents/Resources"/key/"server.js").is_file():
        raise ValueError("The new build needs versioned accounting resources")
    destination.parent.mkdir(parents=True,exist_ok=True)
    if source.stat().st_dev != destination.parent.stat().st_dev:
        raise ValueError("Stage this build on the same volume as its installation")
    if not destination.exists():
        source.rename(destination)
        return
    old = info(destination)
    verify(destination)
    old_resources = destination / "Contents/Resources"
    resources = source / "Contents/Resources"
    # A running server resolves its scripts and static files by their original absolute pathname.
    # Preserve its resource directory across the atomic exchange. Include the previous launch
    # directory as well, so a concurrent launch between inspection and installation remains safe.
    app_pattern = r"app(?:-[0-9]+(?:-[a-f0-9]{16})?)?"
    runtime_pattern = r"runtime(?:-[a-f0-9]{16})?"
    commands = subprocess.check_output(["/bin/ps","-axo","command="],text=True)
    def preserve_active(field, default, pattern, entry):
        old_key = old.get(field,default)
        new_key = new.get(field,default)
        needed = {old_key}
        active_paths = [old_resources]
        for active_path in active_paths:
            needed.update(re.findall(re.escape(str(active_path))+r"/("+pattern+r")/"+entry+r"(?:\s|$)",commands))
        if not all(re.fullmatch(pattern,x) for x in needed | {new_key}):
            raise ValueError("Unrecognised installed application resource path")
        # A new Node build or a local rebuild of the same release can reuse a
        # nominal directory name. Place the new payload at an immutable path.
        if new_key in needed and tree_hashes(resources/new_key) != tree_hashes(old_resources/new_key):
            fingerprint = hashlib.sha256()
            for path, digest in sorted(tree_hashes(resources/new_key).items()):
                fingerprint.update(os.fsencode(path)+b"\0"+digest)
            prefix = "app-"+str(new["CFBundleVersion"]) if field=="FinancerBookResources" else "runtime"
            changed_key = prefix+"-"+fingerprint.hexdigest()[:16]
            (resources/new_key).rename(resources/changed_key)
            new[field] = changed_key
        for name in sorted(needed):
            original,target = old_resources/name,resources/name
            if not target.exists():
                subprocess.run(["/bin/cp","-cR",str(original),str(target)],check=True)
            if tree_hashes(target) != tree_hashes(original):
                raise ValueError("Could not preserve the installed application's active resources")
        return needed
    kept = preserve_active("FinancerBookResources","app",app_pattern,r"server\.js")
    kept |= preserve_active("FinancerRuntimeResources","runtime",runtime_pattern,"node")
    with (source/"Contents/Info.plist").open("wb") as f:
        plistlib.dump(new,f,sort_keys=False)
    subprocess.run(["/usr/bin/codesign","--force","--sign","-",str(source)],check=True)
    verify(source)
    recovery_root = Path.home()/"Library/Application Support/Ledgercraft/Previous Release"
    recovery_root.mkdir(parents=True,exist_ok=True)
    recovery = Path(tempfile.mkdtemp(prefix="Build-"+str(old["CFBundleVersion"])+"-",dir=recovery_root))/"Financer.previous"
    if recovery.parent.stat().st_dev != source.stat().st_dev:
        recovery.parent.rmdir()
        raise ValueError("The previous build must be recoverable on the installation volume")
    swap(source,destination)
    try:
        verify(destination)
        source.rename(recovery)
    except BaseException:
        swap(source,destination)
        recovery.parent.rmdir()
        raise
    print("Previous build retained at",recovery)
    print("Preserved active resources:",", ".join(sorted(kept)))

if __name__ == "__main__":
    install(Path(sys.argv[1]),Path(sys.argv[2]))
