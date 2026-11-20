import { RepairCheckpoint } from "./repair-job";

export const DEFAULT_REPAIR_CHECKPOINT_DIR = ".repair";

export const REPAIR_USAGE = `Operator-safe dry-run repair tooling with checkpoints

Usage:
  npm run repair -- --job <name>                   dry-run preview (default, writes nothing)
  npm run repair -- --job <name> --id <run> --apply write repairs under checkpoint id
  npm run repair -- --job <name> --id <run> --report print stored checkpoint details and exit
  npm run repair -- --job <name> --id <run> --rollback restore journaled before-images newest-first
  npm run repair -- --job <name> --id <run> --restart --force discard checkpoint and restart
  npm run repair -- --list                         list saved repair checkpoints

Options:
  --job <name>            repair adapter to run (required unless --list or --help)
  --id <run>              checkpoint id (defaults to --job name)
  --apply                 execute repair modifications (default is dry-run preview)
  --dry-run               explicitly run in dry-run mode (default)
  --report                print stored checkpoint without executing
  --rollback              rollback applied repairs using checkpoint before-images
  --restart               discard existing checkpoint before executing
  --force                 required when --restart has journaled rollback data
  --list                  list all saved repair checkpoints
  --batch-size <n>        batch size for paging (default: 100)
  --max-retries <n>       max retries per transient repair failure (default: 2)
  --checkpoint-dir <path> directory for checkpoints (default: .repair)
  --help, -h              display this help message

Exit codes: 0 success, 1 failure/errors, 2 invalid arguments`;

export interface RepairCliArgs {
  job?: string;
  id?: string;
  apply: boolean;
  dryRun: boolean;
  report: boolean;
  rollback: boolean;
  restart: boolean;
  force: boolean;
  list: boolean;
  help: boolean;
  batchSize: number;
  maxRepairRetries: number;
  checkpointDir: string;
}

function parsePositiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got '${raw}'`);
  }
  return value;
}

export function parseRepairArgs(argv: string[]): RepairCliArgs {
  const args: RepairCliArgs = {
    apply: false,
    dryRun: true,
    report: false,
    rollback: false,
    restart: false,
    force: false,
    list: false,
    help: false,
    batchSize: 100,
    maxRepairRetries: 2,
    checkpointDir: DEFAULT_REPAIR_CHECKPOINT_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--job":
        args.job = argv[++i];
        if (!args.job) throw new Error("--job requires a value");
        break;
      case "--id":
        args.id = argv[++i];
        if (!args.id) throw new Error("--id requires a value");
        break;
      case "--apply":
        args.apply = true;
        args.dryRun = false;
        break;
      case "--dry-run":
        args.dryRun = true;
        args.apply = false;
        break;
      case "--report":
        args.report = true;
        break;
      case "--rollback":
        args.rollback = true;
        break;
      case "--restart":
        args.restart = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--batch-size":
        args.batchSize = parsePositiveInt("--batch-size", argv[++i] ?? "");
        break;
      case "--max-retries":
        args.maxRepairRetries = parsePositiveInt("--max-retries", argv[++i] ?? "");
        break;
      case "--checkpoint-dir":
        args.checkpointDir = argv[++i];
        if (!args.checkpointDir) throw new Error("--checkpoint-dir requires a value");
        break;
      default:
        throw new Error(`Unknown argument '${token}'`);
    }
  }

  const modes = [args.list, args.report, args.rollback].filter(Boolean).length;
  if (modes > 1) {
    throw new Error("--list, --report and --rollback are mutually exclusive");
  }

  if (args.id && !args.job && !args.help && !args.list) {
    throw new Error("--id requires --job to identify the repair target");
  }

  if (!args.list && !args.help && !args.job) {
    throw new Error("--job is required");
  }

  if (args.list && args.job) {
    throw new Error("--list does not take --job");
  }

  if (args.list && args.id) {
    throw new Error("--list does not take --id");
  }

  if (args.restart && (args.list || args.report || args.rollback)) {
    throw new Error("--restart cannot be combined with --list, --report or --rollback");
  }

  if (args.apply && (args.report || args.rollback || args.list)) {
    throw new Error("--apply cannot be combined with --report, --rollback or --list");
  }

  if (args.force && !args.restart) {
    throw new Error("--force only applies to --restart");
  }

  return args;
}

export function resolveCheckpointId(args: RepairCliArgs): string {
  return args.id ?? args.job!;
}

export function formatRepairReport(checkpoint: RepairCheckpoint): string {
  const lines: string[] = [];
  lines.push(
    `Repair Job "${checkpoint.jobId}" — ${checkpoint.status}` +
      `${checkpoint.dryRun ? " [DRY-RUN PREVIEW - no changes committed]" : " [APPLIED]"}`,
  );
  lines.push(`  scanned        ${checkpoint.scanned}`);
  lines.push(`  detected       ${checkpoint.detected}`);
  lines.push(`  repaired       ${checkpoint.repaired}`);
  lines.push(`  failures       ${checkpoint.failures.length}`);
  lines.push(`  journal entries ${checkpoint.journal.length} (available for rollback)`);
  lines.push(`  cursor         ${checkpoint.cursor ?? "(completed/end)"}`);

  if (checkpoint.error) {
    lines.push(`  error          ${checkpoint.error}`);
  }

  if (checkpoint.failures.length > 0) {
    lines.push(`  failures list (${checkpoint.failures.length}):`);
    for (const failure of checkpoint.failures) {
      lines.push(`    - record ${failure.recordId}: ${failure.error}`);
    }
  }

  return lines.join("\n");
}
