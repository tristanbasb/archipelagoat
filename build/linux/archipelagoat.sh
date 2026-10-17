#!/bin/sh
# Starts ArchipelaGOAT from the extracted tar.gz (README, "Linux: Chromium's sandbox").
#
# The sandbox stays on. Since Ubuntu 23.10, AppArmor keeps a program without a profile from creating
# the user namespaces Chromium's sandbox needs; Electron then stops at once ("The SUID sandbox helper
# binary was found, but is not configured correctly"). The .deb installs a profile for its copy; this
# copy needs one too, once. When the app stops on a system that restricts user namespaces, this says
# how, with the paths of this folder.
here=$(dirname "$(readlink -f "$0")")
"$here/archipelagoat" "$@"
status=$?
restricted=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)
if [ "$status" -ne 0 ] && [ "$restricted" = 1 ]; then
  cat >&2 <<EOF

If ArchipelaGOAT stopped on its sandbox (chrome-sandbox) above: this system restricts user
namespaces (AppArmor), and this copy has no AppArmor profile yet. Give it one, once (the .deb
does the same for its own copy), then start ./archipelagoat.sh again:

sudo tee /etc/apparmor.d/archipelagoat-local > /dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile archipelagoat-local "$here/archipelagoat" flags=(unconfined) {
  userns,
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/archipelagoat-local

EOF
fi
exit "$status"
