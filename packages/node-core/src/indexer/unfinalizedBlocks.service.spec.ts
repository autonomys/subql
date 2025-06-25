// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { EventEmitter2 } from '@nestjs/event-emitter';
import { IBlockchainService } from '../blockchain.service';
import { Header, IBlock } from '../indexer';
import { StoreCacheService, CacheMetadataModel } from './storeModelProvider';
import {
  METADATA_LAST_FINALIZED_PROCESSED_KEY,
  METADATA_UNFINALIZED_BLOCKS_KEY,
  UnfinalizedBlocksService,
} from './unfinalizedBlocks.service';
import { NodeConfig } from '../configure';

/* Notes:
 * Block hashes all have the format '0xabc' + block number
 * If they are forked they will have an `f` at the end
 */
const BlockchainService = {
  async getFinalizedHeader(): Promise<Header> {
    return Promise.resolve({
      blockHeight: 91,
      blockHash: `0xabc91f`,
      parentHash: `0xabc90f`,
      timestamp: new Date(),
    });
  },
  async getHeaderForHash(hash: string): Promise<Header> {
    const num = Number(hash.toString().replace('0xabc', '').replace('f', ''));
    return Promise.resolve({
      blockHeight: num,
      blockHash: hash,
      parentHash: `0xabc${num - 1}f`,
      timestamp: new Date(),
    });
  },
  async getHeaderForHeight(height: number): Promise<Header> {
    return Promise.resolve({
      blockHeight: height,
      blockHash: `0xabc${height}f`,
      parentHash: `0xabc${height - 1}f`,
      timestamp: new Date(),
    });
  },
} as IBlockchainService;

function getMockMetadata(): any {
  const data: Record<string, any> = {};
  return {
    upsert: ({ key, value }: any) => (data[key] = value),
    findOne: ({ where: { key } }: any) => ({ value: data[key] }),
    findByPk: (key: string) => data[key],
    find: (key: string) => data[key],
  } as any;
}

function mockStoreCache(): StoreCacheService {
  return {
    metadata: new CacheMetadataModel(getMockMetadata(), 'height'),
  } as StoreCacheService;
}

function mockBlock(height: number, hash: string, parentHash?: string): IBlock<any> {
  return {
    getHeader: () => {
      return { blockHeight: height, parentHash: parentHash ?? '', blockHash: hash, timestamp: new Date() };
    },
    block: {
      header: {
        blockHeight: height,
        blockHash: hash,
        parentHash: parentHash ?? '',
      },
    },
  };
}

