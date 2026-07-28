/**
 * WASI preview1 ABI constants and small shared types.
 *
 * Everything here is dependency-free so the host, the in-memory filesystem,
 * the worker RPC layer, and the Node test suite can all import it without
 * dragging in browser-only code.
 */

/* --------------------------------- errno -------------------------------- */

export const ERRNO = {
  SUCCESS: 0,
  E2BIG: 1,
  ACCES: 2,
  ADDRINUSE: 3,
  ADDRNOTAVAIL: 4,
  AFNOSUPPORT: 5,
  AGAIN: 6,
  ALREADY: 7,
  BADF: 8,
  BADMSG: 9,
  BUSY: 10,
  CANCELED: 11,
  CHILD: 12,
  CONNABORTED: 13,
  CONNREFUSED: 14,
  CONNRESET: 15,
  DEADLK: 16,
  DESTADDRREQ: 17,
  DOM: 18,
  DQUOT: 19,
  EXIST: 20,
  FAULT: 21,
  FBIG: 22,
  HOSTUNREACH: 23,
  IDRM: 24,
  ILSEQ: 25,
  INPROGRESS: 26,
  INTR: 27,
  INVAL: 28,
  IO: 29,
  ISCONN: 30,
  ISDIR: 31,
  LOOP: 32,
  MFILE: 33,
  MLINK: 34,
  MSGSIZE: 35,
  MULTIHOP: 36,
  NAMETOOLONG: 37,
  NETDOWN: 38,
  NETRESET: 39,
  NETUNREACH: 40,
  NFILE: 41,
  NOBUFS: 42,
  NODEV: 43,
  NOENT: 44,
  NOEXEC: 45,
  NOLCK: 46,
  NOLINK: 47,
  NOMEM: 48,
  NOMSG: 49,
  NOPROTOOPT: 50,
  NOSPC: 51,
  NOSYS: 52,
  NOTCONN: 53,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTRECOVERABLE: 56,
  NOTSOCK: 57,
  NOTSUP: 58,
  NOTTY: 59,
  NXIO: 60,
  OVERFLOW: 61,
  OWNERDEAD: 62,
  PERM: 63,
  PIPE: 64,
  PROTO: 65,
  PROTONOSUPPORT: 66,
  PROTOTYPE: 67,
  RANGE: 68,
  ROFS: 69,
  SPIPE: 70,
  SRCH: 71,
  STALE: 72,
  TIMEDOUT: 73,
  TXTBSY: 74,
  XDEV: 75,
  NOTCAPABLE: 76,
} as const;

export type Errno = (typeof ERRNO)[keyof typeof ERRNO];

/** Error thrown by filesystem backends; carries a WASI errno. */
export class WasiError extends Error {
  readonly errno: Errno;
  constructor(errno: Errno, message: string) {
    super(message);
    this.name = "WasiError";
    this.errno = errno;
  }
}

export function errnoOf(error: unknown): Errno {
  if (error instanceof WasiError) return error.errno;
  return ERRNO.IO;
}

/* -------------------------------- filetype ------------------------------- */

export const FILETYPE = {
  UNKNOWN: 0,
  BLOCK_DEVICE: 1,
  CHARACTER_DEVICE: 2,
  DIRECTORY: 3,
  REGULAR_FILE: 4,
  SOCKET_DGRAM: 5,
  SOCKET_STREAM: 6,
  SYMBOLIC_LINK: 7,
} as const;

export type Filetype = (typeof FILETYPE)[keyof typeof FILETYPE];

/* --------------------------------- rights -------------------------------- */

export const RIGHTS = {
  FD_DATASYNC: 1n << 0n,
  FD_READ: 1n << 1n,
  FD_SEEK: 1n << 2n,
  FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_SYNC: 1n << 4n,
  FD_TELL: 1n << 5n,
  FD_WRITE: 1n << 6n,
  FD_ADVISE: 1n << 7n,
  FD_ALLOCATE: 1n << 8n,
  PATH_CREATE_DIRECTORY: 1n << 9n,
  PATH_CREATE_FILE: 1n << 10n,
  PATH_LINK_SOURCE: 1n << 11n,
  PATH_LINK_TARGET: 1n << 12n,
  PATH_OPEN: 1n << 13n,
  FD_READDIR: 1n << 14n,
  PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n,
  PATH_RENAME_TARGET: 1n << 17n,
  PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n,
  PATH_FILESTAT_SET_TIMES: 1n << 20n,
  FD_FILESTAT_GET: 1n << 21n,
  FD_FILESTAT_SET_SIZE: 1n << 22n,
  FD_FILESTAT_SET_TIMES: 1n << 23n,
  PATH_SYMLINK: 1n << 24n,
  PATH_REMOVE_DIRECTORY: 1n << 25n,
  PATH_UNLINK_FILE: 1n << 26n,
  POLL_FD_READWRITE: 1n << 27n,
  SOCK_SHUTDOWN: 1n << 28n,
  SOCK_ACCEPT: 1n << 29n,
} as const;

