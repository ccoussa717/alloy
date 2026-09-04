import { TEAM_LIMITS } from "../core/limits.ts";
import type {
  Admission,
  AdmittedMember,
  MemberContainmentInput,
  MemberExecution,
  MemberResult,
  MemberRunInput,
  TeamHost,
  TeamMember,
  TeamRunContext,
  TeamToolName,
} from "../core/types.ts";

interface StockPiModel {
  id: string;
  provider: string;
  input: unknown[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      inputTokensAbove: number;
    }>;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface StockPiSession {
  subscribe(listener: (event: { type: string; message?: unknown }) => void): () => void;
  prompt(text: string, options: { expandPromptTemplates: false }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

interface StockPiSdk {
  createAgentSession(options: {
    cwd: string;
    model: StockPiModel;
    resourceLoader: unknown;
    sessionManager: unknown;
    settingsManager: unknown;
    tools: string[];
  }): Promise<{ session: StockPiSession }>;
  DefaultResourceLoader: new (options: {
    cwd: string;
    agentDir: string;
    settingsManager: unknown;
    noExtensions: true;
    noSkills: true;
    noPromptTemplates: true;
    noThemes: true;
    noContextFiles: true;
  }) => { reload(): Promise<void> };
  getAgentDir(): string;
  SessionManager: { inMemory(cwd?: string): unknown };
  SettingsManager: {
    inMemory(settings?: Record<string, unknown>, options?: { projectTrusted?: boolean }): unknown;
  };
}

export interface StockPiHostOptions {
  sdk?: StockPiSdk;
  agentDir?: string;
  maxTimeoutMs?: number;
}

type Session = StockPiSession;

type AdmissionToken = Readonly<{
  owner: symbol;
  memberId: string;
  route: string;
  modelRoute: string;
  model: StockPiModel;
  capabilities: readonly string[];
  tools: readonly TeamToolName[];
  maxCostUsd: number;
  timeoutMs: number;
}>;

interface TrackedExecution {
  runId: string;
  memberId: string;
  handle: object;
  session?: Session;
  abortPromise?: Promise<void>;
  abortReason?: "aborted" | "contained" | "timeout";
  contained: boolean;
  disposed: boolean;
  finished: boolean;
}

interface UsageEvidence {
  input: number;
  output: number;
  costUsd: number;
  lastText: string;
  modelRoute: string | null;
  stopReason: string | null;
  error?: string;
}

const READ_ONLY_TOOLS = Object.freeze(["read", "grep", "find", "ls"] as const);
const READ_ONLY_TOOL_SET = new Set<string>(READ_ONLY_TOOLS);
const MAX_DEPENDENCIES = TEAM_LIMITS.members - 1;
const MAX_MEMBER_ID_BYTES = 64;

function maximumPromptInputBytes(): number {
  const emptyEnvelope = JSON.stringify({
    objective: "",
    instructions: "",
    dependencies: Array.from({ length: MAX_DEPENDENCIES }, () => ({
      memberId: "",
      text: "",
    })),
  });
  return Buffer.byteLength(emptyEnvelope, "utf8") +
    TEAM_LIMITS.objectiveBytes +
    TEAM_LIMITS.instructionBytes +
    (MAX_DEPENDENCIES * (MAX_MEMBER_ID_BYTES + TEAM_LIMITS.outputBytes));
}

const MAXIMUM_PROMPT_INPUT_BYTES = maximumPromptInputBytes();

function blocked(
  memberId: string,
  maxCostUsd: number,
  reason: string,
): Admission {
  return {
    ok: false,
    memberId,
    effectiveRoute: null,
    effectiveModel: null,
    effectiveCapabilities: [],
    effectiveTools: [],
    maxCostUsd,
    reason,
  };
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function activeModel(context: TeamRunContext): StockPiModel | undefined {
  if (!isPlainRecord(context.runtime)) return undefined;
  const selected = context.runtime.model;
  return isPlainRecord(selected) ? selected as unknown as StockPiModel : undefined;
}

function validateRateSet(value: unknown): value is {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  if (!isPlainRecord(value)) return false;
  return isFiniteNonnegative(value.input) &&
    isFiniteNonnegative(value.output) &&
    isFiniteNonnegative(value.cacheRead) &&
    isFiniteNonnegative(value.cacheWrite);
}

function effectiveRates(model: StockPiModel): { input: number; output: number } | undefined {
  if (!validateRateSet(model.cost)) return undefined;
  let rates = model.cost;
  const tiers = model.cost.tiers;
  if (tiers !== undefined) {
    if (!Array.isArray(tiers)) return undefined;
    let selectedThreshold = -1;
    for (const tier of tiers) {
      if (
        !validateRateSet(tier) ||
        !Number.isSafeInteger(tier.inputTokensAbove) ||
        tier.inputTokensAbove < 0
      ) {
        return undefined;
      }
      if (
        tier.inputTokensAbove <= MAXIMUM_PROMPT_INPUT_BYTES &&
        tier.inputTokensAbove >= selectedThreshold
      ) {
        rates = tier;
        selectedThreshold = tier.inputTokensAbove;
      }
    }
  }
  return { input: rates.input, output: rates.output };
}

function modelRoute(model: StockPiModel): string | undefined {
  if (
    typeof model.provider !== "string" || model.provider.length === 0 ||
    typeof model.id !== "string" || model.id.length === 0
  ) {
    return undefined;
  }
  return `${model.provider}/${model.id}`;
}

function affordableModel(
  source: StockPiModel,
  maxCostUsd: number,
): { model: StockPiModel; route: string } | { reason: string } {
  const route = modelRoute(source);
  if (
    route === undefined ||
    !Number.isSafeInteger(source.maxTokens) || source.maxTokens <= 0 ||
    !Number.isSafeInteger(source.contextWindow) || source.contextWindow <= 0
  ) {
    return { reason: "stock_model:active model metadata is invalid" };
  }
  const rates = effectiveRates(source);
  if (rates === undefined) {
    return { reason: "stock_pricing:model pricing must be finite and nonnegative" };
  }
  if (!isFiniteNonnegative(maxCostUsd) || maxCostUsd === 0) {
    return { reason: "stock_budget:member allocation must be positive and finite" };
  }

  const inputCost = (MAXIMUM_PROMPT_INPUT_BYTES * rates.input) / 1_000_000;
  if (!Number.isFinite(inputCost) || inputCost > maxCostUsd) {
    return { reason: "stock_budget:member allocation cannot fund the worst-case input" };
  }
  const remaining = maxCostUsd - inputCost;
  let maxTokens = source.maxTokens;
  if (rates.output > 0) {
    maxTokens = Math.min(maxTokens, Math.floor((remaining * 1_000_000) / rates.output));
    while (
      maxTokens > 0 &&
      inputCost + ((maxTokens * rates.output) / 1_000_000) > maxCostUsd
    ) {
      maxTokens -= 1;
    }
    if (maxTokens < 1) {
      return { reason: "stock_budget:member allocation cannot fund one output token" };
    }
  }

  const cost = Object.freeze({
    ...source.cost,
    tiers: source.cost.tiers?.map((tier) => Object.freeze({ ...tier })),
  });
  const cloned = Object.freeze({
    ...source,
    input: Object.freeze([...source.input]),
    headers: source.headers === undefined ? undefined : Object.freeze({ ...source.headers }),
    cost,
    maxTokens,
  }) as StockPiModel;
  return { model: cloned, route };
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value));
}

function validReadOnlyMember(member: TeamMember): string | undefined {
  if (!sameStrings(member.capabilities, ["repo.read"])) {
    return "stock_capability:only repo.read is supported";
  }
  if (
    member.tools.length === 0 ||
    new Set(member.tools).size !== member.tools.length ||
    member.tools.some((tool) => !READ_ONLY_TOOL_SET.has(tool))
  ) {
    return "stock_tool:only read, grep, find, and ls are supported";
  }
  return undefined;
}

function assertBoundedText(value: unknown, maximum: number, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw new Error(`stock_prompt:${label} exceeds its UTF-8 bound`);
  }
}

function serializePrompt(input: MemberRunInput): string {
  assertBoundedText(input.objective, TEAM_LIMITS.objectiveBytes, "objective");
  assertBoundedText(input.member.instructions, TEAM_LIMITS.instructionBytes, "instructions");
  if (input.dependencies.length > MAX_DEPENDENCIES) {
    throw new Error("stock_prompt:too many verified dependencies");
  }
  const dependencies = input.dependencies.map((dependency) => {
    assertBoundedText(dependency.memberId, MAX_MEMBER_ID_BYTES, "dependency memberId");
    assertBoundedText(dependency.text, TEAM_LIMITS.outputBytes, "dependency text");
    return { memberId: dependency.memberId, text: dependency.text };
  });
  const prompt = JSON.stringify({
    objective: input.objective,
    instructions: input.member.instructions,
    dependencies,
  });
  if (Buffer.byteLength(prompt, "utf8") > MAXIMUM_PROMPT_INPUT_BYTES) {
    throw new Error("stock_prompt:serialized prompt exceeds its admission bound");
  }
  return prompt;
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return Buffer.from(text, "utf8").subarray(0, TEAM_LIMITS.descriptionBytes).toString("utf8");
}

function addSafeInteger(left: number, right: unknown): number | undefined {
  if (!Number.isSafeInteger(right) || (right as number) < 0) return undefined;
  const sum = left + (right as number);
  return Number.isSafeInteger(sum) ? sum : undefined;
}

function observeAssistant(evidence: UsageEvidence, message: unknown, expectedRoute: string): void {
  if (!isPlainRecord(message) || message.role !== "assistant") return;
  const usage = message.usage;
  if (!isPlainRecord(usage) || !isPlainRecord(usage.cost)) {
    evidence.error = "stock_usage:assistant usage is malformed";
    return;
  }
  const input = addSafeInteger(evidence.input, usage.input);
  const output = addSafeInteger(evidence.output, usage.output);
  const totalCost = usage.cost.total;
  if (
    input === undefined || output === undefined ||
    !isFiniteNonnegative(totalCost) ||
    !isFiniteNonnegative(usage.cost.input) ||
    !isFiniteNonnegative(usage.cost.output) ||
    !isFiniteNonnegative(usage.cost.cacheRead) ||
    !isFiniteNonnegative(usage.cost.cacheWrite)
  ) {
    evidence.error = "stock_usage:assistant usage is malformed";
    return;
  }
  if (typeof message.provider !== "string" || typeof message.model !== "string") {
    evidence.error = "stock_model_evidence:assistant model is missing";
    return;
  }
  const actualRoute = `${message.provider}/${message.model}`;
  if (actualRoute !== expectedRoute) {
    evidence.error = "stock_model_evidence:assistant model does not match admission";
    return;
  }
  if (!Array.isArray(message.content)) {
    evidence.error = "stock_output:assistant content is malformed";
    return;
  }
  const text = message.content
    .filter((part): part is Record<string, unknown> => isPlainRecord(part) && part.type === "text")
    .map((part) => part.text)
    .filter((part): part is string => typeof part === "string")
    .join("");
  if (Buffer.byteLength(text, "utf8") > TEAM_LIMITS.outputBytes) {
    evidence.error = "stock_output:assistant text exceeds the output bound";
    return;
  }
  evidence.input = input;
  evidence.output = output;
  evidence.costUsd += totalCost;
  if (!Number.isFinite(evidence.costUsd) || evidence.costUsd < 0) {
    evidence.error = "stock_usage:assistant cost is malformed";
    return;
  }
  evidence.lastText = text;
  evidence.modelRoute = actualRoute;
  evidence.stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
  if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
    evidence.error = `stock_child:${boundedError(message.errorMessage)}`;
  }
}

