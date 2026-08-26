const INDEX_HEADER_BYTES = 12;
const INDEX_CHECKSUM_BYTES = 20;
const INDEX_ENTRY_FIXED_BYTES = 62;
const INDEX_ENTRY_EXTENDED_BYTES = 2;
const INDEX_EXTENDED_FLAG = 0x4000;
const INDEX_STAGE_MASK = 0x3000;
const INDEX_INTENT_TO_ADD_FLAG = 0x2000;
const EMPTY_BLOB_OID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

interface ParsedIndexEntry {
  fixed: Uint8Array;
  flags: number;
  extendedFlags: number;
  pathBytes: Uint8Array;
  path: string;
  oid: string;
  stage: number;
}

interface ParsedIndex {
  version: 2 | 3;
  entries: ParsedIndexEntry[];
  extensions: Uint8Array;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function align8(value: number): number {
  return Math.ceil(value / 8) * 8;
}

function parseIndex(bytes: Uint8Array): ParsedIndex {
  if (bytes.byteLength < INDEX_HEADER_BYTES + INDEX_CHECKSUM_BYTES) {
    throw new Error("invalid Git index: truncated header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x44495243) throw new Error("invalid Git index signature");
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`unsupported Git index version: ${version}`);
  }
  const count = view.getUint32(8);
  const bodyEnd = bytes.byteLength - INDEX_CHECKSUM_BYTES;
  const entries: ParsedIndexEntry[] = [];
  let offset = INDEX_HEADER_BYTES;
  for (let index = 0; index < count; index++) {
    const start = offset;
    if (start + INDEX_ENTRY_FIXED_BYTES > bodyEnd) {
      throw new Error("invalid Git index: truncated entry");
    }
    const flags = view.getUint16(start + 60);
    const extended = Boolean(flags & INDEX_EXTENDED_FLAG);
    if (extended && version !== 3) {
      throw new Error("invalid Git index: extended entry requires version 3");
    }
    const extendedFlags = extended ? view.getUint16(start + INDEX_ENTRY_FIXED_BYTES) : 0;
    const pathStart = start + INDEX_ENTRY_FIXED_BYTES +
      (extended ? INDEX_ENTRY_EXTENDED_BYTES : 0);
    let pathEnd = pathStart;
    while (pathEnd < bodyEnd && bytes[pathEnd] !== 0) pathEnd++;
    if (pathEnd === pathStart || pathEnd >= bodyEnd) {
      throw new Error("invalid Git index pathname");
    }
    const pathBytes = bytes.slice(pathStart, pathEnd);
    let path: string;
    try {
      path = fatalDecoder.decode(pathBytes);
    } catch {
      throw new Error("Git index pathname is not valid UTF-8");
    }
    const length = align8(pathEnd - start + 1);
    offset = start + length;
    if (offset > bodyEnd) throw new Error("invalid Git index entry padding");
    entries.push({
      fixed: bytes.slice(start, start + 60),
      flags,
      extendedFlags,
      pathBytes,
      path,
      oid: hex(bytes.subarray(start + 40, start + 60)),
      stage: (flags & INDEX_STAGE_MASK) >>> 12,
    });
  }
  if (offset > bodyEnd) throw new Error("invalid Git index body");
  return {
    version: version as 2 | 3,
    entries,
    extensions: bytes.slice(offset, bodyEnd),
  };
}

async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  // Buffer.slice() is a view rather than a copy. Copy explicitly so a Node
  // Buffer passed by isomorphic-git cannot make SubtleCrypto hash its pooled
  // backing ArrayBuffer outside the requested byte range.
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-1", exact.buffer));
}

async function verifyChecksum(bytes: Uint8Array): Promise<void> {
  const body = bytes.subarray(0, bytes.byteLength - INDEX_CHECKSUM_BYTES);
  const expected = bytes.subarray(bytes.byteLength - INDEX_CHECKSUM_BYTES);
  const actual = await sha1(body);
  if (!bytesEqual(actual, expected)) {
    throw new Error(`invalid Git index checksum: expected ${hex(expected)}, saw ${hex(actual)}`);
  }
}

