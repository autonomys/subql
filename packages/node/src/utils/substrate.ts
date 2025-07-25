// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import { ApiPromise } from '@polkadot/api';
import '@polkadot/api-augment/substrate';
import { Bytes, Option, Vec } from '@polkadot/types';
import {
  BlockHash,
  EventRecord,
  RuntimeVersion,
  SignedBlock,
  Header as SubstrateHeader,
} from '@polkadot/types/interfaces';
import { BN, BN_THOUSAND, BN_TWO, bnMin } from '@polkadot/util';
import {
  filterBlockTimestamp,
  getLogger,
  Header,
  IBlock,
} from '@subql/node-core';
import {
  BlockHeader,
  SpecVersionRange,
  SubstrateBlock,
  SubstrateBlockFilter,
  SubstrateCallFilter,
  SubstrateEvent,
  SubstrateEventFilter,
  SubstrateExtrinsic,
} from '@subql/types';
import { merge } from 'lodash';
import { SubqlProjectBlockFilter } from '../configure/SubqueryProject';
import { ApiPromiseConnection } from '../indexer/apiPromise.connection';
import { BlockContent, LightBlockContent } from '../indexer/types';

const logger = getLogger('fetch');
const INTERVAL_THRESHOLD = BN_THOUSAND.div(BN_TWO);
const DEFAULT_TIME = new BN(6_000);
const A_DAY = new BN(24 * 60 * 60 * 1000);

type MissTsHeader = Omit<Header, 'timestamp'>;

export function substrateHeaderToHeader(header: SubstrateHeader): MissTsHeader {
  return {
    blockHeight: header.number.toNumber(),
    blockHash: header.hash.toHex(),
    parentHash: header.parentHash.toHex(),
  };
}

export function substrateBlockToHeader(block: SignedBlock): Header {
  const timestamp = getTimestamp(block);
  assert(
    timestamp,
    'Failed to retrieve a reliable timestamp. This issue is more likely to occur on networks like Shiden',
  );

  return {
    ...substrateHeaderToHeader(block.block.header),
    timestamp,
  };
}

export function wrapBlock(
  signedBlock: SignedBlock,
  events: EventRecord[],
  specVersion: number,
): SubstrateBlock {
  return merge(signedBlock, {
    timestamp: getTimestamp(signedBlock),
    specVersion: specVersion,
    events,
  });
}

export function getTimestamp({
  block: { extrinsics, header },
}: SignedBlock): Date | undefined {
  // Genesis block (block 0) typically doesn't have timestamp extrinsics
  if (header.number.toNumber() === 0) {
    return new Date(0);
  }
  // extrinsics can be undefined when fetching light blocks
  if (extrinsics) {
    for (const e of extrinsics) {
      const {
        method: { method, section },
      } = e;
      if (section === 'timestamp' && method === 'set') {
        const date = new Date(e.args[0].toJSON() as number);
        if (isNaN(date.getTime())) {
          throw new Error('timestamp args type wrong');
        }
        return date;
      }
    }
  }
  // For network that doesn't use timestamp-set, return undefined
  // See test `return undefined if no timestamp set extrinsic`
  // E.g Shiden
  return undefined;
}

export async function getHeaderForHash(
  api: ApiPromise,
  blockHash: string,
): Promise<Header> {
  const block = await api.rpc.chain.getBlock(blockHash).catch((e) => {
    logger.error(
      `failed to fetch Block hash="${blockHash}" ${getApiDecodeErrMsg(
        e.message,
      )}`,
    );
    throw ApiPromiseConnection.handleError(e);
  });

  return substrateBlockToHeader(block);
}

export function wrapExtrinsics(
  wrappedBlock: SubstrateBlock,
  allEvents: EventRecord[],
): SubstrateExtrinsic[] {
  const currentBlockNumber = wrappedBlock.block.header.number.toNumber();
  // console.log(`[DEBUG] wrapExtrinsics: Processing block: ${currentBlockNumber}`);
  // console.log(`[DEBUG] wrapExtrinsics: Received allEvents.length: ${allEvents.length}`);

  const groupedEvents = groupEventsByExtrinsic(allEvents);
  return wrappedBlock.block.extrinsics.map((extrinsic, idx) => {
    const eventsForThisExtrinsic = groupedEvents[idx] ?? [];
    return {
      idx,
      extrinsic,
      block: wrappedBlock,
      events: eventsForThisExtrinsic,
      success: getExtrinsicSuccess(eventsForThisExtrinsic),
    };
  });
}

