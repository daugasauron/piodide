"""Replace the linked piodide_spawn placeholder with the current piodide.spawn import.

The bounded linker intentionally rejects unresolved non-WASI symbols.  We link
with one tiny placeholder, export it so its index is unambiguous, then use this
small structural rewrite.  No code or data is copied beyond the module size.
"""
from pathlib import Path
import sys


def read_u(data, pos):
    value = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7f) << shift
        if byte < 0x80:
            return value, pos
        shift += 7


def read_s(data, pos, bits=64):
    value = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7f) << shift
        shift += 7
        if byte < 0x80:
            if shift < bits and byte & 0x40:
                value |= -(1 << shift)
            return value, pos


def enc_u(value):
    out = bytearray()
    while True:
        byte = value & 0x7f
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def enc_str(text):
    raw = text.encode()
    return enc_u(len(raw)) + raw


def take_u(raw, p, out):
    _, q = read_u(raw, p)
    out += raw[p:q]
    return q


def take_s(raw, p, out, bits=64):
    _, q = read_s(raw, p, bits)
    out += raw[p:q]
    return q


def transform_instructions(raw, remap):
    """Rewrite function indices in a validated Clang-8-era instruction stream."""
    p = 0
    out = bytearray()
    no_immediate = set(range(0x00, 0x02)) | set(range(0x0f, 0x10)) | set(range(0x1a, 0x1c))
    no_immediate |= set(range(0x45, 0xc5)) | {0x05, 0x0b, 0xd0, 0xd1}
    while p < len(raw):
        op = raw[p]
        p += 1
        out.append(op)
        if op in no_immediate:
            # ref.null (d0) actually has a heap type immediate; not emitted by
            # this legacy toolchain. Keep explicit support for standard types.
            if op == 0xd0:
                out.append(raw[p]); p += 1
        elif op in (0x02, 0x03, 0x04):              # block type
            p = take_s(raw, p, out, 33)
        elif op in (0x0c, 0x0d):                    # branch depth
            p = take_u(raw, p, out)
        elif op == 0x0e:                            # br_table
            n, q = read_u(raw, p); out += raw[p:q]; p = q
            for _ in range(n + 1): p = take_u(raw, p, out)
        elif op == 0x10:                            # call
            index, p = read_u(raw, p)
            out += enc_u(remap(index))
        elif op == 0x11:                            # call_indirect
            p = take_u(raw, p, out)
            p = take_u(raw, p, out)
        elif op in range(0x20, 0x25):               # local/global index
            p = take_u(raw, p, out)
        elif op in range(0x28, 0x3f):               # memory alignment, offset
            p = take_u(raw, p, out); p = take_u(raw, p, out)
        elif op in (0x3f, 0x40):                    # memory index
            p = take_u(raw, p, out)
        elif op == 0x41:
            p = take_s(raw, p, out, 32)
        elif op == 0x42:
            p = take_s(raw, p, out, 64)
        elif op == 0x43:
            out += raw[p:p+4]; p += 4
        elif op == 0x44:
            out += raw[p:p+8]; p += 8
        elif op == 0x1c:                            # typed select
            n, q = read_u(raw, p); out += raw[p:q]; p = q
            out += raw[p:p+n]; p += n
        elif op == 0xd2:                            # ref.func
            index, p = read_u(raw, p); out += enc_u(remap(index))
        elif op == 0xfc:
            sub, q = read_u(raw, p); out += raw[p:q]; p = q
            counts = {8: 2, 9: 1, 10: 2, 11: 1, 12: 2, 13: 1,
                      14: 2, 15: 1, 16: 1, 17: 1}
            for _ in range(counts.get(sub, 0)): p = take_u(raw, p, out)
        else:
            raise ValueError(f"unsupported wasm opcode 0x{op:02x}")
    return bytes(out)


def parse_sections(module):
    if module[:8] != b"\0asm\x01\0\0\0":
        raise ValueError("not a WebAssembly 1 module")
    sections = []
    p = 8
    while p < len(module):
        sid = module[p]; p += 1
        size, p = read_u(module, p)
        sections.append([sid, module[p:p+size]])
        p += size
    return sections