describe('UnfinalizedBlocksService', () => {
  let unfinalizedBlocksService: UnfinalizedBlocksService;

  beforeEach(async () => {
    const defaultNodeConfig = { unfinalizedBlocks: true, finalizedDepth: undefined } as NodeConfig;
    unfinalizedBlocksService = new UnfinalizedBlocksService(
      defaultNodeConfig,
      mockStoreCache(),
      BlockchainService
    );
    jest.restoreAllMocks();
    await unfinalizedBlocksService.init(() => Promise.resolve());
  });

  afterEach(() => {
    (unfinalizedBlocksService as unknown as any)._unfinalizedBlocks = {};
  });

  it('can set finalized block', () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block.header);

    expect((unfinalizedBlocksService as any).finalizedBlockNumber).toBe(110);
  });

  it('cant set a lower finalized block', () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block.header);

    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(99, '0x1234').block.header);

    expect((unfinalizedBlocksService as any).finalizedBlockNumber).toBe(110);
  });

  it('keeps track of unfinalized blocks', async () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block.header);

    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(111, '0xabc111'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(112, '0xabc112'));

    expect((unfinalizedBlocksService as any).unfinalizedBlocks).toMatchObject([
      mockBlock(111, '0xabc111').block.header,
      mockBlock(112, '0xabc112').block.header,
    ]);
  });

  it('doesnt keep track of finalized blocks', async () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(120, '0xabc120').block.header);

    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(111, '0xabc111'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(112, '0xabc112'));

    expect((unfinalizedBlocksService as any).unfinalizedBlocks).toEqual([]);
  });

  it('can process unfinalized blocks', async () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block.header);

    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(111, '0xabc111'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(112, '0xabc112'));

    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(112, '0xabc112', '0xabc111').block.header);

    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(113, '0xabc113'));

    expect((unfinalizedBlocksService as any).unfinalizedBlocks).toMatchObject([
      mockBlock(113, '0xabc113').block.header,
    ]);
  });

  it('can handle a fork and rewind to the last finalized height', async () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block.header);

    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(111, '0xabc111'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(112, '0xabc112'));

    // Forked block
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(112, '0xabc112f', '0xabc111').block.header);

    const res = await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(113, '0xabc113'));

    // Last valid block
    expect(res).toMatchObject({ blockHash: '0xabc111', blockHeight: 111, parentHash: '' });

    // After this the call stack is something like:
    // indexerManager -> blockDispatcher -> project -> project -> reindex -> blockDispatcher.resetUnfinalizedBlocks
    await unfinalizedBlocksService.resetUnfinalizedBlocks();

    expect((unfinalizedBlocksService as any).unfinalizedBlocks).toEqual([]);
  });

  it('can handle a fork when some unfinalized blocks are invalid', async () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block.header);

    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(111, '0xabc111'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(112, '0xabc112'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(113, '0xabc113'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(114, '0xabc114'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(115, '0xabc115'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(116, '0xabc116'));

    // Forked block
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(113, '0xabc113f', '0xabc112').block.header);

    const res = await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(117, '0xabc117'));

    // Last valid block
    expect(res).toMatchObject({ blockHash: '0xabc112', blockHeight: 112, parentHash: '' });
  });

  it('can handle a fork when all unfinalized blocks are invalid', async () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block.header);

    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(111, '0xabc111'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(112, '0xabc112'));

    // Forked block
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(111, '0xabc111f', '0xabc110').block.header);

    const res = await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(113, '0xabc113'));

    // Last valid block
    expect(res).toMatchObject({ blockHash: '0xabc110f', blockHeight: 110, parentHash: '0xabc109f' });
  });

  it('can handle a fork and when unfinalized blocks < finalized head', async () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block.header);

    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(111, '0xabc111'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(112, '0xabc112'));

    // Forked block
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(120, '0xabc120f', '0xabc119f').block.header);

    const res = await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(113, '0xabc113'));

    // Last valid block
    expect(res).toMatchObject({ blockHash: '0xabc110f', blockHeight: 110, parentHash: '0xabc109f' });
  });

  it('can handle a fork and when unfinalized blocks < finalized head 2', async () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block);

    (unfinalizedBlocksService as any).lastCheckedBlockHeight = 110;

    await (unfinalizedBlocksService as any).registerUnfinalizedBlock(
      mockBlock(111, '0xabc111', null as any).block.header
    );
    await (unfinalizedBlocksService as any).registerUnfinalizedBlock(
      mockBlock(112, '0xabc112', null as any).block.header
    );

    // Forked block
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(120, '0xabc120f', '0xabc119f').block.header);

    const res = await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(113, '0xabc113'));

    // Last valid block
    expect(res).toMatchObject({ blockHash: '0xabc110f', blockHeight: 110, parentHash: '0xabc109f' });
  });

  it('can handle a fork and when unfinalized blocks < finalized head with a large difference', async () => {
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(110, '0xabcd').block.header);

    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(111, '0xabc111'));
    await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(112, '0xabc112'));

    // Forked block
    unfinalizedBlocksService.registerFinalizedBlock(mockBlock(1200, '0xabc1200f', '0xabc1199f').block.header);

    const res = await unfinalizedBlocksService.processUnfinalizedBlocks(mockBlock(113, '0xabc113'));

    // Last valid block
    expect(res).toMatchObject({ blockHash: '0xabc110f', blockHeight: 110, parentHash: '0xabc109f' });
  });

  it('can rewind any unfinalized blocks when restarted and unfinalized blocks is disabled', async () => {
    const storeCache = new StoreCacheService(null as any, { storeCacheThreshold: 300 } as any, new EventEmitter2());

    storeCache.init('height', {} as any, undefined);

    await storeCache.metadata.set(
      METADATA_UNFINALIZED_BLOCKS_KEY,
      JSON.stringify(<Header[]>[
        { blockHeight: 90, blockHash: '0xabcd' },
        { blockHeight: 91, blockHash: '0xabc91' },
        { blockHeight: 92, blockHash: '0xabc92' },
      ])
    );
    await storeCache.metadata.set(METADATA_LAST_FINALIZED_PROCESSED_KEY, 90);
    const unfinalizedBlocksService2 = new UnfinalizedBlocksService(
      { unfinalizedBlocks: false } as any,
      storeCache,
      BlockchainService
    );

    const reindex = jest.fn().mockReturnValue(Promise.resolve());

    await unfinalizedBlocksService2.init(reindex);

    expect(reindex).toHaveBeenCalledWith(
      expect.objectContaining({ blockHash: '0xabc90f', blockHeight: 90, parentHash: '0xabc89f' })
    );
    expect((unfinalizedBlocksService2 as any).lastCheckedBlockHeight).toBe(90);
  });
});

