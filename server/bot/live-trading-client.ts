import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";
import { BigNumber } from "@ethersproject/bignumber";
import { storage } from "../storage";
import { apiRateLimiter } from "./rate-limiter";

const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_NATIVE_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const ERC1155_ABI = [
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
];

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

const POLYGON_RPC_ENDPOINTS = [
  "https://polygon-rpc.com",
  "https://polygon.llamarpc.com",
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc-mainnet.matic.quiknode.pro",
];

let currentRpcIndex = 0;
let lastRpcError = 0;

function getPolygonProvider(): JsonRpcProvider {
  if (Date.now() - lastRpcError < 30000 && currentRpcIndex < POLYGON_RPC_ENDPOINTS.length - 1) {
    currentRpcIndex++;
    console.log(`[RPC] Rotating to endpoint ${currentRpcIndex}: ${POLYGON_RPC_ENDPOINTS[currentRpcIndex].slice(0, 40)}...`);
  }
  return new JsonRpcProvider({
    url: POLYGON_RPC_ENDPOINTS[currentRpcIndex],
    timeout: 15000,
  }, { chainId: CHAIN_ID, name: "matic" });
}

async function getWorkingProvider(): Promise<JsonRpcProvider> {
  for (let i = 0; i < POLYGON_RPC_ENDPOINTS.length; i++) {
    const idx = (currentRpcIndex + i) % POLYGON_RPC_ENDPOINTS.length;
    try {
      const provider = new JsonRpcProvider({
        url: POLYGON_RPC_ENDPOINTS[idx],
        timeout: 10000,
      }, { chainId: CHAIN_ID, name: "matic" });
      await provider.getBlockNumber();
      currentRpcIndex = idx;
      return provider;
    } catch (err: any) {
      console.log(`[RPC] Endpoint ${idx} (${POLYGON_RPC_ENDPOINTS[idx].slice(0, 30)}...) failed: ${err.message?.slice(0, 80)}`);
    }
  }
  console.log(`[RPC] All endpoints failed, using default with static network`);
  return new JsonRpcProvider({
    url: POLYGON_RPC_ENDPOINTS[0],
    timeout: 15000,
  }, { chainId: CHAIN_ID, name: "matic" });
}

function markRpcError(): void {
  lastRpcError = Date.now();
}

function resetRpcIndex(): void {
  currentRpcIndex = 0;
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function serialRpcCall<T>(calls: (() => Promise<T>)[], delayMs = 1500): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (i > 0) await delay(delayMs);
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        results.push(await calls[i]());
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        const isRateLimit = err.message?.includes("Too many requests") || err.message?.includes("rate limit");
        const isNetworkError = err.message?.includes("could not detect network") || err.message?.includes("NETWORK_ERROR") || err.message?.includes("failed to meet quorum") || err.message?.includes("SERVER_ERROR");
        if (isRateLimit || isNetworkError) {
          markRpcError();
          const waitTime = isNetworkError ? 2000 : 3000;
          console.log(`[RPC] ${isNetworkError ? "Network error" : "Rate limited"} on call ${i} (attempt ${attempt + 1}), rotating and waiting ${waitTime}ms...`);
          await delay(waitTime);
        } else {
          break;
        }
      }
    }
    if (lastErr) throw lastErr;
  }
  return results;
}

