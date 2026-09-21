import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

type RoutableBlockedIssue = {
  id: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

function ownerKey(descriptor: IssueUnblockDescriptor): string {
  const owner = descriptor.owner;
  if (owner === "board") return "board";
  if ("agentId" in owner) return `agent:${owner.agentId}`;
  return `user:${owner.userId}`;
}

/**
 * Two descriptors are the same instruction when they name the same owner and the same action.
 * The action is what the owner is being asked to do, so an edit to it is a new instruction even
 * though the issue never left `blocked`.
 */
export function sameUnblockDescriptor(
  a: IssueUnblockDescriptor | null,
  b: IssueUnblockDescriptor | null,
): boolean {
  if (!a || !b) return !a && !b;
  return ownerKey(a) === ownerKey(b) && a.action === b.action;
}

/**
 * A stable short key for one revision of a descriptor. It exists so that a re-notification after an
 * edit gets its own wake idempotency key: the key would otherwise be identical to the first
 * notification for the same `blockedTransitionAt`, and the wake would be silently deduplicated.
 */
export function unblockDescriptorRevision(descriptor: IssueUnblockDescriptor): string {
  const text = `${ownerKey(descriptor)}|${descriptor.action}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  /**
   * The descriptor as it stood before this update, or `null` when the issue had none.
   * Omit the field entirely when the caller does not track descriptor edits; an omitted
   * `previousDescriptor` is treated as "unchanged" so existing callers keep their behaviour.
   */
  previousDescriptor?: IssueUnblockDescriptor | null;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string };
    contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor) {
    return false;
  }

  // An issue that is already blocked can still be handed a new instruction: the descriptor is
  // edited while the status stays `blocked`, and the transition-time notification above never runs
  // again. Treat the edit as the trigger, and keep "no new instruction" deduplicated as before.
  const descriptorChanged =
    input.previousDescriptor === undefined
      ? false
      : !sameUnblockDescriptor(input.previousDescriptor, issue.unblockDescriptor);
  const alreadyNotified = Boolean(issue.blockedOwnerNotifiedAt);
  if (alreadyNotified && !descriptorChanged) return false;

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  const transitionKey = `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`;
  await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: alreadyNotified
      ? `${transitionKey}:${unblockDescriptorRevision(issue.unblockDescriptor)}`
      : transitionKey,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}
