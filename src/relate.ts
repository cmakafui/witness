// Relate through bun:ffi: the C ABI v2 of librelate_ffi, with only what Witness uses.
// Spec: https://github.com/relatedb/relate/blob/main/docs/api/c/spec.md
import { CString, dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { dirname, join } from "node:path";

const { i32, i64, u8, f64, ptr: p, void: none } = FFIType;

function libraryPath(): string {
  if (process.env.RELATE_LIB) return process.env.RELATE_LIB;
  const pkg = `@relate/relate-${process.platform}-${process.arch}`;
  const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
  return join(dirname(require.resolve(`${pkg}/package.json`)), "lib", `${process.platform === "win32" ? "" : "lib"}relate_ffi.${ext}`);
}

const { symbols: c } = dlopen(libraryPath(), {
  relate_abi_version: { args: [], returns: i32 },
  relate_free_string: { args: [p], returns: none },
  relate_database_open: { args: [p, p, p], returns: i32 },
  relate_database_open_read_only: { args: [p, p, p], returns: i32 },
  relate_database_close: { args: [p], returns: i32 },
  relate_connect_namespace: { args: [p, p, p, p], returns: i32 },
  relate_disconnect: { args: [p], returns: i32 },
  relate_query_params: { args: [p, p, p, p, p], returns: i32 },
  relate_destroy_result: { args: [p], returns: none },
  relate_result_is_error: { args: [p], returns: u8 },
  relate_result_error_json: { args: [p], returns: p },
  relate_column_count: { args: [p], returns: i64 },
  relate_row_count: { args: [p], returns: i64 },
  relate_column_name: { args: [p, i64], returns: p },
  relate_value_at: { args: [p, i64, i64], returns: p },
  relate_value_kind: { args: [p], returns: i32 },
  relate_value_bool: { args: [p, p], returns: i32 },
  relate_value_int: { args: [p, p], returns: i32 },
  relate_value_float: { args: [p, p], returns: i32 },
  relate_value_string: { args: [p, p], returns: p },
  relate_value_list_len: { args: [p], returns: i64 },
  relate_value_list_get: { args: [p, i64], returns: p },
  relate_value_map_len: { args: [p], returns: i64 },
  relate_value_map_key: { args: [p, i64, p], returns: p },
  relate_value_map_get: { args: [p, p], returns: p },
  relate_value_element_id: { args: [p], returns: p },
  relate_params_new: { args: [], returns: p },
  relate_params_free: { args: [p], returns: none },
  relate_params_put_string: { args: [p, p, p, i64, p], returns: i32 },
  relate_params_put_int: { args: [p, p, i64, p], returns: i32 },
  relate_params_put_bool: { args: [p, p, u8, p], returns: i32 },
  relate_params_put_null: { args: [p, p, p], returns: i32 },
  relate_params_put_list: { args: [p, p, p, p], returns: i32 },
});

if (c.relate_abi_version() !== 2) throw new Error(`librelate_ffi ABI ${c.relate_abi_version()}, expected 2`);

const OK = 0;
const V = { NULL: 0, BOOL: 1, INT: 2, FLOAT: 3, STRING: 4, NODE: 5, RELATIONSHIP: 6, PATH: 7, LIST: 8, MAP: 9 } as const;

export class RelateError extends Error {
  constructor(readonly detail: { code?: string; message?: string; kind?: string; [k: string]: unknown }) {
    super(detail.message ?? JSON.stringify(detail));
  }
}

const text = (s: string) => Buffer.from(`${s}\0`);
const slot = () => new BigUint64Array(1);
/** A pointer as bun:ffi returns it: a number, or a bigint for an address above 2^53. */
type Ptr = Pointer | bigint;

const at = (s: BigUint64Array) => Number(s[0]) as Pointer;

/** Reads and frees a caller-owned error string, then throws it. */
function fail(err: BigUint64Array, what: string): never {
  const e = at(err);
  if (!e) throw new RelateError({ message: `${what} failed` });
  const json = String(new CString(e));
  c.relate_free_string(e);
  throw new RelateError(JSON.parse(json));
}

const str = (q: Ptr | null) => (q ? String(new CString(q as Pointer)) : null);

export type Value = null | boolean | number | bigint | string | Value[] | { [k: string]: Value } | Entity;
export type Entity = { elementId: string; properties: { [k: string]: Value }; labels?: string[] };

function decode(v: Ptr | null): Value {
  if (!v) return null;
  const kind = c.relate_value_kind(v);
  switch (kind) {
    case V.NULL:
      return null;
    case V.BOOL: {
      const o = new Uint8Array(1);
      c.relate_value_bool(v, ptr(o));
      return o[0] === 1;
    }
    case V.INT: {
      const o = new BigInt64Array(1);
      c.relate_value_int(v, ptr(o));
      const n = o[0]!;
      return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
    }
    case V.FLOAT: {
      const o = new Float64Array(1);
      c.relate_value_float(v, ptr(o));
      return o[0]!;
    }
    case V.STRING:
      return str(c.relate_value_string(v, null));
    case V.LIST:
    case V.PATH: {
      const n = Number(c.relate_value_list_len(v));
      return Array.from({ length: n }, (_, i) => decode(c.relate_value_list_get(v, i)));
    }
    case V.MAP:
      return entries(v);
    case V.NODE: {
      // A node's list view is its labels; its map view is its properties.
      const n = Number(c.relate_value_list_len(v));
      const labels = Array.from({ length: n }, (_, i) => decode(c.relate_value_list_get(v, i)) as string);
      return { elementId: str(c.relate_value_element_id(v))!, labels, properties: entries(v) };
    }
    case V.RELATIONSHIP:
      return { elementId: str(c.relate_value_element_id(v))!, properties: entries(v) };
    default:
      throw new Error(`Relate value kind ${kind} is not handled yet`);
  }
}

function entries(v: Ptr): { [k: string]: Value } {
  const out: { [k: string]: Value } = {};
  const n = Number(c.relate_value_map_len(v));
  for (let i = 0; i < n; i++) {
    const key = str(c.relate_value_map_key(v, i, null))!;
    out[key] = decode(c.relate_value_map_get(v, ptr(text(key))));
  }
  return out;
}

export type Param = string | number | boolean | null | string[];

function params(values: Record<string, Param>): Ptr {
  const root = c.relate_params_new()!;
  const err = slot();
  for (const [name, v] of Object.entries(values)) {
    const key = ptr(text(name));
    let status: number;
    if (v === null) status = c.relate_params_put_null(root, key, ptr(err));
    else if (typeof v === "string") {
      const bytes = Buffer.from(v);
      status = c.relate_params_put_string(root, key, bytes.length ? ptr(bytes) : null, bytes.length, ptr(err));
    } else if (typeof v === "boolean") status = c.relate_params_put_bool(root, key, v ? 1 : 0, ptr(err));
    else if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new Error(`parameter ${name}: only integers are handled yet`);
      status = c.relate_params_put_int(root, key, v, ptr(err));
    } else {
      const child = slot();
      status = c.relate_params_put_list(root, key, ptr(child), ptr(err));
      if (status === OK)
        for (const s of v) {
          const bytes = Buffer.from(s);
          // A list child takes its items with a null name.
          status = c.relate_params_put_string(at(child), null, bytes.length ? ptr(bytes) : null, bytes.length, ptr(err));
          if (status !== OK) break;
        }
    }
    if (status !== OK) {
      c.relate_params_free(root);
      fail(err, `parameter ${name}`);
    }
  }
  return root;
}

