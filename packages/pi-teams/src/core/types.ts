export type TeamNamespace = "builtin" | "user" | "project";
export type TeamRef = `${TeamNamespace}/${string}`;
export type TeamRoute = "research" | "review" | "planning";
export type TeamCapability = "repo.read";
export type TeamToolName = "read" | "grep" | "find" | "ls";
export type Actor =
  | { kind: "human"; id: string }
  | { kind: "model"; id: string }
  | { kind: "system"; id: string };

export interface TeamMember {
  id: string;
  route: TeamRoute;
  capabilities: TeamCapability[];
  tools: TeamToolName[];
  needs: string[];
  instructions: string;
}

export interface TeamLimits {
  maxConcurrency: number;
  maxCostUsd: number;
  timeoutMs: number;
  maxMembers: number;
}

export interface TeamDefinition {
  apiVersion: "pi.dev/teams/v1alpha1";
  kind: "Team";
  metadata: { name: string; description: string };
  spec: { limits: TeamLimits; members: TeamMember[] };
}

export interface CompiledTeam {
  ref: TeamRef;
  source: TeamNamespace;
  definition: TeamDefinition;
  topologicalOrder: string[];
  manifestDigest: string;
  planDigest: string;
}

export interface HostCapabilities {
  capabilities: TeamCapability[];
  tools: TeamToolName[];
  maxConcurrency: number;
  supportsCancellation: boolean;
}

export interface TeamRunContext {
  cwd: string;
  projectId: string;
  projectTrusted: boolean;
  source: "command" | "tool";
  signal?: AbortSignal;
  runtime: unknown;
}

export type Admission =
  | {
      ok: true;
      memberId: string;
      effectiveRoute: string;
      effectiveModel: string | null;
      effectiveCapabilities: TeamCapability[];
      effectiveTools: TeamToolName[];
      maxCostUsd: number;
      timeoutMs: number;
      token: unknown;
    }
  | {
      ok: false;
      memberId: string;
      effectiveRoute: null;
      effectiveModel: null;
      effectiveCapabilities: [];
      effectiveTools: [];
      maxCostUsd: number;
      reason: string;
      token?: never;
    };

export type AdmittedMember = Extract<Admission, { ok: true }>;
export type PublicAdmission = Admission extends infer T
  ? T extends Admission ? Omit<T, "token"> : never
  : never;

export interface MemberPreflightInput {
  member: TeamMember;
  maxCostUsd: number;
  timeoutMs: number;
}

export interface MemberRunInput {
  runId: string;
  objective: string;
  member: TeamMember;
  dependencies: Array<{
    memberId: string;
    artifact: ArtifactRef;
    text: string;
  }>;
  admission: AdmittedMember;
  maxCostUsd: number;
  timeoutMs: number;
}

export interface MemberResult {
  ok: boolean;
  text: string;
  model: string | null;
  usage: { input: number; output: number; costUsd: number | null };
  error?: string;
}

export interface MemberExecution {
  runId: string;
  memberId: string;
  handle: unknown;
  result: Promise<MemberResult>;
}

export interface MemberContainmentInput {
  runId: string;
  memberId: string;
  handle: unknown;
}

