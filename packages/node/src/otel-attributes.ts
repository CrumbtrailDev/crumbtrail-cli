export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  bytesValue?: string;
}

export interface OtlpKeyValue {
  key?: string;
  value?: OtlpAnyValue;
}

export function otlpValueToJs(value: OtlpAnyValue | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) {
    return typeof value.intValue === "string"
      ? Number(value.intValue)
      : value.intValue;
  }
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue)
    return (value.arrayValue.values ?? []).map(otlpValueToJs);
  if (value.kvlistValue) return attributesToMap(value.kvlistValue.values);
  if (value.bytesValue !== undefined) return value.bytesValue;
  return undefined;
}

export function attributesToMap(
  attrs: OtlpKeyValue[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attr of attrs ?? []) {
    if (!attr || typeof attr.key !== "string" || attr.key.length === 0)
      continue;
    if (
      attr.key === "__proto__" ||
      attr.key === "constructor" ||
      attr.key === "prototype"
    )
      continue;
    out[attr.key] = otlpValueToJs(attr.value);
  }
  return out;
}

export function unixNanoToMillis(
  nano: string | number | undefined,
): number | undefined {
  if (nano === undefined || nano === null) return undefined;
  const asNumber = typeof nano === "string" ? Number(nano) : nano;
  if (!Number.isFinite(asNumber)) return undefined;
  return Math.round(asNumber / 1_000_000);
}
