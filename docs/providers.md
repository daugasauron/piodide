# Hosted providers

[← README](../README.md)

Hosted APIs run the agent in the browser but send prompts and tool results to
the selected provider.

```text
/provider
/login
/model
```

API keys stay in page memory and disappear on refresh.

## OpenRouter

1. Choose **OpenRouter** in `/provider`.
2. Paste an OpenRouter API key in `/login`; Piodide verifies it without making
   a paid model request.
3. Choose a model in `/model`.

The model menu refreshes OpenRouter's tool-capable catalogue. If that request
is unavailable, it falls back to the bundled catalogue. Any explicit model
slug remains accepted:

```text
/model anthropic/claude-sonnet-4.6
```

Requests go directly from the tab to OpenRouter. Models that advertise
reasoning expose their supported levels through `/thinking`.

## Other providers

`/provider` also includes Anthropic, OpenAI, Groq, Together, DeepSeek, Mistral,
Moonshot, and Z.AI endpoints. Each uses the same `/login` → `/model` flow.
