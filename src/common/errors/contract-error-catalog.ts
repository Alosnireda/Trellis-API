import { ErrorCode } from "./error-codes";

export interface ContractErrorMapping {
  contractCode: string;
  errorCode: ErrorCode;
  httpStatus: number;
  retryable: boolean;
  clientMessage: string;
  remediationHint: string;
}

export const CONTRACT_ERROR_CATALOG: readonly ContractErrorMapping[] = [
  {
    contractCode: "NOT_CONFIGURED",
    errorCode: ErrorCode.SERVICE_UNAVAILABLE,
    httpStatus: 503,
    retryable: false,
    clientMessage: "Oracle verification is not configured.",
    remediationHint: "Set SOROBAN_RPC_URL and ORACLE_CONTRACT_ADDRESS.",
  },
  {
    contractCode: "NETWORK_MISMATCH",
    errorCode: ErrorCode.PRECONDITION_FAILED,
    httpStatus: 409,
    retryable: false,
    clientMessage: "The oracle RPC is on a different Stellar network.",
    remediationHint: "Check STELLAR_NETWORK_PASSPHRASE against the RPC deployment.",
  },
  {
    contractCode: "RPC_ERROR",
    errorCode: ErrorCode.STELLAR_NETWORK_ERROR,
    httpStatus: 502,
    retryable: false,
    clientMessage: "The oracle RPC rejected the request.",
    remediationHint: "Inspect the RPC response and correct the request or configuration.",
  },
  {
    contractCode: "RPC_UNAVAILABLE",
    errorCode: ErrorCode.SERVICE_UNAVAILABLE,
    httpStatus: 503,
    retryable: true,
    clientMessage: "The oracle RPC is temporarily unavailable.",
    remediationHint: "Retry with backoff after the RPC endpoint recovers.",
  },
  {
    contractCode: "TRANSACTION_NOT_FOUND",
    errorCode: ErrorCode.TRANSACTION_UNCONFIRMED,
    httpStatus: 202,
    retryable: true,
    clientMessage: "The oracle transaction is not in the RPC retention window yet.",
    remediationHint: "Poll again; use an archival RPC for old transactions.",
  },
  {
    contractCode: "TRANSACTION_FAILED",
    errorCode: ErrorCode.ORACLE_VERIFICATION_FAILED,
    httpStatus: 409,
    retryable: false,
    clientMessage: "The oracle transaction failed on the ledger.",
    remediationHint: "Submit a new oracle transaction; do not retry the failed hash.",
  },
  {
    contractCode: "INSUFFICIENT_CONFIRMATIONS",
    errorCode: ErrorCode.TRANSACTION_UNCONFIRMED,
    httpStatus: 202,
    retryable: true,
    clientMessage: "The oracle transaction does not have enough confirmations.",
    remediationHint: "Poll again after more ledgers close.",
  },
  {
    contractCode: "TRANSACTION_HASH_MISMATCH",
    errorCode: ErrorCode.INVALID_TRANSACTION_ENVELOPE,
    httpStatus: 409,
    retryable: false,
    clientMessage: "The RPC envelope does not match the submitted transaction hash.",
    remediationHint: "Re-register the submission with the correct transaction hash.",
  },
  {
    contractCode: "INVALID_INVOCATION",
    errorCode: ErrorCode.MALFORMED_PAYLOAD,
    httpStatus: 400,
    retryable: false,
    clientMessage: "The transaction does not contain a direct contract invocation.",
    remediationHint: "Submit a transaction with exactly one submit_price invocation.",
  },
  {
    contractCode: "WRONG_CONTRACT",
    errorCode: ErrorCode.INVALID_PARAMETER,
    httpStatus: 400,
    retryable: false,
    clientMessage: "The transaction invokes the wrong contract or method.",
    remediationHint: "Invoke submit_price on the configured oracle contract.",
  },
  {
    contractCode: "INVALID_PAYLOAD",
    errorCode: ErrorCode.MALFORMED_PAYLOAD,
    httpStatus: 400,
    retryable: false,
    clientMessage: "The oracle arguments do not match the submit_price ABI.",
    remediationHint: "Use Address, Symbol, i128, u32, u64, u64 in ABI order.",
  },
  {
    contractCode: "PAYLOAD_MISMATCH",
    errorCode: ErrorCode.ORACLE_VERIFICATION_FAILED,
    httpStatus: 409,
    retryable: false,
    clientMessage: "The ledger arguments or event differ from the registered submission.",
    remediationHint: "Register the exact canonical XDR payload digest before submitting.",
  },
  {
    contractCode: "LEDGER_SCAN_LIMIT",
    errorCode: ErrorCode.QUOTA_EXCEEDED,
    httpStatus: 413,
    retryable: false,
    clientMessage: "The ledger scan exceeds the supported key limit.",
    remediationHint: "Split the scan into smaller requests.",
  },
  {
    contractCode: "EVENT_TOPIC_MISMATCH",
    errorCode: ErrorCode.ORACLE_VERIFICATION_FAILED,
    httpStatus: 409,
    retryable: false,
    clientMessage: "An oracle event had an unexpected topic.",
    remediationHint: "Verify the event decoder matches the deployed contract release.",
  },
  {
    contractCode: "EVENT_SCHEMA_MISMATCH",
    errorCode: ErrorCode.ORACLE_VERIFICATION_FAILED,
    httpStatus: 409,
    retryable: true,
    clientMessage: "The oracle event shape is not known to this API release.",
    remediationHint: "Deploy an updated decoder; the submission remains pending.",
  },
  {
    contractCode: "EVENT_DATA_TOO_LARGE",
    errorCode: ErrorCode.MALFORMED_PAYLOAD,
    httpStatus: 413,
    retryable: true,
    clientMessage: "An oracle event contains too many data fields.",
    remediationHint: "Deploy an updated decoder before retrying verification.",
  },
  {
    contractCode: "EVENT_SCAN_LIMIT",
    errorCode: ErrorCode.QUOTA_EXCEEDED,
    httpStatus: 413,
    retryable: true,
    clientMessage: "The transaction contains too many contract events to scan.",
    remediationHint: "Deploy an updated decoder; the submission remains pending.",
  },
];

const BY_CODE = new Map(
  CONTRACT_ERROR_CATALOG.map((entry) => [entry.contractCode, entry]),
);

export function findContractError(
  code: unknown,
): ContractErrorMapping | undefined {
  if (typeof code !== "string") return undefined;
  return BY_CODE.get(code.trim().toUpperCase());
}
