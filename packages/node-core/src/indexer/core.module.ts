// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {Module} from '@nestjs/common';
import {EventEmitter2} from '@nestjs/event-emitter';
import {Sequelize} from '@subql/x-sequelize';
import {AdminController, AdminListener} from '../admin/admin.controller';
import {NodeConfig} from '../configure';
import {IndexingBenchmarkService, PoiBenchmarkService} from './benchmark.service';
import {ConnectionPoolService} from './connectionPool.service';
import {ConnectionPoolStateManager} from './connectionPoolState.manager';
import {InMemoryCacheService} from './inMemoryCache.service';
import {MonitorService} from './monitor.service';
import {PoiService, PoiSyncService} from './poi';
import {SandboxService} from './sandbox.service';
import {StoreService} from './store.service';
import {storeModelFactory} from './storeModelProvider';
import {RedisService} from './redis.service';

@Module({
  providers: [
    InMemoryCacheService,
    SandboxService,
    ConnectionPoolStateManager,
    ConnectionPoolService,
    IndexingBenchmarkService,
    PoiBenchmarkService,
    MonitorService,
    PoiService,
    PoiSyncService,
    StoreService,
    RedisService,
    {
      provide: 'IStoreModelProvider',
      useFactory: storeModelFactory,
      inject: [NodeConfig, EventEmitter2, Sequelize],
    },
    AdminListener,
  ],
  controllers: [AdminController],
  exports: [
    ConnectionPoolService,
    ConnectionPoolStateManager,
    SandboxService,
    MonitorService,
    PoiService,
    PoiSyncService,
    StoreService,
    'IStoreModelProvider',
    InMemoryCacheService,
    RedisService,
  ],
})
export class CoreModule {}