export type Row = Record<string, Value>;

export class Relate {
  private constructor(
    private db: Pointer,
    private conn: Pointer,
  ) {}

  /** Opens a store: ":memory:", a directory, or a .rl file. Read-only opens never write. */
  static open(uri: string, { readOnly = false } = {}): Relate {
    const out = slot();
    const err = slot();
    const open = readOnly ? c.relate_database_open_read_only : c.relate_database_open;
    if (open(ptr(text(uri)), ptr(out), ptr(err)) !== OK) fail(err, `open ${uri}`);
    const db = at(out);
    const conn = slot();
    if (c.relate_connect_namespace(db, null, ptr(conn), ptr(err)) !== OK) {
      c.relate_database_close(db);
      fail(err, "connect");
    }
    return new Relate(db, at(conn));
  }

  /** Runs one statement and returns its rows. A rejected statement throws RelateError. */
  query(cypher: string, values: Record<string, Param> = {}): Row[] {
    const bound = Object.keys(values).length ? params(values) : null;
    const out = slot();
    const err = slot();
    try {
      if (c.relate_query_params(this.conn, ptr(text(cypher)), bound, ptr(out), ptr(err)) !== OK) fail(err, "query");
    } finally {
      if (bound) c.relate_params_free(bound);
    }
    const r = at(out);
    try {
      if (c.relate_result_is_error(r)) throw new RelateError(JSON.parse(str(c.relate_result_error_json(r))!));
      const cols = Array.from({ length: Number(c.relate_column_count(r)) }, (_, i) => str(c.relate_column_name(r, i))!);
      const rows = Number(c.relate_row_count(r));
      return Array.from({ length: rows }, (_, row) => Object.fromEntries(cols.map((name, col) => [name, decode(c.relate_value_at(r, row, col))])));
    } finally {
      c.relate_destroy_result(r);
    }
  }

  close() {
    c.relate_disconnect(this.conn);
    c.relate_database_close(this.db);
  }
}
