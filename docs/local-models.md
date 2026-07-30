# Local models

[← README](../README.md)

`/provider webllm` and `/provider wllama` keep inference inside the browser.
The first load asks before downloading; later sessions use the browser cache.

![WebLLM model selection](../screens/local-models.png)

## Choose a runtime

| Provider | Backend | Best fit | Tool-capable default |
| --- | --- | --- | --- |
| `webllm` | WebGPU + MLC worker | Chrome; larger GPU-resident models | Hermes 3 Llama 3.1 8B |
| `wllama` | GGUF WebGPU or WASM | GGUF models; selectable KV cache | Qwen3 8B Q4_K_M |

WebLLM requires WebGPU. Wllama requires `shader-f16` for its WebGPU path and
can run smaller models on multithreaded WASM when that feature is absent.

## WebLLM catalogue

| Model | Download | VRAM | Context | Tools |
| --- | ---: | ---: | ---: | --- |
| Hermes 3 Llama 3.1 8B | 4.22 GiB | 5.88 GiB | 8K | Yes |
| Hermes 3 Llama 3.2 3B | 1.69 GiB | 2.75 GiB | 4K | No |
| Qwen3.5 4B | 2.23 GiB | 4.36 GiB | 4K | No |
| Qwen3.5 9B | 4.71 GiB | 7.03 GiB | 4K | No |

## Wllama catalogue

| Model | Download | Default context | Tools | Thinking |
| --- | ---: | ---: | --- | --- |
| Qwen3 8B Q4_K_M | 4.68 GiB | 16K | Yes | Off / high |
| Qwen3.5 2B Q4_K_M | 1.19 GiB | 8K | Yes | No |
| Qwen3.5 0.8B Q4_K_M | 508 MiB | 8K | Yes | No |

Every Wllama model offers 4K, 8K, 16K, and 32K cache sizes. On the tested
12 GiB RTX 5070, Qwen3 8B used about 5.5/5.8/6.4/7.7 GiB at those sizes.

## Linux GPU setup

Chrome on NVIDIA:

```bash
npm run chrome:webgpu
```

Fully quit Chrome first; flags do not change an existing process.

Firefox needs these `about:config` values enabled, followed by a restart:

```text
dom.webgpu.enabled
dom.webgpu.workers.enabled
javascript.options.wasm_js_promise_integration
```

## Commands

```text
/model
/thinking off|high
/model status
/model unload
/model remove [id]
/model clear-cache
```
