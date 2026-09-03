export {
  CACHE_EVENT_KIND,
  buildCacheEvent,
  type BuildCacheEventInput,
  type CacheDriver,
  type CacheEventData,
  type CacheOperationSummary,
} from "./event";
export {
  instrumentIoredisClient,
  instrumentNodeRedisClient,
  type DuckTypedCacheClient,
  type InstrumentCacheClientOptions,
} from "./instrument";
export {
  AUTO_INSTRUMENT_CACHE_DRIVERS,
  autoInstrumentCacheClients,
  autoInstrumentCachePatchedAnything,
  formatAutoInstrumentCacheReport,
  type AutoInstrumentCacheDriver,
  type AutoInstrumentCacheDriverResult,
  type AutoInstrumentCacheOptions,
  type AutoInstrumentCacheReport,
} from "./auto-instrument";