function getExtrinsicSuccess(events: EventRecord[]): boolean {
  return (
    events.findIndex((evt) => evt.event.method === 'ExtrinsicSuccess') > -1
  );
}

function groupEventsByExtrinsic(
  events: EventRecord[],
): Record<number, EventRecord[]> {
  return events.reduce(
    (acc, event) => {
      const extrinsicIdx = event.phase.isApplyExtrinsic
        ? event.phase.asApplyExtrinsic.toNumber()
        : undefined;
      if (extrinsicIdx === undefined) {
        return acc;
      }
      acc[extrinsicIdx] ??= [];
      acc[extrinsicIdx].push(event);
      return acc;
    },
    {} as Record<number, EventRecord[]>,
  );
}

export function wrapEvents(
  extrinsics: SubstrateExtrinsic[],
  events: EventRecord[],
  block: SubstrateBlock,
): SubstrateEvent[] {
  return events.reduce((acc, event, idx) => {
    const { phase } = event;
    const wrappedEvent: SubstrateEvent = merge(event, { idx, block });
    if (phase.isApplyExtrinsic) {
      wrappedEvent.extrinsic = extrinsics[phase.asApplyExtrinsic.toNumber()];
    }
    acc.push(wrappedEvent);
    return acc;
  }, [] as SubstrateEvent[]);
}

function checkSpecRange(
  specVersionRange: SpecVersionRange,
  specVersion: number,
) {
  const [lowerBond, upperBond] = specVersionRange;
  return (
    (lowerBond === undefined ||
      lowerBond === null ||
      specVersion >= lowerBond) &&
    (upperBond === undefined || upperBond === null || specVersion <= upperBond)
  );
}

export function filterBlock(
  block: SubstrateBlock,
  filter?: SubstrateBlockFilter,
): SubstrateBlock | undefined {
  if (!filter) return block;
  if (!filterBlockModulo(block, filter)) return;
  if (
    block.timestamp &&
    !filterBlockTimestamp(
      block.timestamp.getTime(),
      filter as SubqlProjectBlockFilter,
    )
  ) {
    return;
  }
  return filter.specVersion === undefined ||
    block.specVersion === undefined ||
    checkSpecRange(filter.specVersion, block.specVersion)
    ? block
    : undefined;
}

export function filterBlockModulo(
  block: SubstrateBlock,
  filter: SubstrateBlockFilter,
): boolean {
  const { modulo } = filter;
  if (!modulo) return true;
  return block.block.header.number.toNumber() % modulo === 0;
}

export function filterExtrinsic(
  { block, extrinsic, success }: SubstrateExtrinsic,
  filter?: SubstrateCallFilter,
): boolean {
  if (!filter) return true;
  return (
    (filter.specVersion === undefined ||
      block.specVersion === undefined ||
      checkSpecRange(filter.specVersion, block.specVersion)) &&
    (filter.module === undefined ||
      extrinsic.method.section === filter.module) &&
    (filter.method === undefined ||
      extrinsic.method.method === filter.method) &&
    (filter.success === undefined || success === filter.success) &&
    (filter.isSigned === undefined || extrinsic.isSigned === filter.isSigned)
  );
}

export function filterExtrinsics(
  extrinsics: SubstrateExtrinsic[],
  filterOrFilters: SubstrateCallFilter | SubstrateCallFilter[] | undefined,
): SubstrateExtrinsic[] {
  if (
    !filterOrFilters ||
    (filterOrFilters instanceof Array && filterOrFilters.length === 0)
  ) {
    return extrinsics;
  }
  const filters =
    filterOrFilters instanceof Array ? filterOrFilters : [filterOrFilters];
  return extrinsics.filter((extrinsic) =>
    filters.find((filter) => filterExtrinsic(extrinsic, filter)),
  );
}

