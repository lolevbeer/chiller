#!/bin/bash
# Make Teleport (WiFiman) behave like a split tunnel: run AFTER connecting Teleport.
# Teleport doesn't replace the default route — it adds 0/1 + 128.0/1 half-range routes
# (verified in diag.txt) that override it. Deleting those two sends internet/Claude back
# out the home LAN; adding 192.168.6.0/24 keeps the chiller site on the tunnel, whose
# link to the site survives via its own pinned host route.
# The home LAN is ALSO 192.168.4.0/22, so a /22 tunnel route collides with en0's own
# and never lands. The site hosts (controller .6.86, Pi .6.22) live in .6.x: a /24
# is more specific than en0's /22, so it wins. (Home devices in .6.x become unreachable.)
# Re-run after every Teleport reconnect — WiFiman reinstalls the routes each time.
set -e

TUN=$(netstat -rn -f inet | awk '$1 == "0/1" {print $NF; exit}')
if [[ -z $TUN ]]; then
  echo "No 0/1 tunnel route found — is Teleport connected?" >&2
  exit 1
fi

sudo route -n delete -net 0.0.0.0/1 -interface "$TUN" >/dev/null
sudo route -n delete -net 128.0.0.0/1 -interface "$TUN" >/dev/null
sudo route -n add -net 192.168.6.0/24 -interface "$TUN" >/dev/null 2>&1 ||
  sudo route -n change -net 192.168.6.0/24 -interface "$TUN" >/dev/null
echo "Split active: internet via en0, chiller site (192.168.6.0/24) via $TUN"
