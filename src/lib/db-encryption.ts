import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  blindIndex,
  blindIndexCandidates,
  decryptField,
  decryptJson,
  encryptField,
  encryptJson,
  isEncryptedString,
  type BlindIndexContext,
} from "./crypto";

if (typeof window !== "undefined") {
  throw new Error("Security violation: src/lib/db-encryption.ts must never be imported in browser code.");
}

type BlindIndexSpec = {
  hashColumn: string;
  context: BlindIndexContext;
};

export type ModelEncryptionSpec = {
  readonly fields: readonly string[];
  readonly jsonFields: readonly string[];
  readonly blindIndexes: Readonly<Record<string, BlindIndexSpec>>;
};

/**
 * Authoritative specification of all PII, PHI, and confidential records encrypted at rest
 * in PostgreSQL using AES-256-GCM with column-bound AAD (`Model:field`).
 */
export const ENCRYPTED_MODELS: Readonly<Record<string, ModelEncryptionSpec>> = {
  User: {
    fields: ["name", "email", "phone"],
    jsonFields: [],
    blindIndexes: {
      email: { hashColumn: "emailHash", context: "User:email" },
      phone: { hashColumn: "phoneHash", context: "User:phone" },
    },
  },
  Customer: {
    fields: ["dateOfBirth", "gender", "notes"],
    jsonFields: [],
    blindIndexes: {},
  },
  Employee: {
    fields: ["licenseNo"],
    jsonFields: [],
    blindIndexes: {},
  },
  Address: {
    fields: ["fullName", "phone", "commune", "village", "street", "instructions"],
    jsonFields: [],
    blindIndexes: {},
  },
  Order: {
    fields: [
      "fullName",
      "phone",
      "email",
      "commune",
      "village",
      "street",
      "instructions",
      "prescriptionNote",
      "notes",
      "cancelReason",
    ],
    jsonFields: [],
    blindIndexes: {
      phone: { hashColumn: "phoneHash", context: "Order:phone" },
      email: { hashColumn: "emailHash", context: "Order:email" },
    },
  },
  Payment: {
    fields: ["payerInfo", "qrString"],
    jsonFields: [],
    blindIndexes: {},
  },
  PaymentTransaction: {
    fields: [],
    jsonFields: ["raw"],
    blindIndexes: {},
  },
  Supplier: {
    fields: ["contactName", "phone", "email", "address", "taxId", "notes"],
    jsonFields: [],
    blindIndexes: {},
  },
  Session: {
    fields: ["ip", "userAgent"],
    jsonFields: [],
    blindIndexes: {},
  },
  PasswordResetToken: {
    fields: ["ip"],
    jsonFields: [],
    blindIndexes: {},
  },
  AuditLog: {
    fields: ["ip"],
    jsonFields: ["meta"],
    blindIndexes: {},
  },
  Notification: {
    fields: ["message"],
    jsonFields: [],
    blindIndexes: {},
  },
};

/** Build relation graph from Prisma DMMF so nested writes and includes are traversed accurately. */
const MODEL_RELATIONS: ReadonlyMap<string, ReadonlyMap<string, string>> = (() => {
  const map = new Map<string, Map<string, string>>();
  for (const m of Prisma.dmmf.datamodel.models) {
    const rels = new Map<string, string>();
    for (const f of m.fields) {
      if (f.kind === "object") {
        rels.set(f.name, f.type);
      }
    }
    map.set(m.name, rels);
  }
  return map;
})();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  if (v instanceof Date || v instanceof Uint8Array || Buffer.isBuffer(v)) return false;
  if (Prisma.Decimal.isDecimal(v)) return false;
  if (v === Prisma.DbNull || v === Prisma.JsonNull || v === Prisma.AnyNull) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const RELATION_FILTER_KEYS = new Set(["is", "isNot", "some", "every", "none"]);

