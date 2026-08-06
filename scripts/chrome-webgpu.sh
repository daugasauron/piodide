#!/usr/bin/env bash
set -euo pipefail

piodide_unrestricted=0
if [[ "${1:-}" == "--unrestricted" ]]; then
  piodide_unrestricted=1
  shift
fi

if [[ "$piodide_unrestricted" -eq 0 ]] && \
  (pgrep -x chrome >/dev/null || pgrep -x google-chrome >/dev/null); then
  echo "Chrome is already running; it will ignore new GPU flags."
  echo "Fully quit every Chrome window, then run this command again."
  exit 1
fi

chrome_bin="${CHROME_BIN:-}"
if [[ -z "$chrome_bin" ]]; then
  chrome_bin="$(command -v google-chrome-stable || command -v google-chrome || true)"
fi
if [[ -z "$chrome_bin" ]]; then
  echo "Google Chrome was not found. Set CHROME_BIN to its executable path."
  exit 1
fi

if [[ "$#" -eq 0 ]]; then
  set -- "http://localhost:5173/piodide/"
fi

piodide_extra_flags=()
if [[ "$piodide_unrestricted" -eq 1 ]]; then
  piodide_data_root="${XDG_DATA_HOME:-}"
  if [[ -z "$piodide_data_root" ]]; then
    piodide_user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
    if [[ -z "$piodide_user_home" ]]; then
      echo "Could not determine a directory for the isolated Chrome profile."
      exit 1
    fi
    piodide_data_root="$piodide_user_home/.local/share"
  fi
  piodide_profile="${PIODIDE_UNRESTRICTED_PROFILE:-$piodide_data_root/piodide/chrome-unrestricted}"
  mkdir -p -- "$piodide_profile"
  echo "WARNING: browser web security is disabled in an isolated profile: $piodide_profile"
  echo "This profile can read cross-origin and local-network HTTP responses."
  piodide_extra_flags+=(
    --disable-web-security
    --user-data-dir="$piodide_profile"
    --no-first-run
    --no-default-browser-check
    --disable-sync
  )
fi

exec "$chrome_bin" \
  "${piodide_extra_flags[@]}" \
  --ignore-gpu-blocklist \
  --enable-unsafe-webgpu \
  --enable-dawn-features=allow_unsafe_apis,vulkan_enable_f16_on_nvidia \
  --disable-dawn-features=disallow_unsafe_apis \
  --enable-webgpu-developer-features \
  --use-webgpu-power-preference=default-high-performance \
  --ozone-platform=x11 \
  --use-angle=vulkan \
  --enable-features=Vulkan,VulkanFromANGLE,WebGPUDeveloperFeatures \
  "$@"
