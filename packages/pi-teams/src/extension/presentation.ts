import type {
  CompiledTeam,
  MemberView,
  PublicAdmission,
  TeamRunView,
  TeamSummary,
} from "../core/types.ts";

const TERMINAL_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const ERROR_CODE = /^([a-z][a-z0-9_]{0,63}):/;

function unicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0)!;
  if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  const value = codePoint - 0x10000;
  const high = 0xd800 + (value >> 10);
  const low = 0xdc00 + (value & 0x3ff);
  return `\\u${high.toString(16)}\\u${low.toString(16)}`;
}

function scalar(value: string | number | boolean | null): string {
  return JSON.stringify(value).replace(TERMINAL_CONTROL, unicodeEscape);
}

function stringArray(values: readonly string[]): string {
  return `[${values.map((value) => scalar(value)).join(",")}]`;
}

function safeErrorCode(error: string): string {
  return ERROR_CODE.exec(error)?.[1] ?? "details_withheld";
}

function formatLimits(
  limits: { maxConcurrency: number; maxCostUsd: number; timeoutMs: number; maxMembers: number },
  effective: boolean,
): string[] {
  return [
    `${effective ? "Effective max concurrency" : "Max concurrency"}: ${scalar(limits.maxConcurrency)}`,
    `Maximum cost USD: ${scalar(limits.maxCostUsd)}`,
    `Run timeout ms: ${scalar(limits.timeoutMs)}`,
    `Max members: ${scalar(limits.maxMembers)}`,
  ];
}

function formatAdmission(admission: PublicAdmission): string[] {
  const lines = [
    `Member: ${scalar(admission.memberId)}`,
    `Admission: ${scalar(admission.ok ? "admitted" : "blocked")}`,
    `Effective route: ${scalar(admission.effectiveRoute)}`,
    `Effective model: ${scalar(admission.effectiveModel)}`,
    `Capabilities: ${stringArray(admission.effectiveCapabilities)}`,
    `Tools: ${stringArray(admission.effectiveTools)}`,
    `Maximum member cost USD: ${scalar(admission.maxCostUsd)}`,
  ];
  if (admission.ok) lines.push(`Timeout ms: ${scalar(admission.timeoutMs)}`);
  else lines.push(`Reason code: ${scalar(safeErrorCode(admission.reason))}`);
  return lines;
}

export function formatTeamList(teams: readonly TeamSummary[]): string {
  if (teams.length === 0) return "Teams: none";
  return teams.map((team) => [
    `Team: ${scalar(team.ref)}`,
    `Description: ${scalar(team.description)}`,
    `Members: ${scalar(team.members)}`,
    ...formatLimits(team.limits, false),
  ].join("\n")).join("\n\n");
}

export function formatTeamInspect(team: CompiledTeam): string {
  const lines = [
    `Team: ${scalar(team.ref)}`,
    `Source: ${scalar(team.source)}`,
    `Description: ${scalar(team.definition.metadata.description)}`,
    `Manifest digest: ${scalar(team.manifestDigest)}`,
    `Plan digest: ${scalar(team.planDigest)}`,
    `Topological order: ${stringArray(team.topologicalOrder)}`,
    ...formatLimits(team.definition.spec.limits, false),
  ];
  for (const member of team.definition.spec.members) {
    lines.push(
      "",
      `Member: ${scalar(member.id)}`,
      `Route: ${scalar(member.route)}`,
      `Capabilities: ${stringArray(member.capabilities)}`,
      `Tools: ${stringArray(member.tools)}`,
      `Needs: ${stringArray(member.needs)}`,
      `Instructions: ${scalar(member.instructions)}`,
    );
  }
  return lines.join("\n");
}

export function formatTeamRun(run: TeamRunView): string {
  const lines = [
    `Team: ${scalar(run.teamRef)}`,
    `Run ID: ${scalar(run.runId)}`,
    `Objective: ${scalar(run.objective)}`,
    `Status: ${scalar(run.status)}`,
  ];
  if (run.manifestDigest !== undefined) lines.push(`Manifest digest: ${scalar(run.manifestDigest)}`);
  if (run.planDigest !== undefined) lines.push(`Plan digest: ${scalar(run.planDigest)}`);
  if (run.policyDigest !== undefined) lines.push(`Policy digest: ${scalar(run.policyDigest)}`);
  if (run.limits !== undefined) lines.push(...formatLimits(run.limits, true));

  for (const admission of run.admissions) {
    lines.push("", ...formatAdmission(admission));
  }
  const members = Object.values(run.members);
  if (members.length > 0) {
    lines.push("");
    for (const member of members) {
      lines.push(`Member status: ${scalar(member.id)} ${scalar(member.status)}`);
      if (member.error !== undefined) {
        lines.push(`Member error code: ${scalar(safeErrorCode(member.error))}`);
      }
    }
  }
  lines.push(
    `Usage input: ${scalar(run.usage.input)}`,
    `Usage output: ${scalar(run.usage.output)}`,
    `Usage cost USD: ${scalar(run.usage.costUsd)}`,
  );
  if (run.approvalBinding !== undefined) {
    const binding = run.approvalBinding;
    lines.push(
      "",
      `Approval run ID: ${scalar(binding.runId)}`,
      `Approval manifest digest: ${scalar(binding.manifestDigest)}`,
      `Approval plan digest: ${scalar(binding.planDigest)}`,
      `Approval policy digest: ${scalar(binding.policyDigest)}`,
      `Requested action: ${scalar(binding.requestedAction)}`,
    );
  }
  return lines.join("\n");
}

export function formatMemberView(view: MemberView): string {
  const lines = [
    formatTeamRun(view.run),
    "",
    `Selected member: ${scalar(view.member.id)}`,
    `Selected member status: ${scalar(view.member.status)}`,
    `Result ok: ${scalar(view.result.ok)}`,
    `Result model: ${scalar(view.result.model)}`,
    `Result input: ${scalar(view.result.usage.input)}`,
    `Result output: ${scalar(view.result.usage.output)}`,
    `Result cost USD: ${scalar(view.result.usage.costUsd)}`,
  ];
  if (view.result.error !== undefined) {
    lines.push(`Result error code: ${scalar(safeErrorCode(view.result.error))}`);
  }
  lines.push(`Text: ${scalar(view.text)}`);
  return lines.join("\n");
}