function failure(error: string, evidence?: UsageEvidence): MemberResult {
  return {
    ok: false,
    text: "",
    model: evidence?.modelRoute ?? null,
    usage: {
      input: evidence?.input ?? 0,
      output: evidence?.output ?? 0,
      costUsd: evidence === undefined ? null : evidence.costUsd,
    },
    error,
  };
}

function assertAdmission(
  input: MemberRunInput,
  owner: symbol,
): AdmissionToken {
  const admission = input.admission;
  const token = admission.token as Partial<AdmissionToken> | null;
  if (
    token === null || typeof token !== "object" || token.owner !== owner ||
    token.memberId !== input.member.id || token.memberId !== admission.memberId ||
    token.route !== input.member.route || token.route !== admission.effectiveRoute ||
    token.modelRoute !== admission.effectiveModel ||
    token.maxCostUsd !== input.maxCostUsd || token.maxCostUsd !== admission.maxCostUsd ||
    token.timeoutMs !== input.timeoutMs || token.timeoutMs !== admission.timeoutMs ||
    !sameStrings(admission.effectiveCapabilities, token.capabilities ?? []) ||
    !sameStrings(admission.effectiveCapabilities, input.member.capabilities) ||
    !sameStrings(admission.effectiveTools, token.tools ?? []) ||
    !sameStrings(admission.effectiveTools, input.member.tools) ||
    token.model === undefined
  ) {
    throw new Error("stock_admission:run input does not match its host admission");
  }
  return token as AdmissionToken;
}