async function withProviderRetry<T>(
  fn: (provider: JsonRpcProvider) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const provider = attempt === 0 ? getPolygonProvider() : await getWorkingProvider();
      return await fn(provider);
    } catch (err: any) {
      lastErr = err;
      const isRetryable = err.message?.includes("Too many requests") ||
        err.message?.includes("rate limit") ||
        err.message?.includes("could not detect network") ||
        err.message?.includes("NETWORK_ERROR") ||
        err.message?.includes("SERVER_ERROR") ||
        err.message?.includes("failed to meet quorum");
      if (isRetryable && attempt < maxRetries - 1) {
        markRpcError();
        console.log(`[RPC] Provider error (attempt ${attempt + 1}/${maxRetries}), rotating: ${err.message?.slice(0, 80)}`);
        await delay(3000);
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

function getSignatureType(): number {
  return process.env.POLYMARKET_FUNDER_ADDRESS ? 1 : 0;
}

function getFunderAddress(): string | undefined {
  return process.env.POLYMARKET_FUNDER_ADDRESS || undefined;
}

export interface LiveOrderResult {
  success: boolean;
  orderID?: string;
  errorMsg?: string;
  transactID?: string;
}

export interface LiveCancelResult {
  success: boolean;
  errorMsg?: string;
}

export interface BalanceInfo {
  balance: string;
  allowance: string;
}

export class LiveTradingClient {
  private client: ClobClient | null = null;
  private creds: ApiKeyCreds | null = null;
  private wallet: Wallet | null = null;
  private initialized = false;
  private initError: string | null = null;
  private detectedSigType: number | null = null;

  async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) {
      return { success: true };
    }
    try {
      const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
      if (!privateKey) {
        this.initError = "POLYMARKET_PRIVATE_KEY not set";
        return { success: false, error: this.initError };
      }

      const cleanKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
      this.wallet = new Wallet(cleanKey);
      const walletAddress = await this.wallet.getAddress();

      console.log(`[LiveTrading] Initializing with wallet: ${walletAddress}`);

      const baseSigType = getSignatureType();
      const funder = getFunderAddress();
      const sigTypesToTry = [baseSigType, ...[0, 1, 2].filter(s => s !== baseSigType)];
      console.log(`[LiveTrading] Base signature type: ${baseSigType}${funder ? `, funder: ${funder}` : " (EOA)"}`);

      let workingSigType = baseSigType;
      for (const sigType of sigTypesToTry) {
        try {
          const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, this.wallet, undefined, sigType, funder);
          try {
            this.creds = await tempClient.deriveApiKey();
            workingSigType = sigType;
            console.log(`[LiveTrading] Derived existing API key (sigType=${sigType})`);
            break;
          } catch {
            this.creds = await tempClient.createApiKey();
            workingSigType = sigType;
            console.log(`[LiveTrading] Created new API key (sigType=${sigType})`);
            break;
          }
        } catch (err: any) {
          console.log(`[LiveTrading] sigType=${sigType} failed for API key derivation: ${err.message?.slice(0, 80)}`);
        }
      }

      if (!this.creds) {
        this.initError = "Could not derive or create API key with any signature type";
        return { success: false, error: this.initError };
      }

      this.detectedSigType = workingSigType;
      console.log(`[LiveTrading] Using signature type: ${workingSigType}`);

      this.client = new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        this.wallet,
        this.creds,
        workingSigType,
        funder,
      );

      const ok = await this.client.getOk();
      console.log("[LiveTrading] CLOB connection test:", ok);

      this.initialized = true;
      this.initError = null;

      await storage.createEvent({
        type: "INFO",
        message: `Live trading client initialized. Wallet: ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`,
        data: { wallet: walletAddress },
        level: "info",
      });

      return { success: true };
    } catch (error: any) {
      this.initError = error.message;
      console.error(`[LiveTrading] Initialization error: ${error.message} | stack: ${error.stack?.split("\n").slice(0, 3).join(" → ") || "none"}`);
      await storage.createEvent({
        type: "ERROR",
        message: `Live trading initialization failed: ${error.message}`,
        data: { error: error.message, stack: error.stack?.slice(0, 300) },
        level: "error",
      });
      return { success: false, error: error.message };
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getInitError(): string | null {
    return this.initError;
  }

  getWalletAddress(): string | null {
    if (!this.wallet) return null;
    return this.wallet.address;
  }

  getApiCreds(): { apiKey: string; secret: string; passphrase: string } | null {
    if (!this.creds) return null;
    return {
      apiKey: this.creds.key,
      secret: this.creds.secret,
      passphrase: this.creds.passphrase,
    };
  }

  async getBalanceAllowance(tokenId: string): Promise<BalanceInfo | null> {
    if (!this.client || !this.initialized) return null;
    try {
      await this.client.updateBalanceAllowance({
        asset_type: "CONDITIONAL",
        token_id: tokenId,
      } as any);
      const result = await this.client.getBalanceAllowance({
        asset_type: "CONDITIONAL",
        token_id: tokenId,
      } as any);
      return {
        balance: result?.balance ?? "0",
        allowance: result?.allowance ?? "0",
      };
    } catch (error: any) {
      console.error(`[LiveTrading] Balance check error: ${error.message} | tokenId=${tokenId.slice(0, 12)}...`);
      return null;
    }
  }

  async getCollateralBalance(): Promise<BalanceInfo | null> {
    if (!this.client || !this.initialized || !this.wallet || !this.creds) return null;

    const tryWithSigType = async (sigType: number): Promise<BalanceInfo | null> => {
      try {
        const funder = getFunderAddress();
        const testClient = new ClobClient(
          CLOB_HOST, CHAIN_ID, this.wallet!, this.creds!,
          sigType, funder,
        );
        await testClient.updateBalanceAllowance({ asset_type: "COLLATERAL" } as any);
        const result = await testClient.getBalanceAllowance({ asset_type: "COLLATERAL" } as any);
        return {
          balance: result?.balance ?? "0",
          allowance: result?.allowance ?? "0",
        };
      } catch {
        return null;
      }
    };

    if (this.detectedSigType !== null) {
      const result = await tryWithSigType(this.detectedSigType);
      if (result && parseFloat(result.balance) > 0) return result;
    }

    for (const sigType of [0, 2, 1]) {
      const result = await tryWithSigType(sigType);
      if (result && parseFloat(result.balance) > 0) {
        if (this.detectedSigType !== sigType) {
          this.detectedSigType = sigType;
          console.log(`[LiveTrading] Detected working signature type: ${sigType} (balance: ${result.balance})`);
          await this.reinitializeWithSigType(sigType);
        }
        return result;
      }
    }

    const fallback = await tryWithSigType(getSignatureType());
    return fallback || { balance: "0", allowance: "0" };
  }

  getSignatureInfo(): { signatureType: number; funderAddress: string | null; detectedSigType: number | null } {
    return {
      signatureType: getSignatureType(),
      funderAddress: getFunderAddress() || null,
      detectedSigType: this.detectedSigType,
    };
  }

  private async reinitializeWithSigType(sigType: number): Promise<void> {
    if (!this.wallet || !this.creds) return;
    try {
      const funder = getFunderAddress();
      this.client = new ClobClient(
        CLOB_HOST, CHAIN_ID, this.wallet, this.creds,
        sigType, funder,
      );
      console.log(`[LiveTrading] Reinitialized CLOB client with sigType=${sigType}`);
    } catch (error: any) {
      console.error(`[LiveTrading] Failed to reinitialize with sigType=${sigType}: ${error.message}`);
    }
  }

  async getOnChainUsdcBalance(): Promise<{ usdcE: string; usdcNative: string; total: string } | null> {
    if (!this.wallet) return null;
    try {
      return await withProviderRetry(async (provider) => {
        const address = await this.wallet!.getAddress();
        const usdcEContract = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
        const usdcNativeContract = new Contract(USDC_NATIVE_ADDRESS, ERC20_ABI, provider);

        const [balE, balNative] = await serialRpcCall([
          () => usdcEContract.balanceOf(address).catch(() => BigInt(0)),
          () => usdcNativeContract.balanceOf(address).catch(() => BigInt(0)),
        ], 500);

        const formatUsdc = (raw: any): string => {
          const n = Number(raw) / 1e6;
          return n.toFixed(2);
        };

        const totalRaw = Number(balE) + Number(balNative);
        return {
          usdcE: formatUsdc(balE),
          usdcNative: formatUsdc(balNative),
          total: (totalRaw / 1e6).toFixed(2),
        };
      });
    } catch (error: any) {
      if (error.message?.includes("Too many requests") || error.message?.includes("rate limit")) markRpcError();
      console.error(`[LiveTrading] On-chain USDC balance error: ${error.message} | wallet=${this.wallet?.address || "none"} | stack: ${error.stack?.split("\n")[1]?.trim() || "none"}`);
      return null;
    }
  }

  async getApprovalStatus(): Promise<{
    usdcCtfExchange: string;
    usdcNegRiskExchange: string;
    usdcNegRiskAdapter: string;
    ctfExchange: boolean;
    ctfNegRiskExchange: boolean;
    ctfNegRiskAdapter: boolean;
  } | null> {
    if (!this.wallet) return null;
    try {
      return await withProviderRetry(async (provider) => {
        const address = await this.wallet!.getAddress();
        const usdc = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
        const ctf = new Contract(CTF_ADDRESS, ERC1155_ABI, provider);
        const zero = BigNumber.from(0);

        const results = await serialRpcCall<BigNumber | boolean>([
          () => usdc.allowance(address, CTF_EXCHANGE).catch(() => zero),
          () => usdc.allowance(address, NEG_RISK_CTF_EXCHANGE).catch(() => zero),
          () => usdc.allowance(address, NEG_RISK_ADAPTER).catch(() => zero),
          () => ctf.isApprovedForAll(address, CTF_EXCHANGE).catch(() => false),
          () => ctf.isApprovedForAll(address, NEG_RISK_CTF_EXCHANGE).catch(() => false),
          () => ctf.isApprovedForAll(address, NEG_RISK_ADAPTER).catch(() => false),
        ], 800);

        const allowCtf = results[0] as BigNumber;
        const allowNeg = results[1] as BigNumber;
        const allowAdapter = results[2] as BigNumber;
        const approvedCtf = results[3] as boolean;
        const approvedNegExch = results[4] as boolean;
        const approvedNegAdapter = results[5] as boolean;

        const formatAllowance = (val: BigNumber): string => {
          if (val.gt(BigNumber.from("1000000000000"))) return "999999999999.00";
          return (parseFloat(val.toString()) / 1e6).toFixed(2);
        };

        return {
          usdcCtfExchange: formatAllowance(allowCtf),
          usdcNegRiskExchange: formatAllowance(allowNeg),
          usdcNegRiskAdapter: formatAllowance(allowAdapter),
          ctfExchange: approvedCtf,
          ctfNegRiskExchange: approvedNegExch,
          ctfNegRiskAdapter: approvedNegAdapter,
        };
      });
    } catch (error: any) {
      console.error(`[LiveTrading] Approval status error: ${error.message}`);
      return null;
    }
  }

  async approveAll(): Promise<{
    success: boolean;
    results: { step: string; txHash?: string; error?: string; skipped?: boolean }[];
    error?: string;
  }> {
    if (!this.wallet) {
      return { success: false, results: [], error: "Wallet not initialized" };
    }

    const results: { step: string; txHash?: string; error?: string; skipped?: boolean }[] = [];

    try {
      await withProviderRetry(async (provider) => {
        const signer = this.wallet!.connect(provider);
        const address = await this.wallet!.getAddress();
        const maxApproval = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
        const usdc = new Contract(USDC_E_ADDRESS, ERC20_ABI, signer);
        const ctf = new Contract(CTF_ADDRESS, ERC1155_ABI, signer);

        const zero = BigNumber.from(0);
        const highThreshold = BigNumber.from("1000000000000");

        console.log("[LiveTrading] Checking current approval status (serialized)...");
        const checkResults = await serialRpcCall<BigNumber | boolean>([
          () => usdc.allowance(address, CTF_EXCHANGE).catch(() => zero),
          () => usdc.allowance(address, NEG_RISK_CTF_EXCHANGE).catch(() => zero),
          () => usdc.allowance(address, NEG_RISK_ADAPTER).catch(() => zero),
          () => ctf.isApprovedForAll(address, CTF_EXCHANGE).catch(() => false),
          () => ctf.isApprovedForAll(address, NEG_RISK_CTF_EXCHANGE).catch(() => false),
          () => ctf.isApprovedForAll(address, NEG_RISK_ADAPTER).catch(() => false),
        ], 1000);

        const allowCtf = checkResults[0] as BigNumber;
        const allowNeg = checkResults[1] as BigNumber;
        const allowAdapter = checkResults[2] as BigNumber;
        const approvedCtfExch = checkResults[3] as boolean;
        const approvedNegExch = checkResults[4] as boolean;
        const approvedNegAdapter = checkResults[5] as boolean;

        const approvalSteps: { name: string; check: () => boolean; execute: (overrides?: any) => Promise<any> }[] = [
          {
            name: "USDC → CTF Exchange",
            check: () => allowCtf.gt(highThreshold),
            execute: (ov) => usdc.approve(CTF_EXCHANGE, maxApproval, ov || {}),
          },
          {
            name: "USDC → Neg Risk Exchange",
            check: () => allowNeg.gt(highThreshold),
            execute: (ov) => usdc.approve(NEG_RISK_CTF_EXCHANGE, maxApproval, ov || {}),
          },
          {
            name: "USDC → Neg Risk Adapter",
            check: () => allowAdapter.gt(highThreshold),
            execute: (ov) => usdc.approve(NEG_RISK_ADAPTER, maxApproval, ov || {}),
          },
          {
            name: "CTF → CTF Exchange",
            check: () => approvedCtfExch,
            execute: (ov) => ctf.setApprovalForAll(CTF_EXCHANGE, true, ov || {}),
          },
          {
            name: "CTF → Neg Risk Exchange",
            check: () => approvedNegExch,
            execute: (ov) => ctf.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true, ov || {}),
          },
          {
            name: "CTF → Neg Risk Adapter",
            check: () => approvedNegAdapter,
            execute: (ov) => ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, ov || {}),
          },
        ];

        const feeData = await provider.getFeeData();
        const minTipGwei = BigNumber.from("30000000000");
        const gasOverrides: any = {};
        if (feeData.maxFeePerGas) {
          gasOverrides.maxFeePerGas = feeData.maxFeePerGas.mul(2);
          gasOverrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minTipGwei)
            ? feeData.maxPriorityFeePerGas
            : minTipGwei;
        } else if (feeData.gasPrice) {
          const minGasPrice = BigNumber.from("50000000000");
          gasOverrides.gasPrice = feeData.gasPrice.gt(minGasPrice) ? feeData.gasPrice : minGasPrice;
        }
        console.log(`[LiveTrading] Gas overrides: maxFee=${gasOverrides.maxFeePerGas?.toString()}, tip=${gasOverrides.maxPriorityFeePerGas?.toString()}, gasPrice=${gasOverrides.gasPrice?.toString()}`);

        for (const step of approvalSteps) {
          if (step.check()) {
            results.push({ step: step.name, skipped: true });
            console.log(`[LiveTrading] ${step.name}: already approved, skipping`);
          } else {
            console.log(`[LiveTrading] Approving ${step.name}...`);
            await delay(2000);
            const tx = await step.execute(gasOverrides);
            const receipt = await tx.wait();
            results.push({ step: step.name, txHash: receipt.transactionHash });
            console.log(`[LiveTrading] ${step.name} approved: ${receipt.transactionHash}`);
          }
        }
      });

      await storage.createEvent({
        type: "INFO",
        message: `All approvals completed: ${results.filter(r => !r.skipped).length} new, ${results.filter(r => r.skipped).length} already approved`,
        data: { results },
        level: "info",
      });

      return { success: true, results };
    } catch (error: any) {
      console.error(`[LiveTrading] Approval error: ${error.message}`);
      await storage.createEvent({
        type: "ERROR",
        message: `Approval failed: ${error.message}`,
        data: { error: error.message, completedSteps: results },
        level: "error",
      });
      return { success: false, results, error: error.message };
    }
  }

  async placeOrder(params: {
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    negRisk: boolean;
    tickSize: string;
  }): Promise<LiveOrderResult> {
    if (!this.client || !this.initialized) {
      return { success: false, errorMsg: "Client not initialized" };
    }

    try {
      const side = params.side === "BUY" ? Side.BUY : Side.SELL;

      const roundedPrice = this.roundToTickSize(params.price, params.tickSize);
      const roundedSize = Math.max(1, Math.round(params.size));

      console.log(`[LiveTrading] Placing ${params.side} order: ${roundedSize} @ $${roundedPrice} (tick: ${params.tickSize}, negRisk: ${params.negRisk})`);

      await storage.createEvent({
        type: "INFO",
        message: `LIVE ORDER: ${params.side} ${roundedSize} @ $${roundedPrice}`,
        data: { ...params, roundedPrice, roundedSize },
        level: "warn",
      });

      const attemptOrder = async (client: ClobClient): Promise<any> => {
        return client.createAndPostOrder(
          {
            tokenID: params.tokenId,
            price: roundedPrice,
            side,
            size: roundedSize,
          },
          {
            tickSize: params.tickSize,
            negRisk: params.negRisk,
          } as any,
          OrderType.GTC,
        );
      };

      let response: any;
      try {
        response = await attemptOrder(this.client);
      } catch (err: any) {
        const isInvalidSig = err.message?.toLowerCase().includes("invalid signature") ||
          err.message?.toLowerCase().includes("l2 auth");
        if (isInvalidSig) {
          console.log(`[LiveTrading] Invalid signature with current sigType, will auto-detect...`);
          response = { error: err.message };
        } else {
          throw err;
        }
      }

      const responseStr = JSON.stringify(response);
      console.log("[LiveTrading] Order response:", responseStr);

      const isInvalidSig = responseStr?.toLowerCase().includes("invalid signature") ||
        responseStr?.toLowerCase().includes("l2 auth");

      if (isInvalidSig && this.wallet && this.creds) {
        const currentSig = this.detectedSigType ?? getSignatureType();
        const sigTypesToTry = [0, 1, 2].filter(s => s !== currentSig);
        console.log(`[LiveTrading] Invalid signature with sigType=${currentSig}, trying alternatives: ${sigTypesToTry}`);

        for (const altSig of sigTypesToTry) {
          try {
            const funder = getFunderAddress();
            const altClient = new ClobClient(CLOB_HOST, CHAIN_ID, this.wallet, this.creds, altSig, funder);
            response = await attemptOrder(altClient);
            const altResponseStr = JSON.stringify(response);
            const stillInvalid = altResponseStr?.toLowerCase().includes("invalid signature") ||
              altResponseStr?.toLowerCase().includes("l2 auth");
            if (!stillInvalid) {
              this.detectedSigType = altSig;
              this.client = altClient;
              console.log(`[LiveTrading] sigType=${altSig} works! Reinitializing client.`);
              await storage.createEvent({
                type: "INFO",
                message: `Auto-detected signature type: ${altSig}`,
                data: { previousSigType: currentSig, newSigType: altSig },
                level: "info",
              });
              break;
            }
          } catch (retryErr: any) {
            console.log(`[LiveTrading] sigType=${altSig} also failed: ${retryErr.message?.slice(0, 80)}`);
          }
        }
      }

      const orderID = response?.orderID || response?.id || response?.orderHash;

      const isGeoBlocked = response?.status === 403 ||
        (typeof response?.error === "string" && response.error.toLowerCase().includes("regional restriction")) ||
        (typeof response?.error === "string" && response.error.toLowerCase().includes("access restricted"));

      if (isGeoBlocked) {
        const errorMsg = response?.error || "Access restricted due to regional restrictions";
        await storage.createEvent({
          type: "ORDER_REJECTED",
          message: `GEO-BLOCKED: ${errorMsg}`,
          data: { response, geoBlocked: true },
          level: "error",
        });
        return {
          success: false,
          errorMsg,
          geoBlocked: true,
        } as LiveOrderResult & { geoBlocked: boolean };
      }

      const hasError = response?.success === false ||
        response?.errorMsg ||
        (typeof response?.error === "string" && response.error.length > 0) ||
        (!orderID && !response?.transactID);

      if (hasError) {
        const errorMsg = response?.errorMsg || response?.error || "Order rejected by exchange (no order ID returned)";
        await storage.createEvent({
          type: "ORDER_REJECTED",
          message: `LIVE ORDER REJECTED: ${errorMsg}`,
          data: { response },
          level: "error",
        });
        return {
          success: false,
          errorMsg,
        };
      }

      await storage.createEvent({
        type: "ORDER_PLACED",
        message: `LIVE ORDER ACCEPTED: ${params.side} ${roundedSize} @ $${roundedPrice} (ID: ${orderID})`,
        data: { orderID, response },
        level: "info",
      });

      apiRateLimiter.recordSuccess();
      return {
        success: true,
        orderID,
        transactID: response?.transactID,
      };
    } catch (error: any) {
      console.error(`[LiveTrading] Place order error: ${error.message} | side=${params.side} size=${params.size} price=${params.price} tokenId=${params.tokenId.slice(0, 12)}... negRisk=${params.negRisk} | stack: ${error.stack?.split("\n")[1]?.trim() || "none"}`);
      await apiRateLimiter.recordError(error.message);
      await storage.createEvent({
        type: "ERROR",
        message: `LIVE ORDER ERROR: ${error.message}`,
        data: { error: error.message, params },
        level: "error",
      });
      return { success: false, errorMsg: error.message };
    }
  }

  async cancelOrder(orderHash: string): Promise<LiveCancelResult> {
    if (!this.client || !this.initialized) {
      return { success: false, errorMsg: "Client not initialized" };
    }

    try {
      console.log(`[LiveTrading] Cancelling order: ${orderHash}`);
      await this.client.cancelOrder({ orderID: orderHash } as any);

      await storage.createEvent({
        type: "ORDER_CANCELLED",
        message: `LIVE ORDER CANCELLED: ${orderHash}`,
        data: { orderHash },
        level: "info",
      });

      return { success: true };
    } catch (error: any) {
      console.error(`[LiveTrading] Cancel order error: ${error.message} | orderHash=${orderHash}`);
      return { success: false, errorMsg: error.message };
    }
  }

  async cancelAllOrders(): Promise<LiveCancelResult> {
    if (!this.client || !this.initialized) {
      return { success: false, errorMsg: "Client not initialized" };
    }

    try {
      console.log("[LiveTrading] Cancelling ALL orders");
      await this.client.cancelAll();

      await storage.createEvent({
        type: "ORDER_CANCELLED",
        message: "ALL LIVE ORDERS CANCELLED",
        data: {},
        level: "warn",
      });

      return { success: true };
    } catch (error: any) {
      console.error(`[LiveTrading] Cancel all orders error: ${error.message} | stack: ${error.stack?.split("\n")[1]?.trim() || "none"}`);
      return { success: false, errorMsg: error.message };
    }
  }

  async getOpenOrders(): Promise<any[]> {
    if (!this.client || !this.initialized) return [];

    try {
      const response = await this.client.getOpenOrders();
      return Array.isArray(response) ? response : [];
    } catch (error: any) {
      console.error(`[LiveTrading] Get open orders error: ${error.message} | stack: ${error.stack?.split("\n")[1]?.trim() || "none"}`);
      return [];
    }
  }

  async getOrderStatus(orderHash: string): Promise<any | null> {
    if (!this.client || !this.initialized) return null;

    try {
      const openOrders = await this.client.getOpenOrders({ id: orderHash } as any);
      const orders = Array.isArray(openOrders) ? openOrders : [];
      if (orders.length > 0) return orders[0];

      const allOrders = await this.client.getOpenOrders();
      const allOrdersList = Array.isArray(allOrders) ? allOrders : [];
      const found = allOrdersList.find((o: any) => o.id === orderHash);
      return found || { id: orderHash, status: "NOT_FOUND", size_matched: "0", original_size: "0" };
    } catch (error: any) {
      console.error(`[LiveTrading] Get order status error: ${error.message} | orderHash=${orderHash}`);
      return null;
    }
  }

  async getTradesForOrder(orderHash: string): Promise<any[]> {
    if (!this.client || !this.initialized) return [];

    try {
      const trades = await (this.client as any).getTrades?.({ id: orderHash }) || [];
      return Array.isArray(trades) ? trades : [];
    } catch {
      return [];
    }
  }

  private roundToTickSize(price: number, tickSize: string): number {
    const tick = parseFloat(tickSize);
    if (tick <= 0) return price;
    const rounded = Math.round(price / tick) * tick;
    const decimals = tickSize.includes(".") ? tickSize.split(".")[1].length : 0;
    return parseFloat(rounded.toFixed(decimals));
  }
}

export const liveTradingClient = new LiveTradingClient();
