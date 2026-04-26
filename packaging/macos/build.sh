#!/usr/bin/env bash
# Build a standalone host binary on macOS.
#
# Output: host/dist/remotedesk-host  (single-file)
#
# To produce a .pkg or .dmg, sign + notarize this binary. That requires an
# Apple Developer ID; outside the scope of this script.

set -euo pipefail
cd "$(dirname "$0")/../../host"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

pip install --upgrade pip
pip install -e ".[dev]"

pyinstaller --noconfirm remotedesk-host.spec

echo
echo "Built: $(pwd)/dist/remotedesk-host"
echo
echo "Reminder: grant Screen Recording + Accessibility permissions to the"
echo "Terminal you launch this binary from (System Settings -> Privacy)."