// New describe block for finalizedDepth specific tests
describe('UnfinalizedBlocksService with finalizedDepth', () => {
  let service: UnfinalizedBlocksService;
  let mockBlockchainService: jest.Mocked<IBlockchainService>;

  // Helper to create service with specific config and mocked blockchainService
  // IMPORTANT: This helper now ONLY creates the service instance. Tests must call init().
  const createServiceInstance = (configOptions: Partial<NodeConfig> = {}) => {
    const nodeConfig = { 
      unfinalizedBlocks: true, 
      finalizedDepth: undefined, 
      ...configOptions 
    } as NodeConfig;

    // Create fresh mocks for each test
    mockBlockchainService = {
      getFinalizedHeader: jest.fn(),
      getHeaderForHash: jest.fn(),
      getHeaderForHeight: jest.fn(),
      getBestHeight: jest.fn(),
      // Add other methods from IBlockchainService if they are called and need mocking for these tests
    } as unknown as jest.Mocked<IBlockchainService>; // Cast needed due to partial mock

    service = new UnfinalizedBlocksService(
      nodeConfig,
      mockStoreCache(),
      mockBlockchainService
    );
    // REMOVED: await service.init(() => Promise.resolve());
    return service; // Return the uninitialized service instance
  };

  it('Test 1: finalizedDepth active - effective finality is tip - depth', async () => {
    // Setup
    const finalizedDepth = 10;
    const initialTip = 100;
    const expectedInitialEffectiveFinality = initialTip - finalizedDepth; // 90

    service = createServiceInstance({ finalizedDepth }); // Get instance

    mockBlockchainService.getBestHeight.mockResolvedValue(initialTip);
    mockBlockchainService.getHeaderForHeight
      .mockImplementation(async (height: number) => mockBlock(height, `0xabc${height}`).block.header);
    // Mock actual chain finality to be older, to ensure depth rule takes precedence
    mockBlockchainService.getFinalizedHeader.mockResolvedValue(mockBlock(50, '0xabc50').block.header);

    await service.init(() => Promise.resolve()); // Test calls init itself

    // Assert initial effective finality
    expect(mockBlockchainService.getBestHeight).toHaveBeenCalled();
    expect(mockBlockchainService.getHeaderForHeight).toHaveBeenCalledWith(expectedInitialEffectiveFinality);
    expect((service as any).effectiveFinalizedHeader.blockHeight).toBe(expectedInitialEffectiveFinality);

    // Action: Simulate a new block processed (tip moves)
    const newTip = 101;
    const expectedNewEffectiveFinality = newTip - finalizedDepth; // 91
    mockBlockchainService.getBestHeight.mockResolvedValue(newTip);

    await service.processUnfinalizedBlockHeader(mockBlock(newTip, `0xabc${newTip}`).block.header);

    // Assert new effective finality
    // getBestHeight is called in updateEffectiveFinalizedHeader, which is called by processUnfinalizedBlockHeader
    expect(mockBlockchainService.getHeaderForHeight).toHaveBeenCalledWith(expectedNewEffectiveFinality);
    expect((service as any).effectiveFinalizedHeader.blockHeight).toBe(expectedNewEffectiveFinality);
  });

  it('Test 2: finalizedDepth NOT active - effective finality follows chain-reported finality', async () => {
    service = createServiceInstance({ finalizedDepth: undefined }); // Get instance

    const initialChainFinalized = mockBlock(91, '0xabc91').block.header;
    mockBlockchainService.getFinalizedHeader.mockResolvedValue(initialChainFinalized);
    // getBestHeight might be called by updateEffectiveFinalizedHeader, but its result shouldn't dictate finality here
    mockBlockchainService.getBestHeight.mockResolvedValue(100);

    await service.init(() => Promise.resolve()); // Test calls init itself

    // Effective finality should be the chain-reported one
    expect((service as any).effectiveFinalizedHeader.blockHeight).toBe(initialChainFinalized.blockHeight);
    expect((service as any).effectiveFinalizedHeader.blockHash).toBe(initialChainFinalized.blockHash);
    // getBestHeight might be called once if no candidate from _knownChainFinalizedHeader yet in updateEffectiveFinalizedHeader, then getFinalizedHeader
    // but getHeaderForHeight for depth calc should NOT be called if finalizedDepth is undefined.
    expect(mockBlockchainService.getHeaderForHeight).not.toHaveBeenCalledWith(expect.anything());

    // Action: Chain finality advances
    const newChainFinalized = mockBlock(95, '0xabc95').block.header;
    mockBlockchainService.getFinalizedHeader.mockResolvedValue(newChainFinalized); // Future calls to getFinalizedHeader return this
    await service.registerFinalizedBlock(newChainFinalized); // This updates _knownChainFinalizedHeader and calls updateEffectiveFinalizedHeader

    // Assert: Effective finality should update to new chain finality
    expect((service as any).effectiveFinalizedHeader.blockHeight).toBe(newChainFinalized.blockHeight);

    // Action: Process a new block (advances tip), effective finality should NOT change based on tip
    mockBlockchainService.getBestHeight.mockResolvedValue(101);
    await service.processUnfinalizedBlockHeader(mockBlock(101, '0xabc101').block.header);
    expect((service as any).effectiveFinalizedHeader.blockHeight).toBe(newChainFinalized.blockHeight); // Still 95
  });

  it('Test 3: finalizedDepth active - pruning of _unfinalizedBlocks', async () => {
    const finalizedDepth = 5;
    service = createServiceInstance({ finalizedDepth }); // Get instance

    // Initial setup: tip=95, so effectiveFinalized=90
    mockBlockchainService.getBestHeight.mockResolvedValue(95);
    mockBlockchainService.getHeaderForHeight.mockImplementation(async (h: number) => mockBlock(h, `0xabc${h}`).block.header);
    mockBlockchainService.getFinalizedHeader.mockResolvedValue(mockBlock(50, '0xabc50').block.header); // Chain finality is old

    await service.init(() => Promise.resolve()); // Test calls init itself
    expect((service as any).effectiveFinalizedHeader.blockHeight).toBe(90);

    // Process blocks 91, 92, 93, 94, 95. 
    // _effectiveFinalizedHeader will move with each, but _unfinalizedBlocks will accumulate those > current effective.
    for (let i = 1; i <= 5; i++) {
      const currentProcessingHeight = 90 + i;
      mockBlockchainService.getBestHeight.mockResolvedValue(currentProcessingHeight); // Tip is at the block being processed
      await service.processUnfinalizedBlockHeader(mockBlock(currentProcessingHeight, `0xabc${currentProcessingHeight}`).block.header);
    }
    // After processing H95 (tip=95, effective=90): _unfinalizedBlocks = [B91, B92, B93, B94, B95]
    expect((service as any).unfinalizedBlocks.length).toBe(5);
    expect((service as any).unfinalizedBlocks.map((b: Header) => b.blockHeight)).toEqual([91, 92, 93, 94, 95]);

    // Action: Advance tip to 98. This should make effective finality 93 (98-5).
    // When processUnfinalizedBlockHeader is called, it will first call updateEffectiveFinalizedHeader.
    // Then it will call deleteFinalizedBlock based on the new effective finality.
    mockBlockchainService.getBestHeight.mockResolvedValue(98);
    
    // Call processUnfinalizedBlockHeader with undefined. 
    // This triggers updateEffectiveFinalizedHeader (setting effective to 93) 
    // and then the fork check/deleteFinalizedBlock logic which should prune blocks <= 93.
    await service.processUnfinalizedBlockHeader(undefined); 

    // Assert: Blocks <= 93 should be pruned.
    // _unfinalizedBlocks should be [B94, B95]
    let currentUnfinalizedBlocks = (service as any).unfinalizedBlocks as Header[];
    expect(currentUnfinalizedBlocks.map((b: Header) => b.blockHeight).sort((a,b)=>a-b)).toEqual([94, 95]);
    expect(currentUnfinalizedBlocks.length).toBe(2);

    // Further check: Now, sequentially add blocks 96, 97, 98 to ensure list remains consistent
    // Tip is still 98, effective finality is 93. Last unfinalized is 95.
    mockBlockchainService.getBestHeight.mockResolvedValue(98); // Keep tip at 98 for these additions
    await service.processUnfinalizedBlockHeader(mockBlock(96, '0xabc96').block.header);
    currentUnfinalizedBlocks = (service as any).unfinalizedBlocks as Header[];
    expect(currentUnfinalizedBlocks.map((b: Header) => b.blockHeight).sort((a,b)=>a-b)).toEqual([94, 95, 96]);
    
    // Tip could advance here or stay, let's assume it advances with each block for this part of test
    mockBlockchainService.getBestHeight.mockResolvedValue(99); // Tip is now 99, effective is 94
    await service.processUnfinalizedBlockHeader(mockBlock(97, '0xabc97').block.header);
    currentUnfinalizedBlocks = (service as any).unfinalizedBlocks as Header[];
    expect(currentUnfinalizedBlocks.map((b: Header) => b.blockHeight).sort((a,b)=>a-b)).toEqual([95, 96, 97]); // 94 got pruned

    mockBlockchainService.getBestHeight.mockResolvedValue(100); // Tip is now 100, effective is 95
    await service.processUnfinalizedBlockHeader(mockBlock(98, '0xabc98').block.header);
    currentUnfinalizedBlocks = (service as any).unfinalizedBlocks as Header[];
    expect(currentUnfinalizedBlocks.map((b: Header) => b.blockHeight).sort((a,b)=>a-b)).toEqual([96, 97, 98]); // 95 got pruned
  });

  it('Test 4: finalizedDepth active - depth calculation fails, falls back to chain finality', async () => {
    const finalizedDepth = 10;
    service = createServiceInstance({ finalizedDepth }); // Get instance

    // Create our mocks BEFORE init
    const chainFinalized = mockBlock(80, '0xabc80').block.header;
    
    // Make sure chainFinalized has all required properties of a Header
    console.log('Debug - chainFinalized header:', {
      blockHeight: chainFinalized.blockHeight,
      blockHash: chainFinalized.blockHash,
      parentHash: chainFinalized.parentHash,
      hasTimestamp: !!chainFinalized.timestamp
    });
    
    // Explicitly ensure getBestHeight fails with a rejection
    mockBlockchainService.getBestHeight.mockRejectedValue(new Error('RPC down!'));
    
    // Ensure getFinalizedHeader returns a complete valid header
    mockBlockchainService.getFinalizedHeader.mockResolvedValue({
      blockHeight: 80,
      blockHash: '0xabc80',
      parentHash: '0xabc79',
      timestamp: new Date()  // Ensure timestamp is explicitly included
    });

    // Now call init with our mocks in place
    await service.init(() => Promise.resolve());
    
    // Directly check internal state after init
    console.log('Debug - After init - Service state:', {
      knownChainFinalizedHeader: (service as any)._knownChainFinalizedHeader?.blockHeight,
      effectiveFinalizedHeader: (service as any)._effectiveFinalizedHeader?.blockHeight,
      finalizedDepth: (service as any).nodeConfig.finalizedDepth
    });

    // Verify expected behavior
    expect(mockBlockchainService.getBestHeight).toHaveBeenCalled();
    expect(mockBlockchainService.getFinalizedHeader).toHaveBeenCalled();
    
    // Access the protected property directly for debugging
    const effectiveHeader = (service as any)._effectiveFinalizedHeader;
    if (!effectiveHeader) {
      console.error('FAILURE - _effectiveFinalizedHeader is undefined after init!');
    } else {
      console.log('Debug - effectiveHeader:', {
        blockHeight: effectiveHeader.blockHeight,
        blockHash: effectiveHeader.blockHash
      });
    }
    
    // Test should pass if the fallback to chain finality worked
    expect(effectiveHeader).toBeDefined();
    expect(effectiveHeader.blockHeight).toBe(80);
    
    // Original assertion - only try if effectiveHeader exists
    if (effectiveHeader) {
      expect((service as any).effectiveFinalizedHeader.blockHeight).toBe(80);
    }

    // --- Further test: depth calc fails, initial chain finality fetch fails, subsequent fetch succeeds ---
    console.log('\nDebug - Test 4 - Starting second part (resilience test)');
    // Reset internal states to simulate a fresh scenario where these are not yet known
    (service as any)._knownChainFinalizedHeader = undefined;
    (service as any)._effectiveFinalizedHeader = undefined; 

    // Mock getBestHeight to continue failing (for depth calculation)
    mockBlockchainService.getBestHeight.mockRejectedValue(new Error('RPC down for resilience test part!'));
    
    let finalizeCallCount = 0;
    mockBlockchainService.getFinalizedHeader.mockImplementation(async () => {
      finalizeCallCount++;
      console.log(`Debug - Test 4 (resilience) - getFinalizedHeader called, count: ${finalizeCallCount}`);
      if (finalizeCallCount === 1) {
        console.log('Debug - Test 4 (resilience) - getFinalizedHeader: Simulating first call failure');
        throw new Error('Chain finality RPC temporarily down for resilience test');
      }
      console.log('Debug - Test 4 (resilience) - getFinalizedHeader: Simulating second call success (H85)');
      // Ensure a complete Header object is returned
      return { blockHeight: 85, blockHash: '0xabc85', parentHash: '0xabc84', timestamp: new Date() }; 
    });
    
    // First attempt to update effective finality: 
    // Depth calc will fail (getBestHeight rejects).
    // _knownChainFinalizedHeader is undefined.
    // Fallback getFinalizedHeader() will be called (finalizeCallCount becomes 1) and will throw an error.
    // So, _effectiveFinalizedHeader should remain undefined.
    await (service as any).updateEffectiveFinalizedHeader();
    console.log(`Debug - Test 4 (resilience) - After 1st updateEffectiveFinalizedHeader call: _effectiveFinalizedHeader is ${(service as any)._effectiveFinalizedHeader?.blockHeight}`);
    expect((service as any)._effectiveFinalizedHeader).toBeUndefined(); 
    expect(finalizeCallCount).toBe(1); // getFinalizedHeader was called once and failed

    // Second attempt to update effective finality:
    // Depth calc will fail again.
    // _knownChainFinalizedHeader is still undefined.
    // Fallback getFinalizedHeader() will be called again (finalizeCallCount becomes 2) and will succeed, returning H85.
    // So, _effectiveFinalizedHeader should now be H85.
    await (service as any).updateEffectiveFinalizedHeader();
    console.log(`Debug - Test 4 (resilience) - After 2nd updateEffectiveFinalizedHeader call: _effectiveFinalizedHeader is ${(service as any)._effectiveFinalizedHeader?.blockHeight}`);
    
    expect((service as any)._effectiveFinalizedHeader).toBeDefined();
    expect((service as any).effectiveFinalizedHeader.blockHeight).toBe(85); // Now it should be set
    expect(finalizeCallCount).toBe(2); // getFinalizedHeader was called again and succeeded
  });

  it('Test 5: finalizedDepth active - fork detected based on effective finality', async () => {
    // Setup
    const finalizedDepth = 10;
    const initialTip = 100; // So initial effectiveFinalized is 90
    const forkPointHeight = 90;
    const firstUnfinalizedHeight = forkPointHeight + 1; // 91

    service = createServiceInstance({ finalizedDepth }); // Get instance

    // ---- Initial state setup ----
    // Mock chain's actual finality to be much older
    mockBlockchainService.getFinalizedHeader.mockResolvedValue(mockBlock(50, '0xabc50').block.header);
    // Mock best height for initial calculation
    mockBlockchainService.getBestHeight.mockResolvedValue(initialTip);
    // Mock getHeaderForHeight to return canonical blocks initially
    mockBlockchainService.getHeaderForHeight.mockImplementation(async (height: number) => {
      return mockBlock(height, `0xabc${height}_canonical`, `0xabc${height - 1}_canonical`).block.header;
    });
    // Mock getHeaderForHash for parent lookups during fork processing
    mockBlockchainService.getHeaderForHash.mockImplementation(async (hash: string) => {
      if (hash === '0xabc90_canonical') { // Parent of 91f and 91_canonical
        return mockBlock(forkPointHeight, '0xabc90_canonical').block.header;
      }
      // Add other specific hash lookups if needed for more complex fork scenarios
      const height = parseInt(hash.replace('0xabc', '').replace('_canonical', '').replace('f', ''), 10);
      if (!isNaN(height)) {
        return mockBlock(height, hash).block.header;
      }
      throw new Error(`Mock getHeaderForHash not implemented for ${hash}`);
    });

    await service.init(() => Promise.resolve()); // Effective finality becomes H90 (100-10)
    expect((service as any).effectiveFinalizedHeader.blockHeight).toBe(forkPointHeight);
    expect((service as any).effectiveFinalizedHeader.blockHash).toBe('0xabc90_canonical');

    // ---- Process some blocks that are initially considered canonical by our node ----
    // Tip moves as we process, affecting subsequent effective finality calc for that call
    mockBlockchainService.getBestHeight.mockResolvedValue(firstUnfinalizedHeight); // Tip is now 91
    await service.processUnfinalizedBlockHeader(mockBlock(firstUnfinalizedHeight, '0xabc91_canonical', '0xabc90_canonical').block.header);
    // After processing 91: effective finality = 91-10 = 81. _unfinalizedBlocks = [H91can]
    
    mockBlockchainService.getBestHeight.mockResolvedValue(firstUnfinalizedHeight + 1); // Tip is now 92
    await service.processUnfinalizedBlockHeader(mockBlock(firstUnfinalizedHeight + 1, '0xabc92_canonical', '0xabc91_canonical').block.header);
    // After processing 92: effective finality = 92-10 = 82. _unfinalizedBlocks = [H91can, H92can]
    expect((service as any).unfinalizedBlocks.length).toBe(2);
    expect((service as any).unfinalizedBlocks[0].blockHash).toBe('0xabc91_canonical');

    // ---- Introduce the fork ----
    // The *true* chain tip (from blockchainService.getBestHeight) advances, and the header for height 91 is now different (forked)
    mockBlockchainService.getBestHeight.mockResolvedValue(firstUnfinalizedHeight + 2); // e.g., tip is 93
    
    // Crucially, when updateEffectiveFinalizedHeader runs, it will use getBestHeight (93),
    // calculate target as 93-10=83. Then it calls getHeaderForHeight(83).
    // The fork information comes when hasForked tries to validate block 91c against a potentially forked chain view.
    // Let's make getHeaderForHeight return the forked block when asked for height 91
    const forkedBlock91 = mockBlock(firstUnfinalizedHeight, '0xabc91_forked', '0xabc90_canonical').block.header; 
    mockBlockchainService.getHeaderForHeight.mockImplementation(async (height: number) => {
      if (height === firstUnfinalizedHeight) return forkedBlock91;
      return mockBlock(height, `0xabc${height}_canonical`, `0xabc${height-1}_canonical`).block.header;
    });

    // Also, let's say the actual *chain reported finality* jumps to this forked block
    // This will directly set _knownChainFinalizedHeader to the forked block
    // and then updateEffectiveFinalizedHeader will run. If depth is active, it'll try tip-depth first.
    // If tip-depth (e.g. 83) is older than the forked block (91f), then 91f (if it became _knownChainFinalizedHeader) could become _effective.
    // This part is tricky. The easiest way to inject the fork for `hasForked` is for `_effectiveFinalizedHeader` to become the forked block.

    // Let's simulate that _effectiveFinalizedHeader becomes the forked version of H91
    // This happens if the `updateEffectiveFinalizedHeader` logic, using `getBestHeight()` and then `getHeaderForHeight(tip-depth)`,
    // ends up fetching `forkedBlock91` because `tip-depth` resolved to `firstUnfinalizedHeight` (91).
    const newTipForFork = finalizedDepth + firstUnfinalizedHeight; // e.g., 10 + 91 = 101. So 101-10 = 91.
    mockBlockchainService.getBestHeight.mockResolvedValue(newTipForFork); 
    // getHeaderForHeight for 91 is already mocked to return forkedBlock91.

    // Now, process a new block (e.g. 93). This will trigger updateEffectiveFinalizedHeader first.
    // updateEffectiveFinalizedHeader: best=101, target=91. getHeaderForHeight(91) -> forkedBlock91.
    // So, _effectiveFinalizedHeader becomes forkedBlock91.
    const result = await service.processUnfinalizedBlockHeader(mockBlock(firstUnfinalizedHeight + 2, '0xabc93_after_fork', 'some_parent').block.header);

    // ---- Assertions ----
    // hasForked should have been called. It compares _unfinalizedBlocks (which has 0xabc91_canonical)
    // with _effectiveFinalizedHeader (which is now 0xabc91_forked).
    // It should detect a fork at height 91.
    // getLastCorrectFinalizedBlock should then be called with forkedBlock91.
    // It should trace back from forkedBlock91 (parent 0xabc90_canonical) and see that 0xabc90_canonical matches our _unfinalizedBlocks history (or is the block before it).
    // Actually, _unfinalizedBlocks was [H91can, H92can]. lastVerifiableBlock for H91f would be H91can.
    // Their hashes differ. Fork detected. Returns H91f.
    // getLastCorrectFinalizedBlock(H91f) is called.
    // It iterates _unfinalizedBlocks in reverse: [H92can, H91can].
    //   - checkingHeader = H91f. Compare with H92can -> no match. parentHash of H92can is H91can.
    //     New checkingHeader becomes H91can (parent of H92can, by walking up chain from H91f via its parent H90can... this part is tricky)
    //   The logic is: for (const bestHeader of bestVerifiableBlocks.reverse()) { if (bestHeader.blockHash === checkingHeader.blockHash || bestHeader.blockHash === checkingHeader.parentHash) return bestHeader }
    // Let's simplify: the rewind should be to the common ancestor, which is H90_canonical.

    expect(result).toBeDefined();
    expect(result?.blockHeight).toBe(forkPointHeight); // Should rewind to 90
    expect(result?.blockHash).toBe('0xabc90_canonical'); // The parent of the fork
  });
});

