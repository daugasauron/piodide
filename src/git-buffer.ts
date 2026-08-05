/** isomorphic-git still uses the browser-compatible Buffer API internally. */
import { Buffer } from "buffer";

if (!(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer;
}