function transformBlindIndexFilter(
  val: unknown,
  bi: BlindIndexSpec,
  isUniqueWhere: boolean,
): { replaced: boolean; value: unknown } {
  if (val === null) {
    return { replaced: true, value: null };
  }
  if (typeof val === "string") {
    if (isUniqueWhere) {
      return { replaced: true, value: blindIndex(val, bi.context) };
    }
    const cands = blindIndexCandidates(val, bi.context);
    return { replaced: true, value: cands.length === 1 ? cands[0] : { in: cands } };
  }
  if (isPlainObject(val)) {
    const filter: Record<string, unknown> = {};
    let handled = false;
    if ("equals" in val) {
      handled = true;
      if (val.equals === null) {
        filter.equals = null;
      } else if (typeof val.equals === "string") {
        const cands = blindIndexCandidates(val.equals, bi.context);
        if (isUniqueWhere || cands.length === 1) {
          filter.equals = cands[0];
        } else {
          filter.in = cands;
        }
      }
    }
    if ("in" in val && Array.isArray(val.in)) {
      handled = true;
      const all: string[] = [];
      for (const item of val.in) {
        if (typeof item === "string") {
          for (const h of blindIndexCandidates(item, bi.context)) {
            if (!all.includes(h)) all.push(h);
          }
        }
      }
      filter.in = all;
    }
    if ("notIn" in val && Array.isArray(val.notIn)) {
      handled = true;
      const all: string[] = [];
      for (const item of val.notIn) {
        if (typeof item === "string") {
          for (const h of blindIndexCandidates(item, bi.context)) {
            if (!all.includes(h)) all.push(h);
          }
        }
      }
      filter.notIn = all;
    }
    if ("not" in val) {
      handled = true;
      if (val.not === null) {
        filter.not = null;
      } else if (typeof val.not === "string") {
        const cands = blindIndexCandidates(val.not, bi.context);
        filter.not = cands.length === 1 ? cands[0] : { in: cands };
      } else if (isPlainObject(val.not)) {
        const nested = transformBlindIndexFilter(val.not, bi, false);
        filter.not = nested.replaced ? nested.value : val.not;
      }
    }
    if (handled) {
      return { replaced: true, value: filter };
    }
  }
  return { replaced: false, value: val };
}

export function transformWhere(model: string, where: unknown, isUniqueWhere = false): unknown {
  if (!isPlainObject(where)) return where;

  const spec = ENCRYPTED_MODELS[model];
  const rels = MODEL_RELATIONS.get(model);
  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(where)) {
    if (val === undefined) continue;

    if (key === "AND" || key === "OR" || key === "NOT") {
      out[key] = Array.isArray(val)
        ? val.map((item) => transformWhere(model, item, false))
        : transformWhere(model, val, false);
      continue;
    }

    const bi = spec?.blindIndexes[key];
    if (bi) {
      const res = transformBlindIndexFilter(val, bi, isUniqueWhere);
      if (res.replaced) {
        out[bi.hashColumn] = res.value;
        continue;
      }
    }

    const targetModel = rels?.get(key);
    if (targetModel && isPlainObject(val)) {
      const hasRelOp = Object.keys(val).some((k) => RELATION_FILTER_KEYS.has(k));
      if (hasRelOp) {
        const relOut: Record<string, unknown> = {};
        for (const [op, opVal] of Object.entries(val)) {
          relOut[op] =
            RELATION_FILTER_KEYS.has(op) && isPlainObject(opVal)
              ? transformWhere(targetModel, opVal, false)
              : opVal;
        }
        out[key] = relOut;
      } else {
        out[key] = transformWhere(targetModel, val, false);
      }
      continue;
    }

    out[key] = val;
  }

  return out;
}

