import { connect, JSONCodec } from "nats";
import { logger } from "./logging.js";

function env(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    if (fallback === undefined) throw new Error(`Missing env: ${name}`);
    return fallback;
  }
  return raw;
}

const jc = JSONCodec();
let nc = null;
try {
  const NATS_URL = env("NATS_URL");
  nc = await connect({ servers: NATS_URL });
} catch (err) {
  logger.warn(`Failed to connect to NATS: ${err.message}`);
}


export async function publishJson(subject, data) {
  if (!nc) {
    logger.warn("NATS connection not established, cannot publish message");
    return;
  }

  nc.publish(subject, jc.encode(data));
}
