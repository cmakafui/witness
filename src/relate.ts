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
  relate_conn_begin: { args: [p, p], returns: i32 },
  relate_conn_commit: { args: [p, p, p], returns: i32 },
  relate_conn_rollback: { args: [p, p], returns: i32 },
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
  relate_params_put_float: { args: [p, p, f64, p], returns: i32 },
  relate_params_put_bool: { args: [p, p, u8, p], returns: i32 },
  relate_params_put_null: { args: [p, p, p], returns: i32 },
  relate_params_put_list: { args: [p, p, p, p], returns: i32 },
  relate_params_put_map: { args: [p, p, p, p], returns: i32 },
});

if (c.relate_abi_version() !== 2) throw new Error(`librelate_ffi ABI ${c.relate_abi_version()}, expected 2`);

const OK = 0;
const V = { NULL: 0, BOOL: 1, INT: 2, FLOAT: 3, STRING: 4, NODE: 5, RELATIONSHIP: 6, PATH: 7, LIST: 8, MAP: 9 } as const;

export class RelateError extends Error {
  constructor(readonly detail: { code?: string; message?: string; [k: string]: unknown }) {
    super(detail.message ?? JSON.stringify(detail));
  }
}

/** A pointer as bun:ffi returns it: a number, or a bigint for an address above 2^53. */
type Ptr = Pointer | bigint;

const text = (s: string) => Buffer.from(`${s}\0`);
const slot = () => new BigUint64Array(1);
const at = (s: BigUint64Array) => Number(s[0]) as Pointer;
const str = (q: Ptr | null) => (q ? String(new CString(q as Pointer)) : null);

/** Reads and frees a caller-owned error string, then throws it. */
function fail(err: BigUint64Array, what: string): never {
  const e = at(err);
  if (!e) throw new RelateError({ message: `${what} failed` });
  const json = String(new CString(e));
  c.relate_free_string(e);
  throw new RelateError(JSON.parse(json));
}

export type Value = null | boolean | number | bigint | string | Value[] | { [k: string]: Value };

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
    case V.PATH:
      return Array.from({ length: Number(c.relate_value_list_len(v)) }, (_, i) => decode(c.relate_value_list_get(v, i)));
    case V.MAP:
    case V.NODE: // a node or relationship reads as its properties; queries return the fields they need
    case V.RELATIONSHIP: {
      const out: { [k: string]: Value } = {};
      const n = Number(c.relate_value_map_len(v));
      for (let i = 0; i < n; i++) {
        const key = str(c.relate_value_map_key(v, i, null))!;
        out[key] = decode(c.relate_value_map_get(v, ptr(text(key))));
      }
      return out;
    }
    default:
      throw new Error(`Relate value kind ${kind} is not handled`);
  }
}

export type Param = null | boolean | number | string | Param[] | { [k: string]: Param };

/** Puts one value into a builder. A map takes a name; a list takes null and appends. */
function put(builder: Ptr, name: string | null, v: Param, err: BigUint64Array): number {
  const key = name === null ? null : ptr(text(name));
  if (v === null || v === undefined) return c.relate_params_put_null(builder, key, ptr(err));
  if (typeof v === "boolean") return c.relate_params_put_bool(builder, key, v ? 1 : 0, ptr(err));
  if (typeof v === "number")
    return Number.isSafeInteger(v) ? c.relate_params_put_int(builder, key, v, ptr(err)) : c.relate_params_put_float(builder, key, v, ptr(err));
  if (typeof v === "string") {
    const bytes = Buffer.from(v);
    return c.relate_params_put_string(builder, key, bytes.length ? ptr(bytes) : null, bytes.length, ptr(err));
  }
  const child = slot();
  const list = Array.isArray(v);
  const status = (list ? c.relate_params_put_list : c.relate_params_put_map)(builder, key, ptr(child), ptr(err));
  if (status !== OK) return status;
  for (const [k, item] of list ? v.map((x) => [null, x] as const) : Object.entries(v)) {
    const s = put(at(child), k, item, err);
    if (s !== OK) return s;
  }
  return OK;
}

export type Row = Record<string, Value>;

export class Relate {
  private constructor(
    private db: Ptr,
    private conn: Ptr,
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
    const err = slot();
    let bound: Ptr | null = null;
    if (Object.keys(values).length) {
      bound = c.relate_params_new()!;
      for (const [k, v] of Object.entries(values))
        if (put(bound, k, v, err) !== OK) {
          c.relate_params_free(bound);
          fail(err, `parameter ${k}`);
        }
    }
    const out = slot();
    try {
      if (c.relate_query_params(this.conn, ptr(text(cypher)), bound, ptr(out), ptr(err)) !== OK) fail(err, "query");
    } finally {
      if (bound) c.relate_params_free(bound);
    }
    const r = at(out);
    try {
      if (c.relate_result_is_error(r)) throw new RelateError(JSON.parse(str(c.relate_result_error_json(r))!));
      const cols = Array.from({ length: Number(c.relate_column_count(r)) }, (_, i) => str(c.relate_column_name(r, i))!);
      return Array.from({ length: Number(c.relate_row_count(r)) }, (_, row) =>
        Object.fromEntries(cols.map((name, col) => [name, decode(c.relate_value_at(r, row, col))])),
      );
    } finally {
      c.relate_destroy_result(r);
    }
  }

  /** Runs fn in one transaction: all of its statements commit, or none do. */
  transaction<T>(fn: () => T): T {
    const err = slot();
    if (c.relate_conn_begin(this.conn, ptr(err)) !== OK) fail(err, "begin");
    try {
      const result = fn();
      const bookmark = slot();
      if (c.relate_conn_commit(this.conn, ptr(bookmark), ptr(err)) !== OK) fail(err, "commit");
      if (at(bookmark)) c.relate_free_string(at(bookmark));
      return result;
    } catch (e) {
      c.relate_conn_rollback(this.conn, null);
      throw e;
    }
  }

  close() {
    c.relate_disconnect(this.conn);
    c.relate_database_close(this.db);
  }
}
