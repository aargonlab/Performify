import IORedis from "ioredis";
import { env } from "../lib/env.server";

// BullMQ requires maxRetriesPerRequest: null on blocking connections.
// A single shared connection is fine for queue producers; workers create
// their own (see worker/index.ts).
let connection: IORedis | undefined;

export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(env.redisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return connection;
}

export function createWorkerConnection(): IORedis {
  return new IORedis(env.redisUrl(), { maxRetriesPerRequest: null });
}