// New describe block for comprehensive fork detection tests
describe('UnfinalizedBlocksService with comprehensiveForkDetection', () => {
  let service: UnfinalizedBlocksService;
  let mockBlockchainService: jest.Mocked<IBlockchainService>;

  const createServiceWithComprehensiveCheck = async (
    comprehensiveForkDetection: boolean = true,
    finalizedDepth: number = 10
  ) => {
    const nodeConfig = { 
      unfinalizedBlocks: true, 
      finalizedDepth,
      comprehensiveForkDetection,
    } as NodeConfig;

    mockBlockchainService = {
      getFinalizedHeader: jest.fn(),
      getHeaderForHash: jest.fn(),
      getHeaderForHeight: jest.fn(),
      getBestHeight: jest.fn(),
    } as unknown as jest.Mocked<IBlockchainService>;

    service = new UnfinalizedBlocksService(
      nodeConfig,
      mockStoreCache(),
      mockBlockchainService
    );

    // Setup default mocks
    mockBlockchainService.getBestHeight.mockResolvedValue(100);
    mockBlockchainService.getFinalizedHeader.mockResolvedValue(mockBlock(50, '0xabc50').block.header);
    
    // Mock getHeaderForHash for parent hash lookups
    mockBlockchainService.getHeaderForHash.mockImplementation(async (hash: string) => {
      const num = parseInt(hash.replace('0xabc', '').replace('_canonical', '').replace('_orphan', ''), 10);
      if (!isNaN(num)) {
        return mockBlock(num, hash, `0xabc${num - 1}`).block.header;
      }
      throw new Error(`Mock getHeaderForHash not implemented for ${hash}`);
    });
    
    await service.init(() => Promise.resolve());
    return service;
  };

  it('should detect multiple orphan blocks and return the deepest fork', async () => {
    // Create service with comprehensive check enabled
    service = await createServiceWithComprehensiveCheck(true, 10);
    
    // Setup: current tip is 115, so finalized = 105
    mockBlockchainService.getBestHeight.mockResolvedValue(100);
    
    // Mock the chain's view of blocks
    mockBlockchainService.getHeaderForHeight.mockImplementation(async (height: number) => {
      // Simulate orphan blocks at heights 101 and 103
      if (height === 101) {
        return mockBlock(101, '0xabc101_canonical', '0xabc100').block.header;
      }
      if (height === 103) {
        return mockBlock(103, '0xabc103_canonical', '0xabc102').block.header;
      }
      return mockBlock(height, `0xabc${height}`, `0xabc${height - 1}`).block.header;
    });

    // Process blocks including the orphans
    // Add blocks to unfinalized list (some are orphans)
    await service.processUnfinalizedBlockHeader(mockBlock(100, '0xabc100').block.header);
    await service.processUnfinalizedBlockHeader(mockBlock(101, '0xabc101_orphan', '0xabc100').block.header); // Orphan!
    await service.processUnfinalizedBlockHeader(mockBlock(102, '0xabc102').block.header);
    await service.processUnfinalizedBlockHeader(mockBlock(103, '0xabc103_orphan', '0xabc102').block.header); // Orphan!
    await service.processUnfinalizedBlockHeader(mockBlock(104, '0xabc104').block.header);
    await service.processUnfinalizedBlockHeader(mockBlock(105, '0xabc105').block.header);
    
    // Process blocks sequentially to advance tip
    for (let i = 106; i <= 115; i++) {
      mockBlockchainService.getBestHeight.mockResolvedValue(i);
      await service.processUnfinalizedBlockHeader(mockBlock(i, `0xabc${i}`, `0xabc${i-1}`).block.header);
    }

    // Now trigger fork detection with finalized at 105 (tip 115 - depth 10)
    mockBlockchainService.getBestHeight.mockResolvedValue(115);
    const forkedHeader = await (service as any).hasForked();

    // Should detect the deepest fork at height 101
    expect(forkedHeader).toBeDefined();
    expect(forkedHeader.blockHeight).toBe(101);
    expect(forkedHeader.blockHash).toBe('0xabc101_canonical');

    // Verify that both orphans were detected in logs
    // We can't directly test logs, but we can verify the behavior
  });

  it('should only check the last block when comprehensive check is disabled', async () => {
    // Create service with comprehensive check DISABLED
    service = await createServiceWithComprehensiveCheck(false, 10);
    
    // Start with a reasonable initial tip
    mockBlockchainService.getBestHeight.mockResolvedValue(100);
    
    // Mock the chain's view - orphan at 101, but 105 is correct
    mockBlockchainService.getHeaderForHeight.mockImplementation(async (height: number) => {
      if (height === 101) {
        return mockBlock(101, '0xabc101_canonical', '0xabc100').block.header;
      }
      return mockBlock(height, `0xabc${height}`, `0xabc${height - 1}`).block.header;
    });

    // Process blocks including the orphan
    await service.processUnfinalizedBlockHeader(mockBlock(100, '0xabc100').block.header);
    await service.processUnfinalizedBlockHeader(mockBlock(101, '0xabc101_orphan', '0xabc100').block.header); // Orphan!
    
    // Process correct blocks sequentially up to 115
    for (let i = 102; i <= 115; i++) {
      mockBlockchainService.getBestHeight.mockResolvedValue(i);
      await service.processUnfinalizedBlockHeader(mockBlock(i, `0xabc${i}`, `0xabc${i-1}`).block.header);
    }

    // Now trigger fork detection
    const forkedHeader = await (service as any).hasForked();

    // Should NOT detect the orphan at 101 because it only checks block 105
    expect(forkedHeader).toBeUndefined();
  });

  it('should handle the Subspace convergent fork scenario', async () => {
    // This tests the exact scenario from the user's example
    service = await createServiceWithComprehensiveCheck(true, 10);
    
    const orphanHeight = 3269020;
    const currentTip = 3269030;
    
    // Start with a reasonable initial tip
    mockBlockchainService.getBestHeight.mockResolvedValue(3269010);
    
    // Mock the chain's view where block 3269020 has a different hash
    mockBlockchainService.getHeaderForHeight.mockImplementation(async (height: number) => {
      if (height === orphanHeight) {
        // The canonical version
        return {
          blockHeight: orphanHeight,
          blockHash: '0xd2d3d77d27e03c12f347d88059b033d2b7659b20e84b73e8b38b50d39d2998bf',
          parentHash: '0xfee1fa6cd69a7b4cc26e1da29dc314a91c6a12ada4ee3984dc6b9802a43c9be9',
          timestamp: new Date(),
        };
      }
      // Default blocks
      return mockBlock(height, `0xabc${height}`, `0xabc${height - 1}`).block.header;
    });

    // Process blocks sequentially including the orphan version
    for (let i = 3269010; i < orphanHeight; i++) {
      mockBlockchainService.getBestHeight.mockResolvedValue(i);
      await service.processUnfinalizedBlockHeader(mockBlock(i, `0xabc${i}`, `0xabc${i-1}`).block.header);
    }
    
    // Process the orphan block (our indexed version)
    mockBlockchainService.getBestHeight.mockResolvedValue(orphanHeight);
    await service.processUnfinalizedBlockHeader({
      blockHeight: orphanHeight,
      blockHash: '0x81a7d55fd23846b08ed8d7a4c56879ef43f3537332e97d6a4cd7799ba5b742d1',
      parentHash: '0xabc3269019',
      timestamp: new Date(),
    });

    // Process subsequent blocks sequentially
    for (let i = orphanHeight + 1; i <= currentTip; i++) {
      mockBlockchainService.getBestHeight.mockResolvedValue(i);
      await service.processUnfinalizedBlockHeader(mockBlock(i, `0xabc${i}`, `0xabc${i-1}`).block.header);
    }

    // Now trigger fork detection
    const forkedHeader = await (service as any).hasForked();

    // Should detect the orphan block
    expect(forkedHeader).toBeDefined();
    expect(forkedHeader.blockHeight).toBe(orphanHeight);
    expect(forkedHeader.blockHash).toBe('0xd2d3d77d27e03c12f347d88059b033d2b7659b20e84b73e8b38b50d39d2998bf');
  });

  it('should continue checking all blocks even if one RPC call fails', async () => {
    service = await createServiceWithComprehensiveCheck(true, 10);
    
    // Start with initial tip
    mockBlockchainService.getBestHeight.mockResolvedValue(100);
    
    // Mock getHeaderForHeight to fail for block 101 but succeed for others
    mockBlockchainService.getHeaderForHeight.mockImplementation(async (height: number) => {
      if (height === 101) {
        throw new Error('RPC timeout');
      }
      if (height === 103) {
        return mockBlock(103, '0xabc103_canonical', '0xabc102').block.header;
      }
      return mockBlock(height, `0xabc${height}`, `0xabc${height - 1}`).block.header;
    });

    // Add blocks to unfinalized list
    for (let i = 100; i <= 110; i++) {
      mockBlockchainService.getBestHeight.mockResolvedValue(i);
      if (i === 103) {
        // Add an orphan at 103
        await service.processUnfinalizedBlockHeader(mockBlock(i, '0xabc103_orphan', `0xabc${i-1}`).block.header);
      } else {
        await service.processUnfinalizedBlockHeader(mockBlock(i, `0xabc${i}`, `0xabc${i-1}`).block.header);
      }
    }

    // Advance tip to 113 so finalized = 103, which means blocks <= 103 will be checked
    mockBlockchainService.getBestHeight.mockResolvedValue(113);
    
    // Now trigger fork detection by processing another block
    await service.processUnfinalizedBlockHeader(mockBlock(111, '0xabc111', '0xabc110').block.header);

    // Get the forked header from hasForked
    const forkedHeader = await (service as any).hasForked();

    // Should still detect the orphan at 103 despite the RPC error at 101
    expect(forkedHeader).toBeDefined();
    expect(forkedHeader.blockHeight).toBe(103);
    expect(forkedHeader.blockHash).toBe('0xabc103_canonical');
  });
});
