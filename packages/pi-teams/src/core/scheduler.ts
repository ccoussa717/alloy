import type {
  CompiledTeam,
  ScheduleState,
  TeamMemberStatus,
} from "./types.ts";

type ScheduleMember = ScheduleState["members"][string];

function schedulerError(action: string, message: string): never {
  throw new TypeError(`scheduler_${action}:${message}`);
}

function scheduleMember(state: ScheduleState, memberId: string): ScheduleMember {
  const member = state.members[memberId];
  if (member === undefined) schedulerError("member", `unknown member ${memberId}`);
  return member;
}

function dependenciesSucceeded(state: ScheduleState, memberId: string): boolean {
  const member = state.team.definition.spec.members.find((candidate) => candidate.id === memberId);
  if (member === undefined) schedulerError("member", `unknown compiled member ${memberId}`);
  return member.needs.every((dependencyId) =>
    scheduleMember(state, dependencyId).status === "succeeded"
  );
}

function withStatus(
  state: ScheduleState,
  memberId: string,
  status: TeamMemberStatus,
): ScheduleState {
  return {
    ...state,
    members: {
      ...state.members,
      [memberId]: { ...state.members[memberId], status },
    },
  };
}

function requireRunning(
  state: ScheduleState,
  memberId: string,
  action: "succeed" | "fail",
): void {
  const status = scheduleMember(state, memberId).status;
  if (status !== "running") {
    schedulerError(action, `${memberId} cannot transition from ${status}`);
  }
}

export function createSchedule(team: CompiledTeam): ScheduleState {
  const members: ScheduleState["members"] = {};
  for (const memberId of team.topologicalOrder) {
    const member = team.definition.spec.members.find((candidate) => candidate.id === memberId);
    if (member === undefined) schedulerError("member", `unknown compiled member ${memberId}`);
    members[memberId] = {
      id: memberId,
      status: member.needs.length === 0 ? "ready" : "pending",
    };
  }
  return { team, cancelling: false, members };
}

export function readyMembers(state: ScheduleState): string[] {
  if (state.cancelling) return [];

  let running = 0;
  for (const memberId of state.team.topologicalOrder) {
    if (scheduleMember(state, memberId).status === "running") running += 1;
  }
  const available = state.team.definition.spec.limits.maxConcurrency - running;
  if (available <= 0) return [];

  const ready: string[] = [];
  for (const memberId of state.team.topologicalOrder) {
    if (
      scheduleMember(state, memberId).status === "ready"
      && dependenciesSucceeded(state, memberId)
    ) {
      ready.push(memberId);
      if (ready.length === available) break;
    }
  }
  return ready;
}

export function markStarted(state: ScheduleState, memberId: string): ScheduleState {
  const member = scheduleMember(state, memberId);
  if (state.cancelling || member.status !== "ready" || !readyMembers(state).includes(memberId)) {
    schedulerError("start", `${memberId} cannot start from ${member.status}`);
  }
  return withStatus(state, memberId, "running");
}

export function markSucceeded(state: ScheduleState, memberId: string): ScheduleState {
  requireRunning(state, memberId, "succeed");
  let next = withStatus(state, memberId, "succeeded");
  if (next.cancelling) return next;

  let members = next.members;
  for (const candidateId of next.team.topologicalOrder) {
    const candidate = members[candidateId];
    if (candidate?.status !== "pending") continue;
    if (!dependenciesSucceeded({ ...next, members }, candidateId)) continue;
    if (members === next.members) members = { ...members };
    members[candidateId] = { ...candidate, status: "ready" };
  }
  if (members !== next.members) next = { ...next, members };
  return next;
}

export function markFailed(state: ScheduleState, memberId: string): ScheduleState {
  requireRunning(state, memberId, "fail");
  return withStatus(state, memberId, "failed");
}

export function requestCancellation(state: ScheduleState): ScheduleState {
  if (state.cancelling) schedulerError("cancel", "cancellation already requested");

  let members = state.members;
  for (const memberId of state.team.topologicalOrder) {
    const member = scheduleMember(state, memberId);
    if (member.status !== "pending" && member.status !== "ready") continue;
    if (members === state.members) members = { ...members };
    members[memberId] = { ...member, status: "cancelled" };
  }
  return { ...state, cancelling: true, members };
}
