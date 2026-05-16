import { useEffect, useMemo, useState } from 'react';
import { getBase64EncodedWireTransaction, getTransactionDecoder } from '@solana/kit';
import {
  getBatchMerkleProofFetcher,
  getClaimableUtxoScannerFunction,
  getPublicBalanceToSelfClaimableUtxoCreatorFunction,
  getSelfClaimableUtxoToPublicBalanceClaimerFunction,
  getUmbraClient,
  getUmbraRelayer,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
} from '@umbra-privacy/sdk';
import {
  getClaimSelfClaimableUtxoIntoPublicBalanceProver,
  getCreateSelfClaimableUtxoFromPublicBalanceProver,
  getUserRegistrationProver,
} from '@umbra-privacy/web-zk-prover';

export type Status = 'READY' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'PENDING';
type StepKey = 'INIT' | 'REGISTER' | 'BUILD_CREATE' | 'SIGN_CREATE' | 'BROADCAST_CREATE' | 'SCAN' | 'BUILD_CLAIM' | 'SIGN_CLAIM' | 'BROADCAST_CLAIM' | 'DONE';
type StartPrivateFlowPayload = {
  transferContextId?: string;
  sender: string;
  receiver: string;
  mint: string;
  network?: string;
  rpcUrl?: string;
  rpcSubscriptionsUrl?: string;
  indexerApiEndpoint?: string;
  relayerApiEndpoint?: string;
  amountBaseUnits?: string;
  amountUi?: string;
  decimals?: number;
};

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toBigIntAmount(input: { amountBaseUnits?: string; amountUi?: string }, decimals = 6): bigint {
  if (input.amountBaseUnits) return BigInt(input.amountBaseUnits);
  const ui = Number(input.amountUi ?? '0');
  return BigInt(Math.floor(ui * 10 ** decimals));
}

function isBlockhashRetryable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return msg.includes('blockhash') || msg.includes('block height exceeded') || msg.includes('expired');
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= maxAttempts || !isBlockhashRetryable(error)) break;
    }
  }
  throw lastError;
}

function validateStartPayload(payload: unknown): { valid: true; data: StartPrivateFlowPayload } | { valid: false; message: string } {
  if (!payload || typeof payload !== 'object') return { valid: false, message: 'Payload must be an object' };
  const p = payload as Record<string, unknown>;
  const required = ['sender', 'receiver', 'mint'];
  for (const key of required) {
    if (typeof p[key] !== 'string' || !String(p[key]).trim()) {
      return { valid: false, message: `Missing required field: ${key}` };
    }
  }
  return { valid: true, data: p as StartPrivateFlowPayload };
}

const sleep = (ms: number) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const CLAIMED_UTXO_CACHE_KEY = 'sanafi_umbra_claimed_utxo_keys_v1';
const SCAN_CURSORS_STORAGE_KEY = 'sanafi_umbra_scan_cursors_v1';

function getUtxoKey(utxo: any): string | null {
  if (!utxo || typeof utxo !== 'object') return null;
  const treeIndex = utxo?.treeIndex ?? utxo?.tree_id ?? utxo?.tree;
  const leafIndex = utxo?.leafIndex ?? utxo?.leaf_index ?? utxo?.index;
  if (treeIndex === undefined || leafIndex === undefined) return null;
  return `${String(treeIndex)}:${String(leafIndex)}`;
}

function getSafeUtxoFallbackKey(utxo: any): string {
  const leafIndex = utxo?.leafIndex ?? utxo?.leaf_index ?? utxo?.index;
  const treeIndex = utxo?.treeIndex ?? utxo?.tree_id ?? utxo?.tree;
  const commitment = utxo?.commitment ?? '';
  return `leaf:${String(leafIndex)}|tree:${String(treeIndex)}|commitment:${String(commitment)}`;
}