function transformNestedRelationWrite(targetModel: string, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = { ...value };

  if ("create" in out && out.create !== undefined) {
    out.create = transformWriteData(targetModel, out.create);
  }
  if ("createMany" in out && isPlainObject(out.createMany) && out.createMany.data !== undefined) {
    out.createMany = {
      ...out.createMany,
      data: transformWriteData(targetModel, out.createMany.data),
    };
  }
  if ("update" in out && out.update !== undefined) {
    if (Array.isArray(out.update)) {
      out.update = out.update.map((u) =>
        isPlainObject(u) && ("where" in u || "data" in u)
          ? {
              ...u,
              ...("where" in u ? { where: transformWhere(targetModel, u.where, true) } : {}),
              ...("data" in u ? { data: transformWriteData(targetModel, u.data) } : {}),
            }
          : transformWriteData(targetModel, u),
      );
    } else if (isPlainObject(out.update) && ("where" in out.update || "data" in out.update)) {
      out.update = {
        ...out.update,
        ...("where" in out.update ? { where: transformWhere(targetModel, out.update.where, true) } : {}),
        ...("data" in out.update ? { data: transformWriteData(targetModel, out.update.data) } : {}),
      };
    } else {
      out.update = transformWriteData(targetModel, out.update);
    }
  }
  if ("updateMany" in out && out.updateMany !== undefined) {
    const mapUm = (u: unknown) =>
      isPlainObject(u)
        ? {
            ...u,
            ...("where" in u ? { where: transformWhere(targetModel, u.where, false) } : {}),
            ...("data" in u ? { data: transformWriteData(targetModel, u.data) } : {}),
          }
        : u;
    out.updateMany = Array.isArray(out.updateMany) ? out.updateMany.map(mapUm) : mapUm(out.updateMany);
  }
  if ("upsert" in out && out.upsert !== undefined) {
    const mapUpsert = (u: unknown) =>
      isPlainObject(u)
        ? {
            ...u,
            ...("where" in u ? { where: transformWhere(targetModel, u.where, true) } : {}),
            ...("create" in u ? { create: transformWriteData(targetModel, u.create) } : {}),
            ...("update" in u ? { update: transformWriteData(targetModel, u.update) } : {}),
          }
        : u;
    out.upsert = Array.isArray(out.upsert) ? out.upsert.map(mapUpsert) : mapUpsert(out.upsert);
  }
  if ("connectOrCreate" in out && out.connectOrCreate !== undefined) {
    const mapCoc = (u: unknown) =>
      isPlainObject(u)
        ? {
            ...u,
            ...("where" in u ? { where: transformWhere(targetModel, u.where, true) } : {}),
            ...("create" in u ? { create: transformWriteData(targetModel, u.create) } : {}),
          }
        : u;
    out.connectOrCreate = Array.isArray(out.connectOrCreate)
      ? out.connectOrCreate.map(mapCoc)
      : mapCoc(out.connectOrCreate);
  }
  if ("connect" in out && out.connect !== undefined) {
    out.connect = Array.isArray(out.connect)
      ? out.connect.map((c) => transformWhere(targetModel, c, true))
      : transformWhere(targetModel, out.connect, true);
  }
  if ("delete" in out && out.delete !== undefined && typeof out.delete !== "boolean") {
    out.delete = Array.isArray(out.delete)
      ? out.delete.map((d) => transformWhere(targetModel, d, true))
      : transformWhere(targetModel, out.delete, true);
  }
  if ("deleteMany" in out && out.deleteMany !== undefined) {
    out.deleteMany = Array.isArray(out.deleteMany)
      ? out.deleteMany.map((d) => transformWhere(targetModel, d, false))
      : transformWhere(targetModel, out.deleteMany, false);
  }

  return out;
}

