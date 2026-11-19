import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  StellarOracleAdapter,
  hashOracleArguments,
} from "../../src/blockchain/oracle/services/stellar-oracle.adapter";

describe("Fuzz Coverage: Malformed Soroban Arguments (#339)", () => {
  const submitter = Keypair.random().publicKey();
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
  const args = [
    new Address(submitter).toScVal(),
    nativeToScVal("XLM_USD", { type: "symbol" }),
    nativeToScVal(100n, { type: "i128" }),
    nativeToScVal(2, { type: "u32" }),
    nativeToScVal(123n, { type: "u64" }),
    nativeToScVal(1n, { type: "u64" }),
  ];
  const payloadHash = hashOracleArguments(args);
  let adapter: StellarOracleAdapter;
  let getTransaction: jest.SpyInstance;

  function envelope(invocationArgs: xdr.ScVal[]) {
    return new TransactionBuilder(new Account(submitter, "0"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(new Contract(contractId).call("submit_price", ...invocationArgs))
      .setTimeout(30)
      .build();
  }

  function wrongValueFor(index: number): xdr.ScVal {
    switch (index) {
      case 0:
        return xdr.ScVal.scvString("not-an-address");
      case 1:
        return xdr.ScVal.scvString("s".repeat(1024));
      case 2:
        return xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)]);
      case 3:
        return xdr.ScVal.scvMap([]);
      case 4:
        return xdr.ScVal.scvU32(1);
      default:
        return xdr.ScVal.scvU32(1);
    }
  }

  function nextIndex(state: { value: number }): number {
    state.value = (state.value * 1103515245 + 12345) >>> 0;
    return state.value % args.length;
  }

  async function expectInvalidPayload(invocationArgs: xdr.ScVal[]) {
    const tx = envelope(invocationArgs);
    getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 100,
      envelopeXdr: tx.toEnvelope(),
    } as any);
    await expect(
      adapter.verify({
        submitter,
        payloadHash,
        transactionHash: Buffer.from(tx.hash()).toString("hex"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  }

  beforeEach(() => {
    jest
      .spyOn(rpc.Server.prototype, "getNetwork")
      .mockResolvedValue({ passphrase: Networks.TESTNET } as any);
    getTransaction = jest.spyOn(rpc.Server.prototype, "getTransaction");
    jest
      .spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValue({ sequence: 101 } as any);
    const config: any = {
      get: (key: string, fallback: unknown) =>
        ({
          SOROBAN_RPC_URL: "https://rpc.example.com",
          ORACLE_CONTRACT_ADDRESS: contractId,
          ORACLE_MIN_CONFIRMATIONS: 1,
        })[key] ?? fallback,
    };
    adapter = new StellarOracleAdapter(config);
  });

  afterEach(() => jest.restoreAllMocks());

  it("rejects missing and extra invocation arguments", async () => {
    await expectInvalidPayload(args.slice(0, args.length - 1));
    await expectInvalidPayload([...args, args[0]]);
  });

  it("rejects deterministic malformed Soroban argument shapes", async () => {
    const state = { value: 42 };
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const mutated = [...args];
      const index = nextIndex(state);
      mutated[index] = wrongValueFor(index);
      if (iteration % 3 === 0) mutated[(index + 1) % args.length] = wrongValueFor((index + 1) % args.length);
      await expectInvalidPayload(mutated);
    }
  });
});