export function filterEvent(
  { block, event }: SubstrateEvent,
  filter?: SubstrateEventFilter,
): boolean {
  if (!filter) return true;
  return (
    (filter.specVersion === undefined ||
      block.specVersion === undefined ||
      checkSpecRange(filter.specVersion, block.specVersion)) &&
    (filter.module ? event.section === filter.module : true) &&
    (filter.method ? event.method === filter.method : true)
  );
}

export function filterEvents(
  events: SubstrateEvent[],
  filterOrFilters?: SubstrateEventFilter | SubstrateEventFilter[] | undefined,
): SubstrateEvent[] {
  if (
    !filterOrFilters ||
    (filterOrFilters instanceof Array && filterOrFilters.length === 0)
  ) {
    return events;
  }
  const filters =
    filterOrFilters instanceof Array ? filterOrFilters : [filterOrFilters];
  return events.filter((event) =>
    filters.find((filter) => filterEvent(event, filter)),
  );
}

// TODO: prefetch all known runtime upgrades at once
export async function prefetchMetadata(
  api: ApiPromise,
  hash: BlockHash,
): Promise<void> {
  await api.getBlockRegistry(hash);
}

/**
 *
 * @param api
 * @param startHeight
 * @param endHeight
 * @param overallSpecVer exists if all blocks in the range have same parant specVersion
 */

export async function getBlockByHeight(
  api: ApiPromise,
  height: number,
): Promise<SignedBlock> {
  const blockHash = await api.rpc.chain.getBlockHash(height).catch((e) => {
    logger.error(`failed to fetch BlockHash ${height}`);
    throw ApiPromiseConnection.handleError(e);
  });

  const block = await api.rpc.chain.getBlock(blockHash).catch((e) => {
    logger.error(
      `failed to fetch Block hash="${blockHash}" height="${height}"${getApiDecodeErrMsg(
        e.message,
      )}`,
    );
    throw ApiPromiseConnection.handleError(e);
  });

  // validate block is valid
  if (block.block.header.hash.toHex() !== blockHash.toHex()) {
    throw new Error(
      `fetched block header hash ${block.block.header.hash.toHex()} is not match with blockHash ${blockHash.toHex()} at block ${height}. This is likely a problem with the rpc provider.`,
    );
  }
  return block;
}

export async function getHeaderByHeight(
  api: ApiPromise,
  height: number,
): Promise<SubstrateHeader> {
  const blockHash = await api.rpc.chain.getBlockHash(height).catch((e) => {
    logger.error(`failed to fetch BlockHash ${height}`);
    throw ApiPromiseConnection.handleError(e);
  });

  const header = await api.rpc.chain.getHeader(blockHash).catch((e) => {
    logger.error(
      `failed to fetch Block Header hash="${blockHash}" height="${height}"`,
    );
    throw ApiPromiseConnection.handleError(e);
  });
  // validate block is valid
  if (header.hash.toHex() !== blockHash.toHex()) {
    throw new Error(
      `fetched block header hash ${header.hash.toHex()} is not match with blockHash ${blockHash.toHex()} at block ${height}. This is likely a problem with the rpc provider.`,
    );
  }
  return header;
}

export async function fetchBlocksArray(
  api: ApiPromise,
  blockArray: number[],
): Promise<SignedBlock[]> {
  return Promise.all(
    blockArray.map(async (height) => getBlockByHeight(api, height)),
  );
}

export async function fetchHeaderArray(
  api: ApiPromise,
  blockArray: number[],
): Promise<SubstrateHeader[]> {
  return Promise.all(
    blockArray.map(async (height) => getHeaderByHeight(api, height)),
  );
}