export function transformWriteData(model: string, data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => transformWriteData(model, item));
  }
  if (!isPlainObject(data)) return data;

  const spec = ENCRYPTED_MODELS[model];
  const rels = MODEL_RELATIONS.get(model);
  const out: Record<string, unknown> = { ...data };

  if (spec) {
    for (const field of spec.fields) {
      if (!(field in out) || out[field] === undefined) continue;
      const raw = out[field];
      const bi = spec.blindIndexes[field];
      const aad = `${model}:${field}`;

      if (isPlainObject(raw) && "set" in raw && Object.keys(raw).length === 1) {
        const inner = raw.set;
        if (typeof inner === "string") {
          if (bi) {
            const plain = isEncryptedString(inner) ? decryptField(inner, aad) : inner;
            out[bi.hashColumn] = { set: blindIndex(plain, bi.context) };
          }
          out[field] = { set: encryptField(inner, aad) };
        } else if (inner === null) {
          if (bi) out[bi.hashColumn] = { set: null };
        }
      } else if (typeof raw === "string") {
        if (bi) {
          const plain = isEncryptedString(raw) ? decryptField(raw, aad) : raw;
          out[bi.hashColumn] = blindIndex(plain, bi.context);
        }
        out[field] = encryptField(raw, aad);
      } else if (raw === null) {
        if (bi) out[bi.hashColumn] = null;
      }
    }

    for (const jField of spec.jsonFields) {
      if (!(jField in out) || out[jField] === undefined || out[jField] === null) continue;
      const raw = out[jField];
      if (raw === Prisma.DbNull || raw === Prisma.JsonNull || raw === Prisma.AnyNull) continue;
      out[jField] = encryptJson(raw, `${model}:${jField}`);
    }
  }

  if (rels) {
    for (const [relName, targetModel] of rels) {
      if (relName in out && isPlainObject(out[relName])) {
        out[relName] = transformNestedRelationWrite(targetModel, out[relName]);
      }
    }
  }

  return out;
}

function transformIncludeOrSelect(model: string, obj: unknown): unknown {
  if (!isPlainObject(obj)) return obj;
  const rels = MODEL_RELATIONS.get(model);
  if (!rels) return obj;

  let changed = false;
  const out: Record<string, unknown> = { ...obj };
  for (const [key, val] of Object.entries(obj)) {
    const target = rels.get(key);
    if (!target || !isPlainObject(val)) continue;
    const nested: Record<string, unknown> = { ...val };
    let nestedChanged = false;
    if ("where" in nested && isPlainObject(nested.where)) {
      nested.where = transformWhere(target, nested.where, false);
      nestedChanged = true;
    }
    if ("include" in nested && isPlainObject(nested.include)) {
      nested.include = transformIncludeOrSelect(target, nested.include);
      nestedChanged = true;
    }
    if ("select" in nested && isPlainObject(nested.select)) {
      nested.select = transformIncludeOrSelect(target, nested.select);
      nestedChanged = true;
    }
    if (nestedChanged) {
      out[key] = nested;
      changed = true;
    }
  }
  return changed ? out : obj;
}

export function decryptResult<T>(model: string, result: T): T {
  if (result === null || result === undefined) return result;
  if (Array.isArray(result)) {
    for (let i = 0; i < result.length; i++) {
      result[i] = decryptResult(model, result[i]);
    }
    return result;
  }
  if (!isPlainObject(result)) return result;

  const obj = result as Record<string, unknown>;
  const spec = ENCRYPTED_MODELS[model];
  const rels = MODEL_RELATIONS.get(model);

  if (spec) {
    for (const field of spec.fields) {
      if (field in obj && typeof obj[field] === "string") {
        obj[field] = decryptField(obj[field], `${model}:${field}`);
      }
    }
    for (const jField of spec.jsonFields) {
      if (jField in obj && obj[jField] !== null && obj[jField] !== undefined) {
        obj[jField] = decryptJson(obj[jField], `${model}:${jField}`);
      }
    }
  }

  if (rels) {
    for (const [relName, targetModel] of rels) {
      if (relName in obj && obj[relName] !== null && obj[relName] !== undefined) {
        obj[relName] = decryptResult(targetModel, obj[relName]);
      }
    }
  }

  return result;
}

