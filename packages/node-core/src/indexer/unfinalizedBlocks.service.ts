// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import {Inject, Injectable} from '@nestjs/common';
import {Transaction} from '@subql/x-sequelize';
import {isEqual, last} from 'lodash';
import {IBlockchainService} from '../blockchain.service';
import {NodeConfig} from '../configure';
import {Header, IBlock} from '../indexer/types';
import {getLogger} from '../logger';
import {exitWithError} from '../process';
import {mainThreadOnly} from '../utils';
import {ProofOfIndex} from './entities';
import {PoiBlock} from './poi';
import {IStoreModelProvider} from './storeModelProvider';

const logger = getLogger('UnfinalizedBlocks');

export const METADATA_UNFINALIZED_BLOCKS_KEY = 'unfinalizedBlocks';
export const METADATA_LAST_FINALIZED_PROCESSED_KEY = 'lastFinalizedVerifiedHeight';

export const POI_NOT_ENABLED_ERROR_MESSAGE = 'Poi is not enabled, unable to check for last finalized block';

const UNFINALIZED_THRESHOLD = 200;

type UnfinalizedBlocks = Header[];

export interface IUnfinalizedBlocksService<B> extends IUnfinalizedBlocksServiceUtil {
  init(reindex: (targetHeader: Header) => Promise<void>): Promise<Header | undefined>;
  processUnfinalizedBlocks(block: IBlock<B> | undefined): Promise<Header | undefined>;
  processUnfinalizedBlockHeader(header: Header | undefined): Promise<Header | undefined>;
  resetUnfinalizedBlocks(tx?: Transaction): void;
  resetLastFinalizedVerifiedHeight(tx?: Transaction): void;
  getMetadataUnfinalizedBlocks(): Promise<UnfinalizedBlocks>;
}

export interface IUnfinalizedBlocksServiceUtil {
  registerFinalizedBlock(header: Header): void;
}

@Injectable()
export class UnfinalizedBlocksService<B = any> implements IUnfinalizedBlocksService<B> {
  private _unfinalizedBlocks?: UnfinalizedBlocks;
  private _knownChainFinalizedHeader?: Header; // Stores the latest *actual* chain-reported finalized header
  private _effectiveFinalizedHeader?: Header; // The header this service uses based on config
  protected lastCheckedBlockHeight?: number;

  @mainThreadOnly()
  private blockToHeader(block: IBlock<B>): Header {
    return block.getHeader();
  }

  protected get unfinalizedBlocks(): UnfinalizedBlocks {
    assert(this._unfinalizedBlocks !== undefined, new Error('Unfinalized blocks service has not been initialized'));
    return this._unfinalizedBlocks;
  }

  protected get effectiveFinalizedHeader(): Header {
    assert(this._effectiveFinalizedHeader !== undefined, 'Effective finalized header has not been initialized. Ensure updateEffectiveFinalizedHeader is called.');
    return this._effectiveFinalizedHeader;
  }

  constructor(
    protected readonly nodeConfig: NodeConfig,
    @Inject('IStoreModelProvider') protected readonly storeModelProvider: IStoreModelProvider,
    @Inject('IBlockchainService') protected blockchainService: IBlockchainService
  ) {}

  async init(reindex: (tagetHeader: Header) => Promise<void>): Promise<Header | undefined> {
    logger.info(`Unfinalized blocks feature is ${this.nodeConfig.unfinalizedBlocks ? 'enabled' : 'disabled'}.`);
    if (this.nodeConfig.finalizedDepth !== undefined && this.nodeConfig.finalizedDepth > 0) {
      logger.info(`Using custom finalized depth: ${this.nodeConfig.finalizedDepth} blocks.`);
    } else {
      logger.info('Using chain-reported finality.');
    }

    this._unfinalizedBlocks = await this.getMetadataUnfinalizedBlocks();
    this.lastCheckedBlockHeight = await this.getLastFinalizedVerifiedHeight();
    
    // Fetch initial known chain finality
    try {
      this._knownChainFinalizedHeader = await this.blockchainService.getFinalizedHeader();
    } catch (e) {
      logger.warn({err: e}, 'Failed to fetch initial chain finalized header during init.');
      // _knownChainFinalizedHeader remains undefined, updateEffectiveFinalizedHeader will handle it
    }
    
    await this.updateEffectiveFinalizedHeader(); // Set initial effective finality

    if (!this._effectiveFinalizedHeader) {
      // This might happen if the chain has no finalized blocks yet and depth calculation also fails or isn't applicable.
      // It indicates an issue or a very early chain state. The service might not function correctly without a baseline.
      logger.warn('Could not determine an initial effective finalized header. Service may be impaired until finality is established.');
      // Depending on requirements, could throw, or allow to proceed and hope it resolves.
    }

    if (this.unfinalizedBlocks.length && this._effectiveFinalizedHeader) { // Check _effectiveFinalizedHeader exists
      logger.info('Processing unfinalized blocks');
      // Validate any previously unfinalized blocks

      const rewindHeight = await this.processUnfinalizedBlocks();
      if (rewindHeight !== undefined) {
        logger.info(
          `Found un-finalized blocks from previous indexing but unverified, rolling back to last finalized block ${rewindHeight}`
        );
        await reindex(rewindHeight);
        logger.info(`Successful rewind to block ${rewindHeight.blockHeight}!`);
        return rewindHeight;
      } else {
        await this.resetUnfinalizedBlocks();
        await this.resetLastFinalizedVerifiedHeight();
      }
    }
  }

