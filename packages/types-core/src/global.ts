// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import Pino from 'pino';
import {Cache, DynamicDatasourceCreator} from './interfaces';
import {Store} from './store';

// Safe Redis client interface for sandbox usage
export interface SafeRedisClient {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, expiryMode?: string, time?: number) => Promise<string | null>;
  del: (key: string) => Promise<number>;
  exists: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
  ttl: (key: string) => Promise<number>;
  incr: (key: string) => Promise<number>;
  decr: (key: string) => Promise<number>;
  incrby: (key: string, increment: number) => Promise<number>;
  decrby: (key: string, decrement: number) => Promise<number>;
  hget: (key: string, field: string) => Promise<string | null>;
  hset: (key: string, field: string, value: string) => Promise<number>;
  hdel: (key: string, field: string) => Promise<number>;
  hgetall: (key: string) => Promise<Record<string, string>>;
  hexists: (key: string, field: string) => Promise<number>;
  hkeys: (key: string) => Promise<string[]>;
  hvals: (key: string) => Promise<string[]>;
  hlen: (key: string) => Promise<number>;
  lpush: (key: string, ...values: string[]) => Promise<number>;
  rpush: (key: string, ...values: string[]) => Promise<number>;
  lpop: (key: string) => Promise<string | null>;
  rpop: (key: string) => Promise<string | null>;
  llen: (key: string) => Promise<number>;
  lrange: (key: string, start: number, stop: number) => Promise<string[]>;
  sadd: (key: string, ...members: string[]) => Promise<number>;
  srem: (key: string, ...members: string[]) => Promise<number>;
  sismember: (key: string, member: string) => Promise<number>;
  smembers: (key: string) => Promise<string[]>;
  scard: (key: string) => Promise<number>;
  zadd: (key: string, score: number, member: string) => Promise<number>;
  zrem: (key: string, member: string) => Promise<number>;
  zscore: (key: string, member: string) => Promise<string | null>;
  zrange: (key: string, start: number, stop: number) => Promise<string[]>;
  zrevrange: (key: string, start: number, stop: number) => Promise<string[]>;
  zcard: (key: string) => Promise<number>;
  // Persistence methods
  bgsave: () => Promise<string>;
  lastsave: () => Promise<number>;
  configGet: (parameter: string) => Promise<string[]>;
}

// base global
declare global {
  const logger: Pino.Logger;
  const store: Store;
  const cache: Cache;
  const redis: SafeRedisClient | undefined;
  const chainId: string;
  const createDynamicDatasource: DynamicDatasourceCreator;
}
