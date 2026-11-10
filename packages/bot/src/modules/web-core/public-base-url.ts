import { config } from "../../config.js";

/**
 * The bot's public base URL, no trailing slash: `WEB_BASE_URL` when set,
 * else the local web port. Login links are built on it, and service
 * tokens carry it as `iss`.
 */
export function publicBaseUrl(): string {
  if (config.web.baseUrl) return config.web.baseUrl.replace(/\/+$/, "");
  return `http://localhost:${config.web.port}`;
}
