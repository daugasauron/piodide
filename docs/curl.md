# Browser curl

[← README](../README.md)

`/bin/curl` is a curl-like HTTP client backed by browser `fetch`. It is not
libcurl and only handles one HTTP(S) URL per invocation.

```sh
curl -fsS https://api.example/data.json | grep name
curl --json '{"ok":true}' https://api.example/items
curl -L -o result.bin https://files.example/result.bin
curl -D headers.txt -o body.bin https://api.example/result
```

## Options

| Group | Flags |
| --- | --- |
| Request | `-X`, `-H`, `-d`, `--data-binary`, `--data-raw`, `--data-urlencode`, `--json`, `-G` |
| Response | `-I`, `-i`, `-L`, `-D` |
| Output | `-o`, `-O`, `--out-null`, `-w` |
| Failure | `-f`, `--fail-with-body`, `-s`, `-S`, `-m` |

Header, data, JSON, and URL-encoded file references accept `@file`. `@-` reads
piped input or reads interactive lines until `Ctrl+D`. `-w @file` reads a
write-out format. Run `curl --help` for the exact syntax.

## Browser rules

- Cross-origin responses require CORS. Authorization and JSON commonly trigger
  a preflight.
- A simple request can reach the server even when CORS later hides its response.
  Do not blindly retry a side-effecting request after exit `7`.
- Redirects are followed only with `-L`. When Fetch hides a manual redirect,
  curl exits `47`.
- `-i` and `-D` contain only exposed headers. `HTTP/?` marks the browser's
  synthetic status line because Fetch does not expose the HTTP version. With
  `-L`, only the final response's exposed headers are available.
- Browser cookies are always omitted. TLS, proxies, content coding, HTTP
  versions, `User-Agent`, and forbidden headers cannot be controlled.
- `--connect-timeout` is rejected because Fetch does not expose the connection
  phase. Use `--max-time` for the whole transfer.

## Limits

| Data | Limit |
| --- | ---: |
| Request body | 32 MiB |
| Response body | 32 MiB |
| URL or `-G` query | 1 MiB |
| Request or response headers | 1 MiB |
| One pipeline stage | 1 MiB |

Downloads made with `-o` stream into `/home/web` and bypass the pipeline limit.
An oversized pipeline fails with `23` before its consumer runs; it is never
silently truncated. `/dev/null` and `--out-null` discard a body.

Input and output paths must stay under `/home/web`. `-O` preserves URL encoding
in the filename.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `1` | Unsupported protocol |
| `2` | Unsupported option or usage |
| `3` | Malformed URL |
| `7` | Fetch/network/TLS/CORS/browser-policy failure |
| `18` | Partial response |
| `22` | HTTP failure with `-f` |
| `23` | Output or pipeline write failure |
| `26` | Input-file failure |
| `28` | Timeout |
| `47` | Browser-hidden or failed redirect |
| `63` | Size limit |
| `130` | User abort |
