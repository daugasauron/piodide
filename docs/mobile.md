# Mobile controls

[← README](../README.md)

Tap the floating `/` button or swipe left from the right edge.

| Commands | Login |
| --- | --- |
| ![Mobile provider, login, and model commands](../screens/mobile-commands.png) | ![Mobile API-key entry](../screens/mobile-login.png) |

1. Choose `/provider`.
2. Choose `/model`.
3. Choose `/login`, paste the API key, and tap **Connect**.

The drawer is limited to these three commands. API keys stay in page memory
and are cleared on refresh. General GLM keys are checked without running a
completion. Coding Plan keys are validated by the first real request because
the Coding endpoint has no compatible non-billable key check. A GLM value
without the dot in `id.secret` is rejected as an incomplete copy.