  private get finalizedBlockNumber(): number {
    // If _effectiveFinalizedHeader is not set (e.g. chain has no finality yet), 
    // this could throw due to the assert in the getter, or we might return a sensible default like 0 or -1.
    // For now, relying on the assert to catch uninitialized state.
    return this.effectiveFinalizedHeader.blockHeight;
  }

  private async updateEffectiveFinalizedHeader(): Promise<void> {
    let newCandidateHeader: Header | undefined;
    const useCustomDepth = this.nodeConfig.finalizedDepth !== undefined && this.nodeConfig.finalizedDepth > 0;

    if (useCustomDepth) {
      try {
        const bestHeight = await this.blockchainService.getBestHeight();
        const targetHeight = Math.max(0, bestHeight - (this.nodeConfig.finalizedDepth as number)); // Cast as it's checked
        newCandidateHeader = await this.blockchainService.getHeaderForHeight(targetHeight);
        logger.debug(`Depth rule: Effective finality candidate ${newCandidateHeader.blockHeight} (Tip: ${bestHeight})`);
      } catch (e) {
        logger.warn({err: e}, `Failed to calculate effective finality using depth. Will use chain finality if available.`);
        // Fallback to known chain finality if depth calculation fails
        if (this._knownChainFinalizedHeader) {
          newCandidateHeader = this._knownChainFinalizedHeader;
          logger.debug('Depth rule failed, falling back to known chain finality for effective: ' + newCandidateHeader.blockHeight);
        } else {
            logger.warn('Depth rule failed, and no known chain finality to fall back to.');
        }
      }
    } else {
      // Not using custom depth, so effective finality is chain finality
      if (this._knownChainFinalizedHeader) {
        newCandidateHeader = this._knownChainFinalizedHeader;
        logger.debug('Chain rule: Effective finality is known chain finality: ' + newCandidateHeader.blockHeight);
      }
      // If _knownChainFinalizedHeader is also undefined (e.g. very first call in init before it's fetched),
      // newCandidateHeader remains undefined. The next block handles this.
    }

    // If no candidate yet (e.g. not using depth and _knownChainFinalizedHeader was not set), try to fetch current chain finality.
    if (!newCandidateHeader) {
        try {
            const currentChainFinalized = await this.blockchainService.getFinalizedHeader();
            if (currentChainFinalized) {
                newCandidateHeader = currentChainFinalized;
                this._knownChainFinalizedHeader = currentChainFinalized; // Update our known copy
                logger.debug('Fetched current chain finality for effective: ' + newCandidateHeader.blockHeight);
            }
        } catch (e) {
            logger.warn({err: e}, 'Failed to fetch current chain finalized header during effective update.');
        }
    }

    if (newCandidateHeader) {
      if (!this._effectiveFinalizedHeader || 
          newCandidateHeader.blockHeight > this._effectiveFinalizedHeader.blockHeight || 
          (newCandidateHeader.blockHeight === this._effectiveFinalizedHeader.blockHeight && newCandidateHeader.blockHash !== this._effectiveFinalizedHeader.blockHash)) {
        this._effectiveFinalizedHeader = newCandidateHeader;
        logger.info(`Effective finalized header updated to: ${this._effectiveFinalizedHeader.blockHeight} (Hash: ${this._effectiveFinalizedHeader.blockHash})`);
      }
    } else {
      // Only log if it was previously set, to avoid spamming if chain truly has no finality yet.
      if (this._effectiveFinalizedHeader) {
        logger.warn('Could not determine a new effective finalized header. Previous value retained if any.');
      }
    }
  }

