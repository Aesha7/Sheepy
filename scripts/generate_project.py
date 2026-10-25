"""Sync Swift sources into the checked-in project without replacing configuration.

Preserves existing source/resource membership, IDs, build settings (including signing,
Info.plist, deployment target and entitlements), schemes, and capability metadata.
Never opens or creates credential files. Restore the project from Git if missing.
"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def ident(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()


def main():
    project = ROOT / "SleepSheep.xcodeproj/project.pbxproj"
    if not project.exists():
        raise SystemExit("Restore the checked-in Xcode project before syncing sources.")
    original = project.read_text()
    parsed = json.loads(subprocess.check_output(["plutil", "-convert", "json", "-o", "-", str(project)]))
    objects = parsed["objects"]
    target = next(value for value in objects.values()
                  if value.get("isa") == "PBXNativeTarget" and value.get("name") == "SleepSheep")
    phase_id = next(key for key in target["buildPhases"] if objects[key]["isa"] == "PBXSourcesBuildPhase")
    main_group = objects[parsed["rootObject"]]["mainGroup"]
    references = {value.get("path"): key for key, value in objects.items()
                  if value.get("isa") == "PBXFileReference"}
    builds = {value.get("fileRef"): key for key, value in objects.items()
              if value.get("isa") == "PBXBuildFile"}
    # Existing source roots remain included; Views is now a first-class source folder.
    folders = {"App", "Models", "Services", "Views"}
    folders.update(path.split("/")[0] for path in references
                   if path and path.endswith(".swift") and "/" in path)
    sources = sorted(str(path.relative_to(ROOT)) for folder in folders
                     for path in (ROOT / folder).rglob("*.swift"))
    text = original

    def add_object(section, line):
        nonlocal text
        marker = f"/* End {section} section */"
        if marker not in text:
            raise SystemExit(f"Missing project section: {section}")
        text = text.replace(marker, line + "\n" + marker, 1)

    def add_list_item(object_id, field, line):
        nonlocal text
        start = text.index(object_id, text.index("/* Begin PBXGroup section */")
                           if object_id == main_group else text.index("/* Begin PBXSourcesBuildPhase section */"))
        index = text.index(field + " = (", start) + len(field + " = (")
        text = text[:index] + "\n" + line + text[index:]

    count = 0
    for source in sources:
        ref = references.get(source)
        if ref is None:
            ref = ident("source-ref:" + source)
            if ref in objects:
                raise SystemExit("Generated source ID collision")
            add_object("PBXFileReference", f'\t\t{ref} /* {source} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {json.dumps(source)}; sourceTree = SOURCE_ROOT; }};')
            add_list_item(main_group, "children", f"\t\t\t\t{ref} /* {source} */,")
        build = builds.get(ref)
        if build is None:
            build = ident("source-build:" + source)
            if build in objects:
                raise SystemExit("Generated build ID collision")
            add_object("PBXBuildFile", f"\t\t{build} /* {source} in Sources */ = {{isa = PBXBuildFile; fileRef = {ref} /* {source} */; }};")
        if build not in objects[phase_id]["files"]:
            add_list_item(phase_id, "files", f"\t\t\t\t{build} /* {source} in Sources */,")
            count += 1
    if text != original:
        project.write_text(text)
    print(f"Synced {count} Swift sources; all existing project settings and resources preserved.")


if __name__ == "__main__":
    main()
