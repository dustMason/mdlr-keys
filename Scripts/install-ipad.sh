#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVICE="${MDLR_DEVICE:?Set MDLR_DEVICE to your connected iPad name or identifier}"
TEAM="${MDLR_APPLE_TEAM:?Set MDLR_APPLE_TEAM to your own Xcode development team ID}"
# Connect, unlock, trust this Mac, and enable Developer Mode before running.
DETAILS="$(mktemp)"
trap 'rm -f "$DETAILS"' EXIT
xcrun devicectl device info details --device "$DEVICE" --timeout 20 --json-output "$DETAILS"
DEVICE_UDID="$(python3 - "$DETAILS" <<'PY'
import json, sys
device = json.load(open(sys.argv[1]))['result']
if device['deviceProperties'].get('developerModeStatus') != 'enabled':
    sys.exit('Enable Developer Mode in Settings > Privacy & Security, then unlock the iPad.')
print(device['hardwareProperties']['udid'])
PY
)"
bash "$PROJECT_ROOT/Scripts/prepare-assets.sh"
xcodebuild -project "$PROJECT_ROOT/MDLR.xcodeproj" -scheme MDLR -sdk iphoneos -configuration Release \
    -destination "platform=iOS,id=$DEVICE_UDID" -destination-timeout 30 \
    SYMROOT="$PROJECT_ROOT/Build/Signed" OBJROOT="$PROJECT_ROOT/Build/SignedIntermediates" \
    DEVELOPMENT_TEAM="$TEAM" -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
APP="$PROJECT_ROOT/Build/Signed/Release-iphoneos/MDLR.app"
codesign --verify --deep --strict "$APP"
python3 - "$APP" "$DEVICE_UDID" "$TEAM" <<'PY'
import datetime, pathlib, plistlib, subprocess, sys
app, udid, team = sys.argv[1:]
profile = plistlib.loads(subprocess.check_output([
    'security', 'cms', '-D', '-i', str(pathlib.Path(app) / 'embedded.mobileprovision')
], stderr=subprocess.DEVNULL))
if udid not in profile.get('ProvisionedDevices', []):
    sys.exit('Signing profile does not include this iPad; installation stopped.')
if team not in profile.get('TeamIdentifier', []):
    sys.exit('Signing profile uses a different development team; installation stopped.')
if profile['ExpirationDate'] <= datetime.datetime.utcnow():
    sys.exit('Signing profile has expired; installation stopped.')
if profile['Entitlements']['application-identifier'] != team + '.com.dustmason.mdlr.ipad':
    sys.exit('Signing profile does not match mdlr; installation stopped.')
print('Verified signing profile includes the connected iPad.')
PY
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" com.dustmason.mdlr.ipad