  async processUnfinalizedBlockHeader(header?: Header): Promise<Header | undefined> {
    if (header) {
      await this.registerUnfinalizedBlock(header); // Add to our list if newer than current effectiveFinalizedNumber
    }

    await this.updateEffectiveFinalizedHeader(); // Recalculate effective finality based on new tip or chain state

    if (!this._effectiveFinalizedHeader) {
      logger.warn('No effective finalized header set; cannot process forks or delete finalized blocks.');
      return undefined; // Cannot proceed without a notion of finality
    }

    const forkedHeader = await this.hasForked();

    if (!forkedHeader) {
      // Remove blocks that are now confirmed finalized
      await this.deleteFinalizedBlock();
    } else {
      // Get the last unfinalized block that is now finalized
      return this.getLastCorrectFinalizedBlock(forkedHeader);
    }
    return undefined;
  }

  async processUnfinalizedBlocks(block?: IBlock<B>): Promise<Header | undefined> {
    return this.processUnfinalizedBlockHeader(block ? this.blockToHeader(block) : undefined);
  }

  // This method is called by FetchService when a new block is *actually* finalized on chain
  async registerFinalizedBlock(chainReportedFinalizedHeader: Header): Promise<void> {
    let chainFinalityUpdated = false;
    if (!this._knownChainFinalizedHeader || chainReportedFinalizedHeader.blockHeight > this._knownChainFinalizedHeader.blockHeight) {
      this._knownChainFinalizedHeader = chainReportedFinalizedHeader;
      chainFinalityUpdated = true;
      logger.debug(`Known chain-reported finalized header updated to: ${this._knownChainFinalizedHeader.blockHeight}`);
    }

    // Re-evaluate effective finality. This is important if not using depth, or as a fallback for depth.
    // If using depth, it will recalculate based on tip. If not, it will use the new _knownChainFinalizedHeader.
    await this.updateEffectiveFinalizedHeader();
    
    // If effective finality changed, it might be possible to prune unfinalized blocks
    // The call in processUnfinalizedBlockHeader might be sufficient, but an explicit call here can be considered
    // if registerFinalizedBlock can be called independently of processUnfinalizedBlockHeader in some paths.
    // For now, relying on processUnfinalizedBlockHeader to handle pruning after its own updateEffectiveFinalizedHeader call.
    if (chainFinalityUpdated && this._effectiveFinalizedHeader) {
        // Potentially trigger pruning if chain finality directly led to effective finality changing and we are not using depth primarily.
        // This is implicitly handled as updateEffectiveFinalizedHeader -> processUnfinalizedBlockHeader -> deleteFinalizedBlock.
    }
  }

  private async registerUnfinalizedBlock(header: Header): Promise<void> {
    // Ensure _effectiveFinalizedHeader is available before checking finalizedBlockNumber
    if (!this._effectiveFinalizedHeader) {
        logger.warn(`Cannot register unfinalized block ${header.blockHeight}; effective finality not yet determined.`);
        // Decide: throw, or queue, or drop? For now, let it pass and fail at the next check if still undefined.
        // Or, better, ensure init sequence always establishes some _effectiveFinalizedHeader if possible.
    }
    // finalizedBlockNumber getter will assert if _effectiveFinalizedHeader is undefined.
    if (this._effectiveFinalizedHeader && header.blockHeight <= this.finalizedBlockNumber) return;

    // Ensure order
    const lastUnfinalizedHeight = last(this.unfinalizedBlocks)?.blockHeight;
    if (lastUnfinalizedHeight !== undefined && lastUnfinalizedHeight + 1 !== header.blockHeight) {
      exitWithError(
        `Unfinalized block is not sequential, lastUnfinalizedBlock='${lastUnfinalizedHeight}', newUnfinalizedBlock='${header.blockHeight}'`,
        logger
      );
    }

    this.unfinalizedBlocks.push(header);
    await this.saveUnfinalizedBlocks(this.unfinalizedBlocks);
  }

  private async deleteFinalizedBlock(): Promise<void> {
    if (this.lastCheckedBlockHeight !== undefined && this.lastCheckedBlockHeight < this.finalizedBlockNumber) {
      this.removeFinalized(this.finalizedBlockNumber);
      await this.saveLastFinalizedVerifiedHeight(this.finalizedBlockNumber);
      await this.saveUnfinalizedBlocks(this.unfinalizedBlocks);
    }
    this.lastCheckedBlockHeight = this.finalizedBlockNumber;
  }