function readClaimedUtxoKeys(): Set<string> {
  try {
    const raw = window.localStorage.getItem(CLAIMED_UTXO_CACHE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v) => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function writeClaimedUtxoKeys(keys: Set<string>) {
  try {
    const arr = Array.from(keys).slice(-500);
    window.localStorage.setItem(CLAIMED_UTXO_CACHE_KEY, JSON.stringify(arr));
  } catch {
    // no-op
  }
}

function readScanCursors(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(SCAN_CURSORS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writeScanCursors(cursors: Record<string, bigint>) {
  try {
    const serializable: Record<string, string> = {};
    Object.entries(cursors).forEach(([k, v]) => {
      serializable[k] = v.toString();
    });
    window.localStorage.setItem(SCAN_CURSORS_STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // no-op
  }
}

export function useApp() {
  const [bridgeReady, setBridgeReady] = useState(false);
  const [lastEvent, setLastEvent] = useState('No event yet');
  const [statusLabel, setStatusLabel] = useState('Ready');
  const [flowOutcome, setFlowOutcome] = useState<'IDLE' | 'SUCCESS' | 'FAILED'>('IDLE');
  const [lastSignature, setLastSignature] = useState('');
  const [sessionSummary, setSessionSummary] = useState<{
    receiver?: string;
    mint?: string;
    amountUi?: string;
  }>({});
  const [steps, setSteps] = useState<Array<{ label: string; status: Status }>>([
    { label: 'Handshake Session', status: 'READY' },
    { label: 'Build Private Tx', status: 'PENDING' },
    { label: 'Sign Transaction', status: 'PENDING' },
    { label: 'Broadcast via Sanafi API', status: 'PENDING' },
    { label: 'Scan & Claim UTXO', status: 'PENDING' },
  ]);

  const setFlowStep = (step: StepKey, status: Status) => {
    setSteps((prev) => {
      const next = [...prev];
      if (step === 'BUILD_CREATE') next[1] = { ...next[1], status };
      if (step === 'SIGN_CREATE' || step === 'SIGN_CLAIM') next[2] = { ...next[2], status };
      if (step === 'BROADCAST_CREATE' || step === 'BROADCAST_CLAIM') next[3] = { ...next[3], status };
      if (step === 'SCAN' || step === 'BUILD_CLAIM') next[4] = { ...next[4], status };
      return next;
    });
  };

  useEffect(() => {
    const bridge = window.sanafiUmbraBridge;
    if (!bridge) return;

    setBridgeReady(true);
    const unsubscribeAll = bridge.on('*', (envelope) => {
      setLastEvent(`${envelope.type} ${envelope.method}`);
    });

    const unsubscribePing = bridge.onRequest('PING', (payload) => ({
      ok: true,
      nonce: (payload as { nonce?: string })?.nonce ?? null,
    }));

    const unsubscribeInit = bridge.onRequest('INIT_SESSION', () => ({
      accepted: true,
      capabilities: ['SIGN_MESSAGE', 'SIGN_TRANSACTION', 'SIGN_ALL_TRANSACTIONS', 'BROADCAST_SIGNED_TX'],
      version: '1.0.0',
    }));

    const unsubscribeStart = bridge.onRequest('START_PRIVATE_FLOW', async (payload: unknown) => {
      const validated = validateStartPayload(payload);
      if (validated.valid === false) {
        bridge.emit('FLOW_ERROR', {
          step: 'INIT',
          code: 'INVALID_PAYLOAD',
          message: validated.message,
          retryable: false,
        });
        throw new Error('Invalid START_PRIVATE_FLOW payload');
      }

      const flowPayload = validated.data;
      setSessionSummary({
        receiver: flowPayload.receiver,
        mint: flowPayload.mint,
        amountUi: flowPayload.amountUi,
      });
      const flowId = `flow_${Date.now()}`;
      const startedAt = Date.now();
      const transferContextId = flowPayload.transferContextId as string | undefined;
      const sender = flowPayload.sender;
      const receiver = flowPayload.receiver;
      const mint = flowPayload.mint;
      const network = flowPayload.network === 'devnet' ? 'devnet' : 'mainnet';
      const rpcUrl = flowPayload.rpcUrl ?? import.meta.env.VITE_SOLANA_RPC_HTTP_URL;
      const rpcSubscriptionsUrl = flowPayload.rpcSubscriptionsUrl ?? import.meta.env.VITE_SOLANA_RPC_WS_URL;
      const indexerApiEndpoint = flowPayload.indexerApiEndpoint ?? 'https://utxo-indexer.api.umbraprivacy.com';
      const relayerApiEndpoint = flowPayload.relayerApiEndpoint ?? 'https://relayer.api.umbraprivacy.com';
      const amount = toBigIntAmount(flowPayload, Number(flowPayload.decimals ?? 6));

      if (!rpcUrl) {
        bridge.emit('FLOW_ERROR', {
          step: 'INIT',
          code: 'INVALID_PAYLOAD',
          message: 'Missing rpcUrl for private flow.',
          retryable: false,
        });
        throw new Error('Missing rpcUrl');
      }

      const emitProgress = (step: StepKey, status: 'STARTED' | 'SUCCESS' | 'FAILED', details: string) => {
        setFlowStep(step, status === 'FAILED' ? 'FAILED' : status === 'STARTED' ? 'RUNNING' : 'SUCCESS');
        bridge.emit('FLOW_PROGRESS', {
          step,
          status,
          details,
          meta: { flowId, elapsedMs: Date.now() - startedAt },
        });
        if (step === 'INIT' || step === 'REGISTER' || step === 'BUILD_CREATE') setStatusLabel('Generating private proof...');
        else if (step === 'SIGN_CREATE' || step === 'SIGN_CLAIM') setStatusLabel('Waiting for transfer signature...');
        else if (step === 'BROADCAST_CREATE' || step === 'BROADCAST_CLAIM') setStatusLabel('Submitting to network...');
        else if (step === 'SCAN') setStatusLabel('Scanning for stealth account...');
        else if (step === 'BUILD_CLAIM') setStatusLabel('Moving funds to public balance...');
        else if (step === 'DONE' && status === 'SUCCESS') setStatusLabel('Transaction successful!');
        else if (status === 'FAILED') setStatusLabel('Transaction failed.');
      };

      const signOneTx = async (wireTxBase64: string, label: string): Promise<string> => {
        emitProgress(label === 'claim' ? 'SIGN_CLAIM' : 'SIGN_CREATE', 'STARTED', `Signing ${label} transaction`);
        const signed = await bridge.request<{ signedTransactionBase64: string }>('SIGN_TRANSACTION', { transactionBase64: wireTxBase64, label });
        emitProgress(label === 'claim' ? 'SIGN_CLAIM' : 'SIGN_CREATE', 'SUCCESS', `Signed ${label} transaction`);
        return signed.signedTransactionBase64;
      };

      const broadcastSigned = async (signedTx: string[], txType: 'register' | 'create' | 'claim') => {
        emitProgress(txType === 'claim' ? 'BROADCAST_CLAIM' : 'BROADCAST_CREATE', 'STARTED', `Broadcasting ${txType} tx`);
        const response = await bridge.request<{ signatures: string[] }>('BROADCAST_SIGNED_TX', { transferContextId, signedTx, txType });
        emitProgress(txType === 'claim' ? 'BROADCAST_CLAIM' : 'BROADCAST_CREATE', 'SUCCESS', `Broadcasted ${txType} tx`);
        return response.signatures || [];
      };

      let forwardingPhase: 'create' | 'claim' = 'create';

      const walletBridgeSigner = {
        address: sender,
        signMessage: async (message: Uint8Array) => {
          const signatureRes = await bridge.request<{ signatureBase64: string }>('SIGN_MESSAGE', {
            messageBase64: uint8ToBase64(message),
          });
          return {
            message,
            signature: base64ToUint8(signatureRes.signatureBase64),
            signer: sender,
          } as any;
        },
        signTransaction: async (tx: any) => {
          const wire = getBase64EncodedWireTransaction(tx);
          const signed = await bridge.request<{ signedTransactionBase64: string }>('SIGN_TRANSACTION', {
            transactionBase64: wire,
            label: 'sign',
          });
          const signedWire = base64ToUint8(signed.signedTransactionBase64);
          return getTransactionDecoder().decode(signedWire) as any;
        },
        signTransactions: async (txs: readonly any[]) => {
          const wireTxs = txs.map(tx => getBase64EncodedWireTransaction(tx));
          const signed = await bridge.request<{ signedTransactionsBase64: string[] }>('SIGN_ALL_TRANSACTIONS', {
            transactionsBase64: wireTxs,
          });
          return signed.signedTransactionsBase64.map(t => getTransactionDecoder().decode(base64ToUint8(t))) as any;
        },
      };

      try {
        emitProgress('INIT', 'STARTED', 'Initializing Umbra client');
        const client = await getUmbraClient(
          {
            signer: walletBridgeSigner as any,
            network: network as any,
            rpcUrl,
            rpcSubscriptionsUrl,
            indexerApiEndpoint,
          },
          {
            transactionForwarder: {
              forwardInParallel: async (transactions: readonly any[]) => {
                const signed: string[] = [];
                for (const tx of transactions) {
                  const wire = getBase64EncodedWireTransaction(tx as any);
                  signed.push(await signOneTx(wire, forwardingPhase));
                }
                return broadcastSigned(signed, forwardingPhase);
              },
              forwardSequentially: async (transactions: readonly any[]) => {
                const signatures: string[] = [];
                for (const tx of transactions) {
                  const wire = getBase64EncodedWireTransaction(tx as any);
                  const signed = await signOneTx(wire, forwardingPhase);
                  const [sig] = await broadcastSigned([signed], forwardingPhase);
                  if (sig) signatures.push(sig);
                }
                return signatures;
              },
              fireAndForget: async (transaction: any) => {
                const wire = getBase64EncodedWireTransaction(transaction as any);
                const signed = await signOneTx(wire, forwardingPhase);
                const [sig] = await broadcastSigned([signed], forwardingPhase);
                return sig ?? '';
              },
            } as any,
          },
        );
        emitProgress('INIT', 'SUCCESS', 'Umbra client initialized');

        emitProgress('REGISTER', 'STARTED', 'Checking sender registration');
        const queryUserAccount = getUserAccountQuerierFunction({ client });
        const senderStatus: any = await queryUserAccount(sender as any);
        if (senderStatus?.state === 'non_existent') {
          const registrationProver = getUserRegistrationProver();
          const registerUser = getUserRegistrationFunction({ client }, { zkProver: registrationProver });
          await registerUser({ confidential: true, anonymous: true });
        }
        emitProgress('REGISTER', 'SUCCESS', 'Sender registration ready');

        emitProgress('BUILD_CREATE', 'STARTED', 'Building create private UTXO');
        forwardingPhase = 'create';
        const createProver = getCreateSelfClaimableUtxoFromPublicBalanceProver();
        const createUtxo = getPublicBalanceToSelfClaimableUtxoCreatorFunction({ client }, { zkProver: createProver });
        const createResult: any = await withRetry(() => createUtxo({
          destinationAddress: receiver as any,
          mint: mint as any,
          amount: amount as any,
        }), 2);
        emitProgress('BUILD_CREATE', 'SUCCESS', 'Private UTXO created');

        emitProgress('SCAN', 'STARTED', 'Waiting 15s for indexer synchronization...');
        await sleep(15000);

        emitProgress('SCAN', 'STARTED', 'Scanning claimable UTXOs');
        const scanner = getClaimableUtxoScannerFunction({ client });
        let scanResult: any = { selfBurnable: [], publicSelfBurnable: [] };
        const maxScanAttempts = 4;
        const treeIndexes = [0n, 1n, 2n];
        const chunkSize = 5000n;
        const maxRoundsPerTree = 8;
        const lookbackChunks = 2n;
        const storedCursorMap = readScanCursors();
        const nextCursorMap: Record<string, bigint> = {};

        for (let attempt = 1; attempt <= maxScanAttempts; attempt += 1) {
          const allSelfBurnable: any[] = [];
          const allPublicSelfBurnable: any[] = [];
          for (const treeIndex of treeIndexes) {
            const treeKey = treeIndex.toString();
            const storedCursor = storedCursorMap[treeKey] ? BigInt(storedCursorMap[treeKey]) : 0n;
            const lookback = chunkSize * lookbackChunks;
            let cursor = storedCursor > lookback ? storedCursor - lookback : 0n;
            for (let round = 0; round < maxRoundsPerTree; round += 1) {
              const end = cursor + chunkSize;
              const results: any = await scanner(treeIndex as any, cursor as any, end as any);

              if (Array.isArray(results?.selfBurnable) && results.selfBurnable.length > 0) {
                allSelfBurnable.push(...results.selfBurnable);
              }
              if (Array.isArray(results?.publicSelfBurnable) && results.publicSelfBurnable.length > 0) {
                allPublicSelfBurnable.push(...results.publicSelfBurnable);
              }

              const nextCursor = results?.nextScanStartIndex;
              if (nextCursor === undefined || nextCursor === null || nextCursor === cursor) {
                break;
              }
              cursor = BigInt(nextCursor);
              nextCursorMap[treeKey] = cursor;
            }
          }

          const unique = new Map<string, any>();
          for (const utxo of allSelfBurnable) {
            const key = getUtxoKey(utxo) || getSafeUtxoFallbackKey(utxo);
            unique.set(key, utxo);
          }
          const uniquePublic = new Map<string, any>();
          for (const utxo of allPublicSelfBurnable) {
            const key = getUtxoKey(utxo) || getSafeUtxoFallbackKey(utxo);
            uniquePublic.set(key, utxo);
          }
          scanResult = {
            selfBurnable: Array.from(unique.values()),
            publicSelfBurnable: Array.from(uniquePublic.values()),
          };

          const burnableCount = scanResult.selfBurnable.length + scanResult.publicSelfBurnable.length;
          if (burnableCount > 0) {
            emitProgress('SCAN', 'SUCCESS', `Scan found ${burnableCount} claimable UTXO(s) on attempt ${attempt}/${maxScanAttempts}`);
            break;
          }

          if (attempt < maxScanAttempts) {
            emitProgress('SCAN', 'STARTED', `No claimable UTXO yet, retrying scan (${attempt}/${maxScanAttempts})`);
            await sleep(2000 * attempt);
          } else {
            emitProgress('SCAN', 'SUCCESS', 'Scan completed but no claimable UTXO found yet');
          }
        }
        writeScanCursors(nextCursorMap);

        const claimSigs: string[] = [];
        if (((scanResult?.selfBurnable || []).length + (scanResult?.publicSelfBurnable || []).length) > 0) {
          emitProgress('BUILD_CLAIM', 'STARTED', 'Building claim-all transaction');
          forwardingPhase = 'claim';
          const claimProver = getClaimSelfClaimableUtxoIntoPublicBalanceProver();
          const relayer = getUmbraRelayer({ apiEndpoint: relayerApiEndpoint });
          const fetchBatchMerkleProof = getBatchMerkleProofFetcher({ apiEndpoint: indexerApiEndpoint });
          const claimOne = getSelfClaimableUtxoToPublicBalanceClaimerFunction(
            { client },
            { zkProver: claimProver, relayer, fetchBatchMerkleProof } as any,
          );
          const claimedCache = readClaimedUtxoKeys();
          const claimablesRaw = [
            ...(Array.isArray(scanResult.selfBurnable) ? scanResult.selfBurnable : []),
            ...(Array.isArray(scanResult.publicSelfBurnable) ? scanResult.publicSelfBurnable : []),
          ];
          const claimables = claimablesRaw.filter((utxo: any) => {
            const key = getUtxoKey(utxo);
            return key ? !claimedCache.has(key) : true;
          });

          for (let i = 0; i < claimables.length; i += 1) {
            const utxo = claimables[i];
            emitProgress('BUILD_CLAIM', 'STARTED', `Claiming UTXO ${i + 1}/${claimables.length}`);
            const claimResult: any = await claimOne([utxo] as any);
            const batchSigs = Array.from(claimResult?.batches?.values?.() ?? [])
              .map((b: any) => b?.txSignature)
              .filter(Boolean);
            const directSigs = Array.isArray(claimResult?.signatures) ? claimResult.signatures.filter(Boolean) : [];
            const merged = [...batchSigs, ...directSigs];
            if (merged.length === 0) {
              throw new Error(`Claim ${i + 1} succeeded but signature was not returned.`);
            }
            claimSigs.push(...merged);
            const key = getUtxoKey(utxo);
            if (key) {
              claimedCache.add(key);
            }
          }
          writeClaimedUtxoKeys(claimedCache);
          emitProgress('BUILD_CLAIM', 'SUCCESS', `Claim-all completed (${claimSigs.length} signature(s))`);
        } else {
          emitProgress('BUILD_CLAIM', 'SUCCESS', 'No claimable UTXO available yet. Claim step skipped.');
        }

        emitProgress('DONE', 'SUCCESS', 'Private flow completed');
        bridge.emit('FLOW_RESULT', {
          flowId,
          success: true,
          transferContextId,
          transactions: {
            register: [],
            create: [createResult?.createUtxoSignature || createResult?.queueSignature].filter(Boolean),
            claim: claimSigs,
          },
          claimed: claimSigs.length > 0,
          finishedAt: Date.now(),
          elapsedMs: Date.now() - startedAt,
          mainSignature: createResult?.createUtxoSignature || createResult?.queueSignature || '',
        });
        setFlowOutcome('SUCCESS');
        setLastSignature(createResult?.createUtxoSignature || createResult?.queueSignature || '');

        return { accepted: true, flowId, startedAt: Date.now() };
      } catch (error: any) {
        setFlowOutcome('FAILED');
        setStatusLabel('Transaction failed.');
        console.error('[UMBRA_WEBVIEW_FLOW_ERROR]', {
          message: error?.message,
          stack: error?.stack,
        });
        bridge.emit('FLOW_ERROR', {
          step: 'DONE',
          code: 'UMBRA_FLOW_FAILED',
          message: error?.message || 'Umbra flow failed',
          retryable: false,
        });
        throw error;
      }
    });

    return () => {
      unsubscribeAll();
      unsubscribePing();
      unsubscribeInit();
      unsubscribeStart();
    };
  }, []);

  const bridgeStatus = useMemo(() => (bridgeReady ? 'CONNECTED' : 'NOT_READY'), [bridgeReady]);

  return {
    bridgeReady,
    bridgeStatus,
    lastEvent,
    statusLabel,
    flowOutcome,
    lastSignature,
    sessionSummary,
    steps,
  };
}

export function getStatusClass(status: Status): string {
  if (status === 'READY' || status === 'SUCCESS') return 'text-sanafi-accent';
  if (status === 'RUNNING') return 'text-sanafi-warn';
  if (status === 'FAILED') return 'text-sanafi-danger';
  return 'text-sanafi-muted';
}
