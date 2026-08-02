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
and are cleared on refresh. General GLM keys use the models endpoint for login
validation. Coding Plan login sends a one-token completion because its models
endpoint rejects valid plan keys. A quota-exhausted response still verifies the
key, but the app reports that requests cannot run. Paste cleanup removes
Unicode whitespace and invisible formatting marks while preserving the periods
in Z.AI's `id.secret` key format. The confirmation shows the normalized key's
length and first/last four characters.
