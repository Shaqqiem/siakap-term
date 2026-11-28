"""Build a GitHub release's notes from CHANGELOG.md.

    python3 scripts/release-notes.py 0.7.2 [path/to/SHA256SUMS.txt] > notes.md

Prints the version's section, an "Install or update" table, the checksums and the
compare link. Exits with an error if CHANGELOG.md has no section for the version,
so a release can't go out without written notes.
"""
import re
import sys

version = sys.argv[1].lstrip("v")
sums_path = sys.argv[2] if len(sys.argv) > 2 else None
text = open("CHANGELOG.md", encoding="utf-8").read()

m = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|^\[[0-9])", text, re.S | re.M)
if not m:
    sys.exit(f"CHANGELOG.md has no section for {version}. Add one before releasing.")
body = m.group(1).strip()
link = re.search(rf"^\[{re.escape(version)}\]: (\S+)", text, re.M)

setup = f"Siakap.Terminal_{version}_x64-setup.exe"
msi = f"Siakap.Terminal_{version}_x64_en-US.msi"
out = [body, "", "### Install or update", "", "| | |", "| --- | --- |"]
# In-app updating exists from 0.7.1, so it can deliver 0.7.2 and later.
if tuple(int(x) for x in version.split(".")[:3]) >= (0, 7, 2):
    out.append("| **Already on 0.7.1 or later** | Settings → About → **Check for updates** → **Download and install**. Siakap updates itself and opens again. |")
out.append(f"| **New install, or an older version** | Download **{setup}** below and run it. No admin rights needed; your sessions and settings are kept. |")
out.append(f"| **IT-managed install** | `{msi}` |")
if tuple(int(x) for x in version.split(".")[:3]) >= (0, 9, 0):
    dmg = f"Siakap.Terminal_{version}_universal.dmg"
    out.append(f"| **Mac (Apple silicon or Intel, macOS 11+)** | Download **{dmg}**, open it and drag Siakap Terminal into Applications. The first time, right-click the app and choose **Open** (it isn't notarised by Apple). |")
if sums_path:
    sums = open(sums_path, encoding="utf-8").read().strip()
    out += ["", "<details><summary>SHA-256 checksums</summary>", "", "```text", sums, "```", "", "</details>"]
if link:
    label = link.group(1).rsplit("/", 1)[-1]
    out += ["", f"**Full changelog:** [{label}]({link.group(1)})"]
print("\n".join(out))
