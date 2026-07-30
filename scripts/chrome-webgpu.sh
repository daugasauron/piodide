#!/usr/bin/env bash
set -euo pipefail

if pgrep -x chrome >/dev/null || pgrep -x google-chrome >/dev/null; then
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

exec "$chrome_bin" \
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