export async function fetchEventsRange(
  api: ApiPromise,
  hashs: BlockHash[],
): Promise<Vec<EventRecord>[]> {
  return Promise.all(
    hashs.map(async (hash) => {
      try {
        const blockNumber = (
          await api.rpc.chain.getHeader(hash)
        ).number.toNumber();

        // Try the standard events query
        try {
          const events = await api.query.system.events.at(hash);
          if (events && events.length > 0) {
            // console.log(`[DEBUG] Block ${blockNumber}: Found ${events.length} events using standard query`);
            return events;
          }
        } catch (standardErr) {
          // console.log(`[DEBUG] Block ${blockNumber}: Standard events query failed, trying segmented approach`);
        }

        // Fall back to segmented events approach
        let eventsForBlock: Vec<EventRecord> =
          api.registry.createType('Vec<EventRecord>');
        let allEvents: EventRecord[] = [];

        try {
          // Get total event count for this block
          const totalEventCount = await api.query.system.eventCount.at(hash);
          // @ts-ignore - Handle potential Codec type
          const eventCount =
            totalEventCount && totalEventCount.toNumber
              ? totalEventCount.toNumber()
              : 0;

          if (eventCount > 0) {
            // console.log(`[DEBUG] Block ${blockNumber} has ${eventCount} events (using segmented approach)`);

            // Calculate number of segments to check (EventSegmentSize = 100)
            const SEGMENT_SIZE = 100;
            const numSegments = Math.ceil(eventCount / SEGMENT_SIZE);

            // Fetch events from all segments
            for (
              let segmentIndex = 0;
              segmentIndex < numSegments;
              segmentIndex++
            ) {
              const segmentData = await api.query.system.eventSegments.at(
                hash,
                segmentIndex,
              );

              if (!segmentData) continue;

              let eventsInSegment: EventRecord[] = [];

              // Handle potential Option wrapping
              // @ts-ignore - Types are handled at runtime
              if (
                segmentData.isSome !== undefined &&
                typeof segmentData.unwrap === 'function'
              ) {
                // @ts-ignore
                if (segmentData.isNone) continue;
                // @ts-ignore
                const unwrapped = segmentData.unwrap();
                // @ts-ignore
                eventsInSegment = unwrapped.toArray ? unwrapped.toArray() : [];
              }
              // @ts-ignore
              else if (segmentData.toArray !== undefined) {
                // @ts-ignore
                eventsInSegment = segmentData.toArray();
              }

              if (eventsInSegment.length > 0) {
                // console.log(`[DEBUG] Found ${eventsInSegment.length} events in segment ${segmentIndex}`);
                allEvents = allEvents.concat(eventsInSegment);
              }
            }

            if (allEvents.length > 0) {
              // console.log(`[DEBUG] Total events collected: ${allEvents.length} (expected ${eventCount})`);
              eventsForBlock = api.registry.createType(
                'Vec<EventRecord>',
                allEvents,
              );
            }
          }
        } catch (err) {
          // Both approaches failed, log warning
          logger.warn(
            `Failed to fetch events for block ${blockNumber} using both standard and segmented approaches`,
          );
        }

        return eventsForBlock;
      } catch (e: any) {
        let blockNumForError = 'unknown';
        try {
          blockNumForError = (
            await api.rpc.chain.getHeader(hash)
          ).number.toString();
        } catch (_) {
          // Intentionally empty - we'll use 'unknown' as the block number in the error message
        }

        logger.error(
          `failed to fetch events at block ${hash} (Number: ${blockNumForError})${getApiDecodeErrMsg(
            e.message,
          )}`,
        );
        throw ApiPromiseConnection.handleError(e);
      }
    }),
  );
}

export async function fetchRuntimeVersionRange(
  api: ApiPromise,
  hashs: BlockHash[],
): Promise<RuntimeVersion[]> {
  return Promise.all(
    hashs.map((hash) =>
      api.rpc.state.getRuntimeVersion(hash).catch((e) => {
        logger.error(`failed to fetch RuntimeVersion at block ${hash}`);
        throw ApiPromiseConnection.handleError(e);
      }),
    ),
  );
}