export interface TeamHost {
  readonly id: "stock-pi" | "alloy";
  capabilities(context: TeamRunContext): Promise<HostCapabilities>;
  preflightMember(
    input: MemberPreflightInput,
    context: TeamRunContext,
  ): Promise<Admission>;
  runMember(
    input: MemberRunInput,
    context: TeamRunContext,
    signal: AbortSignal,
  ): MemberExecution;
  containMember(
    input: MemberContainmentInput,
    context: TeamRunContext,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface EventWriter {
  append(draft: EventDraft): Promise<TeamEvent>;
  close(): Promise<void>;
}

export interface EventStore {
  createRun(input: RunSnapshotInput): Promise<EventWriter>;
  read(projectId: string, runId: string): Promise<TeamEvent[]>;
  list(projectId: string): Promise<string[]>;
}

export interface ArtifactRef {
  memberId: string;
  outputPath: string;
  resultPath: string;
  outputBytes: number;
  outputSha256: string;
  resultBytes: number;
  resultSha256: string;
}

export interface ArtifactStore {
  writeMember(
    projectId: string,
    runId: string,
    memberId: string,
    result: MemberResult,
  ): Promise<ArtifactRef>;
  readVerified(projectId: string, runId: string, ref: ArtifactRef): Promise<{
    text: string;
    result: MemberResult;
  }>;
}

export type TeamEventType =
  | "run.requested" | "manifest.snapshotted" | "policy.admitted"
  | "policy.blocked" | "run.awaiting_approval" | "approval.granted"
  | "run.started" | "member.ready" | "member.started"
  | "member.artifact_recorded" | "member.succeeded" | "member.failed"
  | "budget.observed" | "cancel.requested" | "member.cancelled"
  | "run.completed" | "run.failed" | "run.blocked" | "run.cancelled";

export interface EventDraft {
  type: TeamEventType;
  actor: Actor;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface RunSnapshotInput {
  projectId: string;
  runId: string;
  manifest: TeamDefinition;
  request: {
    teamRef: TeamRef;
    objective: string;
    actor: Actor;
    requestedAt: string;
  };
}

export interface TeamSummary {
  ref: TeamRef;
  description: string;
  members: number;
  limits: TeamLimits;
}

export type TeamMemberStatus =
  | "pending" | "ready" | "running" | "succeeded" | "failed" | "cancelled";
export type TeamRunStatus =
  | "awaiting_approval" | "running" | "completed" | "failed"
  | "blocked" | "cancelled" | "incomplete";

export interface TeamMemberView {
  id: string;
  status: TeamMemberStatus;
  artifact?: ArtifactRef;
  error?: string;
}

export interface ApprovalBinding {
  runId: string;
  manifestDigest: string;
  planDigest: string;
  policyDigest: string;
  requestedAction: "execute";
}

export interface TeamEvent {
  v: 1;
  runId: string;
  seq: number;
  type: TeamEventType;
  actor: Actor;
  occurredAt: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface TeamRunView {
  projectId: string;
  runId: string;
  teamRef: TeamRef;
  objective: string;
  status: TeamRunStatus;
  manifestDigest: string;
  planDigest: string;
  policyDigest?: string;
  approvalBinding?: ApprovalBinding;
  limits: TeamLimits;
  admissions: PublicAdmission[];
  members: Record<string, TeamMemberView>;
  usage: { input: number; output: number; costUsd: number | null };
  lastEvent: TeamEvent;
}

export interface MemberView {
  run: TeamRunView;
  member: TeamMemberView;
  text: string;
  result: MemberResult;
}

export interface ScheduleState {
  team: CompiledTeam;
  cancelling: boolean;
  members: Record<string, { id: string; status: TeamMemberStatus }>;
}

export interface TeamService {
  list(context: TeamRunContext): Promise<TeamSummary[]>;
  inspect(teamRef: string, context: TeamRunContext): Promise<CompiledTeam>;
  request(input: {
    teamRef: string;
    objective: string;
    actor: Actor;
    context: TeamRunContext;
  }): Promise<TeamRunView>;
  approve(input: {
    runId: string;
    actor: Extract<Actor, { kind: "human" }>;
    binding: ApprovalBinding;
    context: TeamRunContext;
  }): Promise<TeamRunView>;
  execute(runId: string, context: TeamRunContext): Promise<TeamRunView>;
  cancel(runId: string, actor: Actor, context: TeamRunContext): Promise<TeamRunView>;
  status(runId: string | undefined, context: TeamRunContext): Promise<TeamRunView>;
  view(
    runId: string,
    memberId: string | undefined,
    context: TeamRunContext,
  ): Promise<TeamRunView | MemberView>;
}

export interface CatalogEntry {
  ref: TeamRef;
  source: TeamNamespace;
  origin: string;
  definition: TeamDefinition;
}

export interface TeamCatalog {
  list(): CatalogEntry[];
  resolve(ref: string): CatalogEntry;
}

export interface PolicyIntersectionInput {
  member: TeamMember;
  host: HostCapabilities;
  admission: Admission;
  maxCostUsd: number;
  timeoutMs: number;
}
export type PolicyDecision = Admission;

export interface TeamServiceDependencies {
  catalogFor(context: TeamRunContext): Promise<TeamCatalog>;
  eventStore: EventStore;
  artifactStore: ArtifactStore;
  host: TeamHost;
  now(): string;
  randomUUID(): string;
}

export interface FileEventStoreOptions {
  root: string;
  now?: () => string;
  randomUUID?: () => string;
  fs?: typeof import("node:fs/promises");
}

export interface FileArtifactStoreOptions {
  root: string;
  fs?: typeof import("node:fs/promises");
}
