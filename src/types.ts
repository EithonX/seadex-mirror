export interface RuntimeEnv {
  DB: D1Database;
  SOURCE_BASE_URL?: string;
  CACHE_TTL_SECONDS?: string;
}

export const DEFAULT_SOURCE_BASE_URL = "https://releases.moe";
export const DEFAULT_CACHE_TTL_SECONDS = 900;