export async function fetchBlocksBatches(
  api: ApiPromise,
  blockArray: number[],
  overallSpecVer?: number,
): Promise<IBlock<BlockContent>[]> {
  const blocks = await fetchBlocksArray(api, blockArray);
  const blockHashs = blocks.map((b) => b.block.header.hash);
  const parentBlockHashs = blocks.map((b) => b.block.header.parentHash);
  // If overallSpecVersion passed, we don't need to use api to get runtimeVersions
  // wrap block with specVersion
  // If specVersion changed, we also not guarantee in this batch contains multiple runtimes,
  // therefore we better to fetch runtime over all blocks
  const [blockEvents, runtimeVersions] = await Promise.all([
    fetchEventsRange(api, blockHashs),
    overallSpecVer !== undefined // note, we need to be careful if spec version is 0
      ? undefined
      : fetchRuntimeVersionRange(api, parentBlockHashs),
  ]);

  return blocks.map((block, idx) => {
    const events = blockEvents[idx];
    const parentSpecVersion =
      overallSpecVer ?? runtimeVersions?.[idx].specVersion.toNumber();
    assert(parentSpecVersion !== undefined, 'parentSpecVersion is undefined');

    const wrappedBlock = wrapBlock(block, events.toArray(), parentSpecVersion);
    const wrappedExtrinsics = wrapExtrinsics(wrappedBlock, events);
    const wrappedEvents = wrapEvents(wrappedExtrinsics, events, wrappedBlock);

    return {
      getHeader: () => substrateBlockToHeader(wrappedBlock),
      block: {
        block: wrappedBlock,
        extrinsics: wrappedExtrinsics,
        events: wrappedEvents,
      },
    };
  });
}

// TODO why is fetchBlocksBatches a breadth first funciton rather than depth?
export async function fetchLightBlock(
  api: ApiPromise,
  height: number,
): Promise<IBlock<LightBlockContent>> {
  const blockHash = await api.rpc.chain.getBlockHash(height).catch((e) => {
    logger.error(`failed to fetch BlockHash ${height}`);
    throw ApiPromiseConnection.handleError(e);
  });

  const [header, events, timestamp] = await Promise.all([
    api.rpc.chain.getHeader(blockHash).catch((e) => {
      logger.error(
        `failed to fetch Block Header hash="${blockHash}" height="${height}"`,
      );
      throw ApiPromiseConnection.handleError(e);
    }),
    api.query.system.events.at(blockHash).catch((e) => {
      logger.error(`failed to fetch events at block ${blockHash}`);
      throw ApiPromiseConnection.handleError(e);
    }),
    // TODO: Maybe api.query.timestamp.now.at(blockHash) is the only option. If we do use it we need sufficient tests and errors if a chain doesn't support getting the timestamp.
    (await api.at(blockHash)).query.timestamp.now(),
  ]);

  const blockHeader: BlockHeader = {
    block: { header },
    events: events.toArray(),
  };
  return {
    block: {
      block: blockHeader,
      events: events.map((evt, idx) => merge(evt, { idx, block: blockHeader })),
    },
    getHeader: () => {
      return {
        ...substrateHeaderToHeader(blockHeader.block.header),
        timestamp: new Date(timestamp.toNumber()),
      };
    },
  };
}

export async function fetchBlocksBatchesLight(
  api: ApiPromise,
  blockArray: number[],
): Promise<IBlock<LightBlockContent>[]> {
  return Promise.all(blockArray.map((height) => fetchLightBlock(api, height)));
}

export function calcInterval(api: ApiPromise): BN {
  return bnMin(
    A_DAY,
    api.consts.babe?.expectedBlockTime ||
      (api.consts.difficulty?.targetBlockTime as any) ||
      api.consts.subspace?.expectedBlockTime ||
      (api.consts.timestamp?.minimumPeriod.gte(INTERVAL_THRESHOLD)
        ? api.consts.timestamp.minimumPeriod.mul(BN_TWO)
        : api.query.parachainSystem
          ? DEFAULT_TIME.mul(BN_TWO)
          : DEFAULT_TIME),
  );
}

function getApiDecodeErrMsg(errMsg: string): string {
  const decodedErrMsgs = [
    'Unable to decode',
    'failed decoding',
    'unknown type',
  ];

  if (!decodedErrMsgs.find((decodedErrMsg) => errMsg.includes(decodedErrMsg))) {
    return '';
  }

  return (
    `\nThis is because the block cannot be decoded. To solve this you can either:` +
    '\n* Skip the block' +
    '\n* Update the chain types. You can test this by viewing the block with https://polkadot.js.org/apps/' +
    '\nFor further information please read the docs: https://academy.subquery.network/'
  );
}
