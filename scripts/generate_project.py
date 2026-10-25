"""Generate the dependency-free Xcode starter. Safe to rerun; preserves Secrets.plist."""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def ident(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()


def main():
    secrets = ROOT / "Resources/Secrets.plist"
    if not secrets.exists():
        shutil.copyfile(ROOT / "Resources/Secrets.example.plist", secrets)
    sources = sorted(str(path.relative_to(ROOT)) for folder in ("App", "Models", "Services")
                     for path in (ROOT / folder).glob("*.swift"))
    resources = ["Resources/tools.json", "Resources/Secrets.plist", "Docs/AGENT_PROMPT.md"]
    objects = []

    def add(name, body):
        objects.append(f"{ident(name)} = {{ {body} }};")

    for path in sources + resources:
        kind = "sourcecode.swift" if path.endswith(".swift") else "text"
        add(path, f"isa = PBXFileReference; lastKnownFileType = {kind}; path = {json.dumps(path)}; sourceTree = SOURCE_ROOT;")
        add("build:" + path, f"isa = PBXBuildFile; fileRef = {ident(path)};")
    add("product", 'isa = PBXFileReference; explicitFileType = wrapper.application; path = SleepSheep.app; sourceTree = BUILT_PRODUCTS_DIR;')
    children = ",".join(ident(p) for p in sources + resources)
    add("main", f"isa = PBXGroup; children = ({children},{ident('products')}); sourceTree = \"<group>\";")
    add("products", f'isa = PBXGroup; children = ({ident("product")}); name = Products; sourceTree = "<group>";')
    for name, files, isa in [("sources", sources, "PBXSourcesBuildPhase"), ("resources", resources, "PBXResourcesBuildPhase")]:
        refs = ",".join(ident("build:" + p) for p in files)
        add(name, f"isa = {isa}; buildActionMask = 2147483647; files = ({refs}); runOnlyForDeploymentPostprocessing = 0;")
    add("frameworks", "isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;")
    for scope in ("project", "target"):
        for configuration in ("Debug", "Release"):
            settings = {
                "SDKROOT": "iphoneos", "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
                "SWIFT_VERSION": "5.0", "CLANG_ENABLE_MODULES": "YES",
                "SWIFT_OPTIMIZATION_LEVEL": "-Onone" if configuration == "Debug" else "-O",
            }
            if scope == "target":
                settings.update({"PRODUCT_BUNDLE_IDENTIFIER": "com.sleepsheep.demo",
                    "PRODUCT_NAME": "SleepSheep", "INFOPLIST_FILE": "Resources/Info.plist",
                    "TARGETED_DEVICE_FAMILY": "1", "CODE_SIGN_STYLE": "Automatic",
                    "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator",
                    "LD_RUNPATH_SEARCH_PATHS": "$(inherited) @executable_path/Frameworks"})
            body = " ".join(f"{key} = {json.dumps(value)};" for key, value in settings.items())
            add(scope + configuration, f'isa = XCBuildConfiguration; name = {configuration}; buildSettings = {{ {body} }};')
        add(scope + "configs", f'isa = XCConfigurationList; buildConfigurations = ({ident(scope + "Debug")},{ident(scope + "Release")}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
    add("target", f'isa = PBXNativeTarget; buildConfigurationList = {ident("targetconfigs")}; buildPhases = ({ident("sources")},{ident("frameworks")},{ident("resources")}); buildRules = (); dependencies = (); name = SleepSheep; productName = SleepSheep; productReference = {ident("product")}; productType = "com.apple.product-type.application";')
    add("project", f'isa = PBXProject; attributes = {{ LastUpgradeCheck = 1600; }}; buildConfigurationList = {ident("projectconfigs")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en,Base); mainGroup = {ident("main")}; productRefGroup = {ident("products")}; projectDirPath = ""; projectRoot = ""; targets = ({ident("target")});')
    project = ROOT / "SleepSheep.xcodeproj"
    project.mkdir(exist_ok=True)
    (project / "project.pbxproj").write_text("// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n" + "\n".join(objects) + f"\n}}; rootObject = {ident('project')}; }}\n")
    schemes = project / "xcshareddata/xcschemes"
    schemes.mkdir(parents=True, exist_ok=True)
    ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident("target")}" BuildableName="SleepSheep.app" BlueprintName="SleepSheep" ReferencedContainer="container:SleepSheep.xcodeproj"/>'
    (schemes / "SleepSheep.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
    print("Generated SleepSheep.xcodeproj; private Secrets.plist preserved.")


if __name__ == "__main__":
    main()
