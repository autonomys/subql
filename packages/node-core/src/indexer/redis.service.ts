// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {Injectable, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import Redis, {RedisOptions} from 'ioredis';
import {getLogger} from '../logger';
import {NodeConfig} from '../configure';

const logger = getLogger('redis-service');

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
  bgsave: () => Promise<string>;
  lastsave: () => Promise<number>;
  configGet: (parameter: string) => Promise<string[]>;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client?: Redis;
  private isConnected = false;
  private connectPromise?: Promise<void>;
  private connectionAttempted = false;

  constructor(private readonly nodeConfig: NodeConfig) {}

  async onModuleInit(): Promise<void> {
    // Initialize Redis connection during module initialization
    await this.ensureConnected();
  }

  private async ensureConnected(): Promise<boolean> {
    // If Redis is not configured, return false
    if (!process.env.REDIS_HOST && !process.env.REDIS_ENDPOINT) {
      if (!this.connectionAttempted) {
        logger.info('Redis is not configured. Set REDIS_HOST or REDIS_ENDPOINT to enable Redis support.');
        this.connectionAttempted = true;
      }
      return false;
    }

    if (this.isConnected) {
      return true;
    }

    // If already connecting, wait for that to complete
    if (this.connectPromise) {
      try {
        await this.connectPromise;
        return this.isConnected;
      } catch {
        return false;
      }
    }

    // Start new connection
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
      return this.isConnected;
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      return false;
    }
  }

  private async connect(): Promise<void> {
    try {
      const redisOptions: RedisOptions = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0'),
        retryStrategy: (times: number) => {
          if (times > 3) {
            logger.error('Redis connection failed after 3 attempts');
            return null; // Stop retrying
          }
          const delay = Math.min(times * 50, 2000);
          logger.warn(`Redis connection failed, retrying in ${delay}ms...`);
          return delay;
        },
      };

      // Support Redis connection string
      if (process.env.REDIS_ENDPOINT) {
        this.client = new Redis(process.env.REDIS_ENDPOINT);
      } else {
        this.client = new Redis(redisOptions);
      }

      await new Promise<void>((resolve, reject) => {
        this.client!.on('connect', () => {
          logger.info('Redis client connected');
          this.isConnected = true;
          resolve();
        });

        this.client!.on('error', (err) => {
          logger.error('Redis client error:', err);
          if (!this.isConnected) {
            reject(err);
          }
        });

        // Timeout after 5 seconds
        setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
      });
    } catch (error) {
      if (this.client) {
        this.client.disconnect();
        this.client = undefined;
      }
      throw error;
    }
  }

  getSafeClient(): SafeRedisClient | undefined {
    if (!this.client || !this.isConnected) {
      return undefined;
    }

    // Return a safe subset of Redis commands that won't compromise the system
    return {
      get: async (key: string) => {
        if (!(await this.ensureConnected())) return null;
        return this.client!.get(key);
      },
      set: async (key: string, value: string, expiryMode?: string, time?: number) => {
        if (!(await this.ensureConnected())) return null;
        if (expiryMode && time) {
          return this.client!.set(key, value, expiryMode as any, time);
        }
        return this.client!.set(key, value);
      },
      del: async (key: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.del(key);
      },
      exists: async (key: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.exists(key);
      },
      expire: async (key: string, seconds: number) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.expire(key, seconds);
      },
      ttl: async (key: string) => {
        if (!(await this.ensureConnected())) return -2;
        return this.client!.ttl(key);
      },
      incr: async (key: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.incr(key);
      },
      decr: async (key: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.decr(key);
      },
      incrby: async (key: string, increment: number) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.incrby(key, increment);
      },
      decrby: async (key: string, decrement: number) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.decrby(key, decrement);
      },
      hget: async (key: string, field: string) => {
        if (!(await this.ensureConnected())) return null;
        return this.client!.hget(key, field);
      },
      hset: async (key: string, field: string, value: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.hset(key, field, value);
      },
      hdel: async (key: string, field: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.hdel(key, field);
      },
      hgetall: async (key: string) => {
        if (!(await this.ensureConnected())) return {};
        return this.client!.hgetall(key);
      },
      hexists: async (key: string, field: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.hexists(key, field);
      },
      hkeys: async (key: string) => {
        if (!(await this.ensureConnected())) return [];
        return this.client!.hkeys(key);
      },
      hvals: async (key: string) => {
        if (!(await this.ensureConnected())) return [];
        return this.client!.hvals(key);
      },
      hlen: async (key: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.hlen(key);
      },
      lpush: async (key: string, ...values: string[]) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.lpush(key, ...values);
      },
      rpush: async (key: string, ...values: string[]) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.rpush(key, ...values);
      },
      lpop: async (key: string) => {
        if (!(await this.ensureConnected())) return null;
        return this.client!.lpop(key);
      },
      rpop: async (key: string) => {
        if (!(await this.ensureConnected())) return null;
        return this.client!.rpop(key);
      },
      llen: async (key: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.llen(key);
      },
      lrange: async (key: string, start: number, stop: number) => {
        if (!(await this.ensureConnected())) return [];
        return this.client!.lrange(key, start, stop);
      },
      sadd: async (key: string, ...members: string[]) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.sadd(key, ...members);
      },
      srem: async (key: string, ...members: string[]) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.srem(key, ...members);
      },
      sismember: async (key: string, member: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.sismember(key, member);
      },
      smembers: async (key: string) => {
        if (!(await this.ensureConnected())) return [];
        return this.client!.smembers(key);
      },
      scard: async (key: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.scard(key);
      },
      zadd: async (key: string, score: number, member: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.zadd(key, score, member);
      },
      zrem: async (key: string, member: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.zrem(key, member);
      },
      zscore: async (key: string, member: string) => {
        if (!(await this.ensureConnected())) return null;
        return this.client!.zscore(key, member);
      },
      zrange: async (key: string, start: number, stop: number) => {
        if (!(await this.ensureConnected())) return [];
        return this.client!.zrange(key, start, stop);
      },
      zrevrange: async (key: string, start: number, stop: number) => {
        if (!(await this.ensureConnected())) return [];
        return this.client!.zrevrange(key, start, stop);
      },
      zcard: async (key: string) => {
        if (!(await this.ensureConnected())) return 0;
        return this.client!.zcard(key);
      },
      bgsave: async () => {
        if (!(await this.ensureConnected())) throw new Error('Redis connection not established');
        return this.client!.bgsave();
      },
      lastsave: async () => {
        if (!(await this.ensureConnected())) throw new Error('Redis connection not established');
        return this.client!.lastsave();
      },
      configGet: async (parameter: string) => {
        if (!(await this.ensureConnected())) throw new Error('Redis connection not established');
        return this.client!.config('GET', parameter) as Promise<string[]>;
      },
    };
  }

  async onModuleDestroy() {
    if (this.client && this.isConnected) {
      logger.info('Closing Redis connection');
      await this.client.quit();
      this.isConnected = false;
    }
  }
} 