  // remove any records less and equal than input finalized blockHeight
  private removeFinalized(blockHeight: number): void {
    this._unfinalizedBlocks = this.unfinalizedBlocks.filter(({blockHeight: height}) => height > blockHeight);
  }

  // find closest record from block heights
  private getClosestRecord(blockHeight: number): Header | undefined {
    // Have the block in the best block, can be verified
    return [...this.unfinalizedBlocks] // Copy so we can reverse
      .reverse() // Reverse the list to find the largest block
      .find(({blockHeight: height}) => height <= blockHeight);
  }

  // check unfinalized blocks for a fork, returns the header where a fork happened
  protected async hasForked(): Promise<Header | undefined> {
    // Ensure _effectiveFinalizedHeader is available before proceeding
    if (!this._effectiveFinalizedHeader) {
        logger.warn('Cannot check for forks; effective finality not yet determined.');
        return undefined;
    }
    
    // Check if comprehensive fork detection is enabled (could be a config option)
    const comprehensiveCheck = this.nodeConfig.comprehensiveForkDetection ?? false;
    
    if (comprehensiveCheck) {
      // NEW: Check ALL blocks that are about to be pruned
      const blocksToPrune = this.unfinalizedBlocks.filter(
        ({blockHeight}) => blockHeight <= this.finalizedBlockNumber
      );
      
      if (blocksToPrune.length === 0) {
        return undefined;
      }
      
      logger.debug(`Comprehensive fork check: verifying ${blocksToPrune.length} blocks before pruning`);
      
      let deepestFork: Header | undefined;
      let deepestForkHeight = Number.MAX_SAFE_INTEGER;
      let totalForksFound = 0;
      
      // Check each block against the chain's view
      for (const storedBlock of blocksToPrune) {
        try {
          const chainHeader = await this.blockchainService.getHeaderForHeight(storedBlock.blockHeight);
          
          if (chainHeader.blockHash !== storedBlock.blockHash) {
            logger.warn(
              `Orphan block detected at height ${storedBlock.blockHeight}: ` +
              `stored=${storedBlock.blockHash}, chain=${chainHeader.blockHash}`
            );
            
            totalForksFound++;
            
            // Track the deepest (earliest) fork
            if (storedBlock.blockHeight < deepestForkHeight) {
              deepestFork = chainHeader;
              deepestForkHeight = storedBlock.blockHeight;
            }
          }
        } catch (error) {
          logger.error(`Failed to verify block ${storedBlock.blockHeight}: ${error}`);
          // Continue checking other blocks
        }
      }
      
      if (deepestFork) {
        logger.warn(`Found ${totalForksFound} total fork(s), deepest at height ${deepestForkHeight}. Will rewind to this point.`);
      }
      
      return deepestFork; // Return the deepest fork found
    }
    
    // ORIGINAL LOGIC: Only check the last verifiable block
    const lastVerifiableBlock = this.getClosestRecord(this.finalizedBlockNumber);

    // No unfinalized blocks
    if (!lastVerifiableBlock) {
      return;
    }

    // Unfinalized blocks beyond finalized block
    if (lastVerifiableBlock.blockHeight === this.finalizedBlockNumber) {
      if (lastVerifiableBlock.blockHash !== this._effectiveFinalizedHeader.blockHash) {
        logger.warn(
          `Block fork found, enqueued un-finalized block at ${lastVerifiableBlock.blockHeight} with hash ${lastVerifiableBlock.blockHash}, actual hash is ${this._effectiveFinalizedHeader.blockHash}.`
        );
        return this._effectiveFinalizedHeader;
      }
    } else {
      // Unfinalized blocks below finalized block
      let header = this._effectiveFinalizedHeader;
      /*
       * Iterate back through parent hashes until we get the header with the matching height
       * We use headers here rather than getBlockHash because of potential caching issues on the rpc
       * If we're off by a large number of blocks we can optimise by getting the block hash directly
       */
      if (header.blockHeight - lastVerifiableBlock.blockHeight > UNFINALIZED_THRESHOLD) {
        header = await this.blockchainService.getHeaderForHeight(lastVerifiableBlock.blockHeight);
      } else {
        while (lastVerifiableBlock.blockHeight !== header.blockHeight) {
          assert(
            header.parentHash,
            'When iterate back parent hashes to find matching height, we expect parentHash to be exist'
          );
          header = await this.blockchainService.getHeaderForHash(header.parentHash);
        }
      }

      if (header.blockHash !== lastVerifiableBlock.blockHash) {
        logger.warn(
          `Block fork found, enqueued un-finalized block at ${lastVerifiableBlock.blockHeight} with hash ${lastVerifiableBlock.blockHash}, actual hash is ${header.blockHash}`
        );
        return header;
      }
    }

    return;
  }