async function renderIndex(
  parsed: ParsedIndex,
  entries: ParsedIndexEntry[],
): Promise<Uint8Array> {
  const extended = entries.some((entry) => entry.extendedFlags !== 0);
  const version = extended ? 3 : 2;
  const renderedEntries = entries.map((entry) => {
    const hasExtended = version === 3 && entry.extendedFlags !== 0;
    const length = align8(
      INDEX_ENTRY_FIXED_BYTES + (hasExtended ? INDEX_ENTRY_EXTENDED_BYTES : 0) +
        entry.pathBytes.byteLength + 1,
    );
    const output = new Uint8Array(length);
    output.set(entry.fixed, 0);
    const view = new DataView(output.buffer);
    const flags = hasExtended
      ? entry.flags | INDEX_EXTENDED_FLAG
      : entry.flags & ~INDEX_EXTENDED_FLAG;
    view.setUint16(60, flags);
    let pathOffset = INDEX_ENTRY_FIXED_BYTES;
    if (hasExtended) {
      view.setUint16(pathOffset, entry.extendedFlags);
      pathOffset += INDEX_ENTRY_EXTENDED_BYTES;
    }
    output.set(entry.pathBytes, pathOffset);
    return output;
  });
  const bodyBytes = INDEX_HEADER_BYTES +
    renderedEntries.reduce((total, entry) => total + entry.byteLength, 0) +
    parsed.extensions.byteLength;
  const body = new Uint8Array(bodyBytes);
  const view = new DataView(body.buffer);
  view.setUint32(0, 0x44495243);
  view.setUint32(4, version);
  view.setUint32(8, entries.length);
  let offset = INDEX_HEADER_BYTES;
  for (const entry of renderedEntries) {
    body.set(entry, offset);
    offset += entry.byteLength;
  }
  body.set(parsed.extensions, offset);
  const checksum = await sha1(body);
  const output = new Uint8Array(body.byteLength + checksum.byteLength);
  output.set(body);
  output.set(checksum, body.byteLength);
  return output;
}

function assertOnlyIntentExtendedFlags(parsed: ParsedIndex): void {
  const unsupported = parsed.entries.find(
    (entry) => (entry.extendedFlags & ~INDEX_INTENT_TO_ADD_FLAG) !== 0,
  );
  if (unsupported) {
    throw new Error(`unsupported extended Git index flags at ${unsupported.path}`);
  }
}

function intentPaths(parsed: ParsedIndex): Set<string> {
  return new Set(parsed.entries.filter(
    (entry) => entry.stage === 0 &&
      Boolean(entry.extendedFlags & INDEX_INTENT_TO_ADD_FLAG),
  ).map((entry) => entry.path));
}

export function gitIndexIntentToAddPaths(bytes: Uint8Array): Set<string> {
  const parsed = parseIndex(bytes);
  assertOnlyIntentExtendedFlags(parsed);
  return intentPaths(parsed);
}

export async function gitIndexForIsomorphicGit(
  bytes: Uint8Array,
  hideIntentToAdd = false,
): Promise<Uint8Array> {
  const parsed = parseIndex(bytes);
  await verifyChecksum(bytes);
  assertOnlyIntentExtendedFlags(parsed);
  const intents = intentPaths(parsed);
  if (!intents.size && parsed.version === 2) return bytes;
  const entries = parsed.entries.filter((entry) =>
    !hideIntentToAdd || !intents.has(entry.path)
  ).map((entry) => ({ ...entry, extendedFlags: 0 }));
  return renderIndex(parsed, entries);
}

export async function preserveGitIndexIntentToAdd(
  current: Uint8Array | undefined,
  next: Uint8Array,
): Promise<Uint8Array> {
  if (!current) return next;
  const currentParsed = parseIndex(current);
  await verifyChecksum(current);
  assertOnlyIntentExtendedFlags(currentParsed);
  const currentIntents = intentPaths(currentParsed);
  if (!currentIntents.size) return next;

  const nextParsed = parseIndex(next);
  await verifyChecksum(next);
  assertOnlyIntentExtendedFlags(nextParsed);
  let preserved = false;
  const entries = nextParsed.entries.map((entry) => {
    const intent = entry.stage === 0 && entry.oid === EMPTY_BLOB_OID &&
      currentIntents.has(entry.path);
    preserved ||= intent;
    return {
      ...entry,
      extendedFlags: intent
        ? entry.extendedFlags | INDEX_INTENT_TO_ADD_FLAG
        : entry.extendedFlags & ~INDEX_INTENT_TO_ADD_FLAG,
    };
  });
  if (!preserved && nextParsed.version === 2) return next;
  return renderIndex(nextParsed, entries);
}

export async function markGitIndexIntentToAdd(
  bytes: Uint8Array,
  paths: Set<string>,
): Promise<Uint8Array> {
  const parsed = parseIndex(bytes);
  await verifyChecksum(bytes);
  assertOnlyIntentExtendedFlags(parsed);
  const found = new Set<string>();
  const entries = parsed.entries.map((entry) => {
    const selected = paths.has(entry.path);
    if (selected) {
      if (entry.stage !== 0 || entry.oid !== EMPTY_BLOB_OID) {
        throw new Error(`cannot mark nonempty or non-stage-0 index entry: ${entry.path}`);
      }
      found.add(entry.path);
    }
    return {
      ...entry,
      extendedFlags: selected
        ? entry.extendedFlags | INDEX_INTENT_TO_ADD_FLAG
        : entry.extendedFlags,
    };
  });
  for (const path of paths) {
    if (!found.has(path)) throw new Error(`intent-to-add index entry is missing: ${path}`);
  }
  return renderIndex(parsed, entries);
}
