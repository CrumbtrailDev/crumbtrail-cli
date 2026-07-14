import protobuf from 'protobufjs';
import type {
  OtlpLogsRequest,
  OtlpLogRecord,
  OtlpResourceLogs,
  OtlpResourceSpans,
  OtlpScopeLogs,
  OtlpScopeSpans,
  OtlpSpan,
  OtlpTraceRequest,
} from './otel-adapter';
import type { OtlpAnyValue, OtlpKeyValue } from './otel-attributes';

const root = protobuf.Root.fromJSON({
  nested: {
    opentelemetry: {
      nested: {
        proto: {
          nested: {
            common: {
              nested: {
                v1: {
                  nested: {
                    AnyValue: {
                      oneofs: {
                        value: {
                          oneof: [
                            'stringValue',
                            'boolValue',
                            'intValue',
                            'doubleValue',
                            'arrayValue',
                            'kvlistValue',
                            'bytesValue',
                          ],
                        },
                      },
                      fields: {
                        stringValue: { type: 'string', id: 1 },
                        boolValue: { type: 'bool', id: 2 },
                        intValue: { type: 'int64', id: 3 },
                        doubleValue: { type: 'double', id: 4 },
                        arrayValue: { type: 'ArrayValue', id: 5 },
                        kvlistValue: { type: 'KeyValueList', id: 6 },
                        bytesValue: { type: 'bytes', id: 7 },
                      },
                    },
                    ArrayValue: {
                      fields: {
                        values: { rule: 'repeated', type: 'AnyValue', id: 1 },
                      },
                    },
                    KeyValueList: {
                      fields: {
                        values: { rule: 'repeated', type: 'KeyValue', id: 1 },
                      },
                    },
                    KeyValue: {
                      fields: {
                        key: { type: 'string', id: 1 },
                        value: { type: 'AnyValue', id: 2 },
                      },
                    },
                    InstrumentationScope: {
                      fields: {
                        name: { type: 'string', id: 1 },
                        version: { type: 'string', id: 2 },
                        attributes: { rule: 'repeated', type: 'KeyValue', id: 3 },
                        droppedAttributesCount: { type: 'uint32', id: 4 },
                      },
                    },
                  },
                },
              },
            },
            resource: {
              nested: {
                v1: {
                  nested: {
                    Resource: {
                      fields: {
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 1,
                        },
                        droppedAttributesCount: { type: 'uint32', id: 2 },
                      },
                    },
                  },
                },
              },
            },
            trace: {
              nested: {
                v1: {
                  nested: {
                    ResourceSpans: {
                      fields: {
                        resource: { type: 'opentelemetry.proto.resource.v1.Resource', id: 1 },
                        scopeSpans: { rule: 'repeated', type: 'ScopeSpans', id: 2 },
                        schemaUrl: { type: 'string', id: 3 },
                      },
                    },
                    ScopeSpans: {
                      fields: {
                        scope: { type: 'opentelemetry.proto.common.v1.InstrumentationScope', id: 1 },
                        spans: { rule: 'repeated', type: 'Span', id: 2 },
                        schemaUrl: { type: 'string', id: 3 },
                      },
                    },
                    Span: {
                      fields: {
                        traceId: { type: 'bytes', id: 1 },
                        spanId: { type: 'bytes', id: 2 },
                        traceState: { type: 'string', id: 3 },
                        parentSpanId: { type: 'bytes', id: 4 },
                        name: { type: 'string', id: 5 },
                        kind: { type: 'int32', id: 6 },
                        startTimeUnixNano: { type: 'fixed64', id: 7 },
                        endTimeUnixNano: { type: 'fixed64', id: 8 },
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 9,
                        },
                        droppedAttributesCount: { type: 'uint32', id: 10 },
                        events: { rule: 'repeated', type: 'SpanEvent', id: 11 },
                        droppedEventsCount: { type: 'uint32', id: 12 },
                        links: { rule: 'repeated', type: 'SpanLink', id: 13 },
                        droppedLinksCount: { type: 'uint32', id: 14 },
                        status: { type: 'Status', id: 15 },
                      },
                    },
                    SpanEvent: {
                      fields: {
                        timeUnixNano: { type: 'fixed64', id: 1 },
                        name: { type: 'string', id: 2 },
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 3,
                        },
                        droppedAttributesCount: { type: 'uint32', id: 4 },
                      },
                    },
                    SpanLink: {
                      fields: {
                        traceId: { type: 'bytes', id: 1 },
                        spanId: { type: 'bytes', id: 2 },
                        traceState: { type: 'string', id: 3 },
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 4,
                        },
                        droppedAttributesCount: { type: 'uint32', id: 5 },
                        flags: { type: 'fixed32', id: 6 },
                      },
                    },
                    Status: {
                      fields: {
                        message: { type: 'string', id: 2 },
                        code: { type: 'int32', id: 3 },
                      },
                    },
                  },
                },
              },
            },
            logs: {
              nested: {
                v1: {
                  nested: {
                    ResourceLogs: {
                      fields: {
                        resource: { type: 'opentelemetry.proto.resource.v1.Resource', id: 1 },
                        scopeLogs: { rule: 'repeated', type: 'ScopeLogs', id: 2 },
                        schemaUrl: { type: 'string', id: 3 },
                      },
                    },
                    ScopeLogs: {
                      fields: {
                        scope: { type: 'opentelemetry.proto.common.v1.InstrumentationScope', id: 1 },
                        logRecords: { rule: 'repeated', type: 'LogRecord', id: 2 },
                        schemaUrl: { type: 'string', id: 3 },
                      },
                    },
                    LogRecord: {
                      fields: {
                        timeUnixNano: { type: 'fixed64', id: 1 },
                        severityNumber: { type: 'int32', id: 2 },
                        severityText: { type: 'string', id: 3 },
                        body: { type: 'opentelemetry.proto.common.v1.AnyValue', id: 5 },
                        attributes: {
                          rule: 'repeated',
                          type: 'opentelemetry.proto.common.v1.KeyValue',
                          id: 6,
                        },
                        droppedAttributesCount: { type: 'uint32', id: 7 },
                        flags: { type: 'fixed32', id: 8 },
                        traceId: { type: 'bytes', id: 9 },
                        spanId: { type: 'bytes', id: 10 },
                        observedTimeUnixNano: { type: 'fixed64', id: 11 },
                      },
                    },
                  },
                },
              },
            },
            collector: {
              nested: {
                trace: {
                  nested: {
                    v1: {
                      nested: {
                        ExportTraceServiceRequest: {
                          fields: {
                            resourceSpans: {
                              rule: 'repeated',
                              type: 'opentelemetry.proto.trace.v1.ResourceSpans',
                              id: 1,
                            },
                          },
                        },
                      },
                    },
                  },
                },
                logs: {
                  nested: {
                    v1: {
                      nested: {
                        ExportLogsServiceRequest: {
                          fields: {
                            resourceLogs: {
                              rule: 'repeated',
                              type: 'opentelemetry.proto.logs.v1.ResourceLogs',
                              id: 1,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

const traceRequestType = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
const logsRequestType = root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest');

function bytesToHex(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  return undefined;
}

function longToString(value: unknown): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    return (value as { toString(): string }).toString();
  }
  return undefined;
}

function normalizeAnyValue(value: unknown): OtlpAnyValue | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const out: OtlpAnyValue = {};
  if (raw.stringValue !== undefined) out.stringValue = String(raw.stringValue);
  if (typeof raw.boolValue === 'boolean') out.boolValue = raw.boolValue;
  const intValue = longToString(raw.intValue);
  if (intValue !== undefined) out.intValue = intValue;
  if (typeof raw.doubleValue === 'number') out.doubleValue = raw.doubleValue;
  const arrayValue = raw.arrayValue as { values?: unknown[] } | undefined;
  if (arrayValue?.values) out.arrayValue = { values: arrayValue.values.map(normalizeAnyValue).filter(Boolean) as OtlpAnyValue[] };
  const kvlistValue = raw.kvlistValue as { values?: unknown[] } | undefined;
  if (kvlistValue?.values) out.kvlistValue = { values: normalizeAttributes(kvlistValue.values) };
  const bytesValue = bytesToHex(raw.bytesValue);
  if (bytesValue !== undefined) out.bytesValue = bytesValue;
  return out;
}

function normalizeAttributes(attrs: unknown): OtlpKeyValue[] {
  if (!Array.isArray(attrs)) return [];
  return attrs
    .map((attr) => {
      if (!attr || typeof attr !== 'object') return undefined;
      const raw = attr as Record<string, unknown>;
      return {
        key: typeof raw.key === 'string' ? raw.key : undefined,
        value: normalizeAnyValue(raw.value),
      };
    })
    .filter(Boolean) as OtlpKeyValue[];
}

function normalizeSpan(span: unknown): OtlpSpan | undefined {
  if (!span || typeof span !== 'object') return undefined;
  const raw = span as Record<string, unknown>;
  const status = raw.status && typeof raw.status === 'object' ? raw.status as Record<string, unknown> : undefined;
  return {
    traceId: bytesToHex(raw.traceId),
    spanId: bytesToHex(raw.spanId),
    parentSpanId: bytesToHex(raw.parentSpanId),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    kind: typeof raw.kind === 'number' ? raw.kind : undefined,
    startTimeUnixNano: longToString(raw.startTimeUnixNano),
    endTimeUnixNano: longToString(raw.endTimeUnixNano),
    attributes: normalizeAttributes(raw.attributes),
    status: status
      ? {
          code: typeof status.code === 'number' ? status.code : undefined,
          message: typeof status.message === 'string' ? status.message : undefined,
        }
      : undefined,
  };
}

function normalizeResourceSpans(resourceSpans: unknown): OtlpResourceSpans[] {
  if (!Array.isArray(resourceSpans)) return [];
  return resourceSpans.map((rs) => {
    const raw = rs && typeof rs === 'object' ? rs as Record<string, unknown> : {};
    const resource = raw.resource && typeof raw.resource === 'object' ? raw.resource as Record<string, unknown> : undefined;
    const scopeSpans = Array.isArray(raw.scopeSpans) ? raw.scopeSpans : [];
    return {
      resource: { attributes: normalizeAttributes(resource?.attributes) },
      scopeSpans: scopeSpans.map((ss) => {
        const scopeRaw = ss && typeof ss === 'object' ? ss as Record<string, unknown> : {};
        const scope = scopeRaw.scope && typeof scopeRaw.scope === 'object' ? scopeRaw.scope as Record<string, unknown> : undefined;
        return {
          scope: {
            name: typeof scope?.name === 'string' ? scope.name : undefined,
            version: typeof scope?.version === 'string' ? scope.version : undefined,
          },
          spans: Array.isArray(scopeRaw.spans)
            ? scopeRaw.spans.map(normalizeSpan).filter(Boolean) as OtlpScopeSpans['spans']
            : [],
        };
      }),
    };
  });
}

function normalizeLogRecord(log: unknown): OtlpLogRecord | undefined {
  if (!log || typeof log !== 'object') return undefined;
  const raw = log as Record<string, unknown>;
  return {
    timeUnixNano: longToString(raw.timeUnixNano),
    observedTimeUnixNano: longToString(raw.observedTimeUnixNano),
    severityText: typeof raw.severityText === 'string' ? raw.severityText : undefined,
    severityNumber: typeof raw.severityNumber === 'number' ? raw.severityNumber : undefined,
    body: normalizeAnyValue(raw.body) as OtlpLogRecord['body'],
    traceId: bytesToHex(raw.traceId),
    spanId: bytesToHex(raw.spanId),
    attributes: normalizeAttributes(raw.attributes),
  };
}

function normalizeResourceLogs(resourceLogs: unknown): OtlpResourceLogs[] {
  if (!Array.isArray(resourceLogs)) return [];
  return resourceLogs.map((rl) => {
    const raw = rl && typeof rl === 'object' ? rl as Record<string, unknown> : {};
    const resource = raw.resource && typeof raw.resource === 'object' ? raw.resource as Record<string, unknown> : undefined;
    const scopeLogs = Array.isArray(raw.scopeLogs) ? raw.scopeLogs : [];
    return {
      resource: { attributes: normalizeAttributes(resource?.attributes) },
      scopeLogs: scopeLogs.map((sl) => {
        const scopeRaw = sl && typeof sl === 'object' ? sl as Record<string, unknown> : {};
        const scope = scopeRaw.scope && typeof scopeRaw.scope === 'object' ? scopeRaw.scope as Record<string, unknown> : undefined;
        return {
          scope: {
            name: typeof scope?.name === 'string' ? scope.name : undefined,
          },
          logRecords: Array.isArray(scopeRaw.logRecords)
            ? scopeRaw.logRecords.map(normalizeLogRecord).filter(Boolean) as OtlpScopeLogs['logRecords']
            : [],
        };
      }),
    };
  });
}

export function decodeOtlpTraceProtobuf(buffer: Uint8Array): OtlpTraceRequest {
  const decoded = traceRequestType.decode(buffer) as unknown as Record<string, unknown>;
  return { resourceSpans: normalizeResourceSpans(decoded.resourceSpans) };
}

export function decodeOtlpLogsProtobuf(buffer: Uint8Array): OtlpLogsRequest {
  const decoded = logsRequestType.decode(buffer) as unknown as Record<string, unknown>;
  return { resourceLogs: normalizeResourceLogs(decoded.resourceLogs) };
}