def patch(src, dst):
    source_name = Path(src).name
    if source_name.startswith("env."):
        import_name = "spawn_v8"
    elif source_name.startswith(("slop.", "git.")):
        import_name = "spawn_v7"
    else:
        import_name = "spawn_v3"
    sections = parse_sections(Path(src).read_bytes())
    import_funcs = 0
    stub_index = stub_type = stub_position = None

    # Discover imported-function count and exported placeholder index.
    for sid, payload in sections:
        if sid == 2:
            n, p = read_u(payload, 0)
            for _ in range(n):
                z, p = read_u(payload, p); p += z
                z, p = read_u(payload, p); p += z
                kind = payload[p]; p += 1
                if kind == 0:
                    _, p = read_u(payload, p); import_funcs += 1
                elif kind == 1:
                    p += 1; flags, p = read_u(payload, p); _, p = read_u(payload, p)
                    if flags & 1: _, p = read_u(payload, p)
                elif kind == 2:
                    flags, p = read_u(payload, p); _, p = read_u(payload, p)
                    if flags & 1: _, p = read_u(payload, p)
                elif kind == 3:
                    p += 2
                else:
                    raise ValueError("unknown import kind")
        elif sid == 7:
            n, p = read_u(payload, 0)
            for _ in range(n):
                z, p = read_u(payload, p); name = payload[p:p+z].decode(); p += z
                kind = payload[p]; p += 1
                index, p = read_u(payload, p)
                if name == "piodide_spawn" and kind == 0:
                    stub_index = index
    if stub_index is None or stub_index < import_funcs:
        raise ValueError("exported piodide_spawn placeholder not found")
    stub_position = stub_index - import_funcs

    # Find its type from the function section.
    for sid, payload in sections:
        if sid == 3:
            n, p = read_u(payload, 0)
            types = []
            for _ in range(n):
                x, p = read_u(payload, p); types.append(x)
            stub_type = types[stub_position]
            break
    if stub_type is None:
        raise ValueError("function section not found")

    # New import occupies the old first-defined index. Removing the placeholder
    # means definitions after it retain their old indices; only definitions
    # before it shift by one.
    def remap(index):
        if index == stub_index:
            return import_funcs
        if import_funcs <= index < stub_index:
            return index + 1
        return index

    rewritten = []
    for sid, payload in sections:
        if sid == 2:
            n, p = read_u(payload, 0)
            entry = enc_str("piodide") + enc_str(import_name) + b"\x00" + enc_u(stub_type)
            payload = enc_u(n + 1) + payload[p:] + entry
        elif sid == 3:
            n, p = read_u(payload, 0); items = []
            for _ in range(n):
                q = p; _, p = read_u(payload, p); items.append(payload[q:p])
            del items[stub_position]
            payload = enc_u(n - 1) + b"".join(items)
        elif sid == 7:
            n, p = read_u(payload, 0); out = bytearray(enc_u(n))
            for _ in range(n):
                z, q = read_u(payload, p); out += payload[p:q+z]; name_end = q + z; p = name_end
                kind = payload[p]; out.append(kind); p += 1
                index, p = read_u(payload, p)
                out += enc_u(remap(index) if kind == 0 else index)
            payload = bytes(out)
        elif sid == 8:
            index, p = read_u(payload, 0)
            payload = enc_u(remap(index)) + payload[p:]
        elif sid == 9:
            # This toolchain emits legacy active segments (flag 0).
            n, p = read_u(payload, 0); out = bytearray(enc_u(n))
            for _ in range(n):
                flags, q = read_u(payload, p); out += payload[p:q]; p = q
                if flags != 0:
                    raise ValueError("unexpected modern element segment")
                # Copy i32.const offset expression through end opcode.
                start = p
                while payload[p] != 0x0b: p += 1
                p += 1; out += payload[start:p]
                count, q = read_u(payload, p); out += enc_u(count); p = q
                for _ in range(count):
                    index, p = read_u(payload, p); out += enc_u(remap(index))
            payload = bytes(out)
        elif sid == 10:
            n, p = read_u(payload, 0); bodies = []
            for _ in range(n):
                size, p = read_u(payload, p); bodies.append(payload[p:p+size]); p += size
            del bodies[stub_position]
            out = bytearray(enc_u(n - 1))
            for body in bodies:
                local_count, p = read_u(body, 0); prefix_end = p
                for _ in range(local_count):
                    _, prefix_end = read_u(body, prefix_end); prefix_end += 1
                code = transform_instructions(body[prefix_end:], remap)
                new_body = body[:prefix_end] + code
                out += enc_u(len(new_body)) + new_body
            payload = bytes(out)
        rewritten.append((sid, payload))

    out = bytearray(b"\0asm\x01\0\0\0")
    for sid, payload in rewritten:
        out.append(sid); out += enc_u(len(payload)); out += payload
    Path(dst).write_bytes(out)
    print(f"patched {src} -> {dst}: piodide.{import_name} is function import {import_funcs}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: patch_import.py input.wasm output.wasm")
    patch(sys.argv[1], sys.argv[2])