  protected async getLastCorrectFinalizedBlock(forkedHeader: Header): Promise<Header | undefined> {
    const bestVerifiableBlocks = this.unfinalizedBlocks.filter(
      ({blockHeight}) => blockHeight <= this.finalizedBlockNumber
    );

    let checkingHeader = forkedHeader;

    // Work backwards through the blocks until we find a matching hash
    for (const bestHeader of bestVerifiableBlocks.reverse()) {
      if (bestHeader.blockHash === checkingHeader.blockHash || bestHeader.blockHash === checkingHeader.parentHash) {
        return bestHeader;
      }

      // Get the new parent
      assert(checkingHeader.parentHash, 'Expect checking header parentHash to be exist');
      checkingHeader = await this.blockchainService.getHeaderForHash(checkingHeader.parentHash);
    }

    if (!this.lastCheckedBlockHeight) {
      return undefined;
    }

    return this.blockchainService.getHeaderForHeight(this.lastCheckedBlockHeight);
  }

  // Finds the last POI that had a correct block hash, this is used with the Eth sdk
  protected async findFinalizedUsingPOI(header: Header): Promise<Header> {
    const poiModel = this.storeModelProvider.poi;
    if (!poiModel) {
      throw new Error(POI_NOT_ENABLED_ERROR_MESSAGE);
    }

    let lastHeight = header.blockHeight;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const indexedBlocks: ProofOfIndex[] = await poiModel.getPoiBlocksBefore(lastHeight);

      if (!indexedBlocks.length) {
        break;
      }

      // Work backwards to find a block on chain that matches POI
      for (const indexedBlock of indexedBlocks) {
        const chainHeader = await this.blockchainService.getHeaderForHeight(indexedBlock.id);

        // Need to convert to PoiBlock to encode block hash to Uint8Array properly
        const testPoiBlock = PoiBlock.create(
          chainHeader.blockHeight,
          chainHeader.blockHash,
          new Uint8Array(),
          indexedBlock.projectId ?? ''
        );

        // Need isEqual because of Uint8Array type
        if (isEqual(testPoiBlock.chainBlockHash, indexedBlock.chainBlockHash)) {
          return chainHeader;
        }
      }

      // Next page of POI, use height rather than offset/limit as data could change in that time
      lastHeight = indexedBlocks[indexedBlocks.length - 1].id - 1;
    }

    throw new Error('Unable to find a POI block with matching block hash');
  }

  private async saveUnfinalizedBlocks(unfinalizedBlocks: UnfinalizedBlocks): Promise<void> {
    return this.storeModelProvider.metadata.set(METADATA_UNFINALIZED_BLOCKS_KEY, JSON.stringify(unfinalizedBlocks));
  }

  private async saveLastFinalizedVerifiedHeight(height: number): Promise<void> {
    return this.storeModelProvider.metadata.set(METADATA_LAST_FINALIZED_PROCESSED_KEY, height);
  }

  async resetUnfinalizedBlocks(tx?: Transaction): Promise<void> {
    await this.storeModelProvider.metadata.set(METADATA_UNFINALIZED_BLOCKS_KEY, '[]', tx);
    this._unfinalizedBlocks = [];
  }

  async resetLastFinalizedVerifiedHeight(tx?: Transaction): Promise<void> {
    return this.storeModelProvider.metadata.set(METADATA_LAST_FINALIZED_PROCESSED_KEY, null as any, tx);
  }

  //string should be jsonb object
  async getMetadataUnfinalizedBlocks(): Promise<UnfinalizedBlocks> {
    const val = await this.storeModelProvider.metadata.find(METADATA_UNFINALIZED_BLOCKS_KEY);
    if (val) {
      const result: (Header & {timestamp: string})[] = JSON.parse(val);
      return result.map(({timestamp, ...header}) => ({
        ...header,
        timestamp: new Date(timestamp),
      }));
    }
    return [];
  }

  async getLastFinalizedVerifiedHeight(): Promise<number | undefined> {
    return this.storeModelProvider.metadata.find(METADATA_LAST_FINALIZED_PROCESSED_KEY);
  }
}