function disposeOnce(record: TrackedExecution): void {
  if (record.disposed || record.session === undefined) return;
  record.disposed = true;
  try {
    record.session.dispose();
  } catch {
    // Containment and result settlement stay bounded even if SDK cleanup reports failure.
  }
}

function abortOnce(record: TrackedExecution): Promise<void> {
  if (record.abortPromise !== undefined) return record.abortPromise;
  if (record.session === undefined) return Promise.resolve();
  const session = record.session;
  record.abortPromise = Promise.resolve()
    .then(() => session.abort())
    .catch(() => undefined);
  return record.abortPromise;
}

function waitBounded(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, TEAM_LIMITS.containmentTimeoutMs);
    signal.addEventListener("abort", finish, { once: true });
    promise.then(finish, finish);
  });
}

export function createStockPiHost(input: StockPiHostOptions = {}): TeamHost {
  if (
    input.maxTimeoutMs !== undefined &&
    (
      !Number.isInteger(input.maxTimeoutMs) ||
      input.maxTimeoutMs < 1 ||
      input.maxTimeoutMs > TEAM_LIMITS.timeoutMs
    )
  ) {
    throw new Error("stock_timeout_ceiling:maxTimeoutMs must be an integer from 1 to 300000");
  }

  const explicitSdk = input.sdk;
  const loadSdk = async (): Promise<StockPiSdk> => {
    if (explicitSdk !== undefined) return explicitSdk;
    const packageName: string = "@earendil-works/pi-coding-agent";
    return await import(packageName) as StockPiSdk;
  };
  const timeoutCeiling = input.maxTimeoutMs;
  const owner = Symbol("stock-pi-host");
  const tracked = new WeakMap<object, TrackedExecution>();

  const host: TeamHost = {
    id: "stock-pi",

    async capabilities() {
      return {
        capabilities: ["repo.read"],
        tools: [...READ_ONLY_TOOLS],
        maxConcurrency: 1,
        supportsCancellation: true,
      };
    },

    async preflightMember(preflight, context) {
      const authorityError = validReadOnlyMember(preflight.member);
      if (authorityError !== undefined) {
        return blocked(preflight.member.id, preflight.maxCostUsd, authorityError);
      }
      const selected = activeModel(context);
      if (selected === undefined) {
        return blocked(
          preflight.member.id,
          preflight.maxCostUsd,
          "stock_model:an active Pi model is required",
        );
      }
      const affordable = affordableModel(selected, preflight.maxCostUsd);
      if ("reason" in affordable) {
        return blocked(preflight.member.id, preflight.maxCostUsd, affordable.reason);
      }
      const timeoutMs = timeoutCeiling === undefined
        ? preflight.timeoutMs
        : Math.min(preflight.timeoutMs, timeoutCeiling);
      const token: AdmissionToken = Object.freeze({
        owner,
        memberId: preflight.member.id,
        route: preflight.member.route,
        modelRoute: affordable.route,
        model: affordable.model,
        capabilities: Object.freeze([...preflight.member.capabilities]),
        tools: Object.freeze([...preflight.member.tools]),
        maxCostUsd: preflight.maxCostUsd,
        timeoutMs,
      });
      return {
        ok: true,
        memberId: preflight.member.id,
        effectiveRoute: preflight.member.route,
        effectiveModel: affordable.route,
        effectiveCapabilities: [...preflight.member.capabilities],
        effectiveTools: [...preflight.member.tools],
        maxCostUsd: preflight.maxCostUsd,
        timeoutMs,
        token,
      } satisfies AdmittedMember;
    },

    runMember(runInput, context, signal): MemberExecution {
      const handle = Object.freeze({});
      const record: TrackedExecution = {
        runId: runInput.runId,
        memberId: runInput.member.id,
        handle,
        contained: false,
        disposed: false,
        finished: false,
      };
      tracked.set(handle, record);

      const result = (async (): Promise<MemberResult> => {
        let removeAbortListener: (() => void) | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: (() => void) | undefined;
        let evidence: UsageEvidence | undefined;
        try {
          const token = assertAdmission(runInput, owner);
          const prompt = serializePrompt(runInput);
          const requestAbort = (reason: "aborted" | "timeout") => {
            if (record.abortReason === undefined) record.abortReason = reason;
            void abortOnce(record);
          };
          const onAbort = () => requestAbort("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          if (signal.aborted) requestAbort("aborted");
          timeout = setTimeout(() => requestAbort("timeout"), token.timeoutMs);
          if (record.abortReason !== undefined) {
            return failure(`stock_child:${record.abortReason}`);
          }

          const sdk = await loadSdk();
          if (record.abortReason !== undefined) {
            return failure(`stock_child:${record.abortReason} during setup`);
          }
          const settingsManager = sdk.SettingsManager.inMemory({}, { projectTrusted: false });
          const resourceLoader = new sdk.DefaultResourceLoader({
            cwd: context.cwd,
            agentDir: input.agentDir ?? sdk.getAgentDir(),
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
          });
          await resourceLoader.reload();
          if (record.abortReason !== undefined) {
            return failure(`stock_child:${record.abortReason} during setup`);
          }

          const sessionManager = sdk.SessionManager.inMemory(context.cwd);
          const created = await sdk.createAgentSession({
            cwd: context.cwd,
            model: token.model,
            resourceLoader,
            sessionManager,
            settingsManager,
            tools: [...token.tools],
          });
          record.session = created.session;
          if (record.abortReason !== undefined) {
            await abortOnce(record);
            return failure(`stock_child:${record.abortReason} during setup`);
          }

          evidence = {
            input: 0,
            output: 0,
            costUsd: 0,
            lastText: "",
            modelRoute: null,
            stopReason: null,
          };
          unsubscribe = created.session.subscribe((event) => {
            if (event.type === "message_end") {
              observeAssistant(evidence!, event.message, token.modelRoute);
            }
          });

          await created.session.prompt(prompt, { expandPromptTemplates: false });
          if (record.abortReason !== undefined) {
            return failure(`stock_child:${record.abortReason}`, evidence);
          }
          if (evidence.error !== undefined) return failure(evidence.error, evidence);
          if (evidence.modelRoute === null) {
            return failure("stock_output:no final assistant evidence", evidence);
          }
          if (evidence.stopReason === "error" || evidence.stopReason === "aborted") {
            return failure(`stock_child:${evidence.stopReason}`, evidence);
          }
          if (evidence.costUsd > token.maxCostUsd) {
            return failure("stock_budget:observed usage exceeds admission", evidence);
          }
          return {
            ok: true,
            text: evidence.lastText,
            model: evidence.modelRoute,
            usage: {
              input: evidence.input,
              output: evidence.output,
              costUsd: evidence.costUsd,
            },
          };
        } catch (error) {
          return failure(`stock_child:${boundedError(error)}`, evidence);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          removeAbortListener?.();
          unsubscribe?.();
          record.finished = true;
          disposeOnce(record);
        }
      })();

      return { runId: runInput.runId, memberId: runInput.member.id, handle, result };
    },

    async containMember(containment: MemberContainmentInput, _context, signal) {
      const record = containment.handle !== null && typeof containment.handle === "object"
        ? tracked.get(containment.handle as object)
        : undefined;
      if (
        record === undefined ||
        record.handle !== containment.handle ||
        record.runId !== containment.runId ||
        record.memberId !== containment.memberId
      ) {
        throw new Error("stock_containment:execution identity does not match a live child");
      }
      if (record.finished) return;
      if (!record.contained) {
        record.contained = true;
        record.abortReason = "contained";
      }
      if (record.session !== undefined) {
        await waitBounded(abortOnce(record), signal);
        disposeOnce(record);
      }
    },
  };

  return host;
}