export const RIGHTS_ALL: bigint = (1n << 30n) - 1n;

/* ------------------------------ flags / misc ----------------------------- */

/** oflags for path_open. */
export const OFLAG = {
  CREAT: 1 << 0,
  DIRECTORY: 1 << 1,
  EXCL: 1 << 2,
  TRUNC: 1 << 3,
} as const;

/** fdflags (fd_fdstat_get/set, path_open). */
export const FDFLAG = {
  APPEND: 1 << 0,
  DSYNC: 1 << 1,
  NONBLOCK: 1 << 2,
  RSYNC: 1 << 3,
  SYNC: 1 << 4,
} as const;

export const WHENCE = { SET: 0, CUR: 1, END: 2 } as const;

export const CLOCK = {
  REALTIME: 0,
  MONOTONIC: 1,
  PROCESS_CPUTIME_ID: 2,
  THREAD_CPUTIME_ID: 3,
} as const;

/** lookupflags for path_filestat_get / path_open style syscalls. */
export const LOOKUPFLAG = { SYMLINK_FOLLOW: 1 << 0 } as const;

/** fstflags for *_filestat_set_times. */
export const FSTFLAG = {
  SET_ATIM: 1 << 0,
  SET_ATIM_NOW: 1 << 1,
  SET_MTIM: 1 << 2,
  SET_MTIM_NOW: 1 << 3,
} as const;

export const ADVISE = {
  NORMAL: 0,
  SEQUENTIAL: 1,
  RANDOM: 2,
  WILLNEED: 3,
  DONTNEED: 4,
  NOREUSE: 5,
} as const;

/** eventtype for poll_oneoff. */
export const EVENTTYPE = { CLOCK: 0, FD_READ: 1, FD_WRITE: 2 } as const;

/** eventrwflags for fd_read/write subscriptions. */
export const EVENTRWFLAG = { FD_READWRITE_HANGUP: 1 << 0 } as const;

/** clock subscription flags. */
export const SUBCLOCKFLAG = { ABSTIME: 1 << 0 } as const;

/** signal numbers (proc_raise). */
export const SIGNAL = {
  NONE: 0,
  HUP: 1,
  INT: 2,
  QUIT: 3,
  ILL: 4,
  TRAP: 5,
  ABRT: 6,
  BUS: 7,
  FPE: 8,
  KILL: 9,
  USR1: 10,
  SEGV: 11,
  USR2: 12,
  PIPE: 13,
  ALRM: 14,
  TERM: 15,
  CHLD: 16,
  CONT: 17,
  STOP: 18,
  TSTP: 19,
  TTIN: 20,
  TTOU: 21,
  URG: 22,
  XCPU: 23,
  XFSZ: 24,
  VTALRM: 25,
  PROF: 26,
  WINCH: 27,
  POLL: 28,
  PWR: 29,
  SYS: 30,
} as const;

/* ------------------------------- stat record ----------------------------- */

/** Metadata returned by filesystem backends. Times are nanoseconds. */
export interface WasiStat {
  dev: bigint;
  ino: bigint;
  filetype: Filetype;
  nlink: bigint;
  size: bigint;
  atim: bigint;
  mtim: bigint;
  ctim: bigint;
}

/* ------------------------------ path helpers ----------------------------- */

/**
 * Normalize an absolute path: collapse `.`, `..`, and duplicate slashes.
 * Never escapes above `/` (extra `..` segments are dropped).
 */
export function normalizePath(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Join a base directory with a possibly-relative path, then normalize. */
export function resolvePath(base: string, path: string): string {
  if (path.startsWith("/")) return normalizePath(path);
  return normalizePath(`${base.replace(/\/+$/, "")}/${path}`);
}