const UNIQUE_WHERE_OPS = new Set(["findUnique", "findUniqueOrThrow", "update", "upsert", "delete"]);
const NON_ROW_RESULT_OPS = new Set(["count", "aggregate", "groupBy", "createMany", "updateMany", "deleteMany"]);

function findRotationFallbackUniqueWheres(model: string, origWhere: unknown): Record<string, unknown>[] {
  if (!isPlainObject(origWhere)) return [];
  const spec = ENCRYPTED_MODELS[model];
  if (!spec) return [];

  for (const [field, bi] of Object.entries(spec.blindIndexes)) {
    const val = origWhere[field];
    if (typeof val === "string") {
      const cands = blindIndexCandidates(val, bi.context);
      if (cands.length > 1) {
        return cands.slice(1).map((hash) => {
          const base = transformWhere(model, origWhere, true) as Record<string, unknown>;
          return { ...base, [bi.hashColumn]: hash };
        });
      }
    }
  }
  return [];
}

/**
 * Attach transparent AES-256-GCM field-level encryption & blind-index query rewriting
 * to a PrismaClient instance. Works across all reads, writes, nested relations, and `$transaction`.
 */
export function withFieldEncryption<T extends PrismaClient>(client: T) {
  return client.$extends({
    name: "pamarcyFieldEncryption",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const runQuery = query as unknown as (a: unknown) => Promise<unknown>;
          if (!model) return runQuery(args);

          const nextArgs: Record<string, unknown> | unknown = isPlainObject(args) ? { ...args } : args;
          const isUnique = UNIQUE_WHERE_OPS.has(operation);
          const origWhere = isPlainObject(args) ? (args as Record<string, unknown>).where : undefined;

          if (isPlainObject(nextArgs)) {
            if ("where" in nextArgs && nextArgs.where !== undefined) {
              nextArgs.where = transformWhere(model, nextArgs.where, isUnique);
            }
            if ("data" in nextArgs && nextArgs.data !== undefined) {
              nextArgs.data = transformWriteData(model, nextArgs.data);
            }
            if (operation === "upsert") {
              if ("create" in nextArgs && nextArgs.create !== undefined) {
                nextArgs.create = transformWriteData(model, nextArgs.create);
              }
              if ("update" in nextArgs && nextArgs.update !== undefined) {
                nextArgs.update = transformWriteData(model, nextArgs.update);
              }
            }
            if ("include" in nextArgs && nextArgs.include !== undefined) {
              nextArgs.include = transformIncludeOrSelect(model, nextArgs.include);
            }
            if ("select" in nextArgs && nextArgs.select !== undefined) {
              nextArgs.select = transformIncludeOrSelect(model, nextArgs.select);
            }
          }

          let result: unknown;
          if (operation === "findUnique" || operation === "findUniqueOrThrow") {
            const fallbacks = findRotationFallbackUniqueWheres(model, origWhere);
            if (fallbacks.length > 0 && isPlainObject(nextArgs)) {
              if (operation === "findUnique") {
                result = await runQuery(nextArgs);
                for (const fbWhere of fallbacks) {
                  if (result !== null) break;
                  result = await runQuery({ ...nextArgs, where: fbWhere });
                }
              } else {
                try {
                  result = await runQuery(nextArgs);
                } catch (err) {
                  let matched = false;
                  for (const fbWhere of fallbacks) {
                    try {
                      result = await runQuery({ ...nextArgs, where: fbWhere });
                      matched = true;
                      break;
                    } catch {
                      /* try next retired key candidate */
                    }
                  }
                  if (!matched) throw err;
                }
              }
            } else {
              result = await runQuery(nextArgs);
            }
          } else {
            result = await runQuery(nextArgs);
          }

          if (NON_ROW_RESULT_OPS.has(operation)) {
            return result;
          }
          return decryptResult(model, result);
        },
      },
    },
  });
}
