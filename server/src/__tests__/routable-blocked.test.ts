import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
  sameUnblockDescriptor,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
  action?: string;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: { owner: { agentId }, action: input.action ?? "Review the finding" } as const,
    blockedTransitionAt: input.transitionAt === undefined
      ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
      : input.transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      markNotified,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });

  it("re-notifies the owner when the action is edited while the issue stays blocked", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T19:00:00.000Z");
    const issue = blockedIssue({ notifiedAt: new Date("2026-07-23T18:30:00.000Z"), action: "Wait for THA-9" });

    await expect(deliverAgentUnblockNotification({
      issue,
      previousDescriptor: { owner: { agentId }, action: "Wait for THA-8" },
      wakeup,
      markNotified,
      now: () => now,
    })).resolves.toBe(true);

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      payload: { issueId: issue.id, action: "Wait for THA-9" },
    });
    // A second notification for one transition needs its own key, or the wake is deduplicated.
    const key = wakeup.mock.calls[0]?.[1].idempotencyKey as string;
    expect(key).toContain(`issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`);
    expect(key).not.toBe(`issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`);
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("stays silent when the same instruction is written again after delivery", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const issue = blockedIssue({ notifiedAt: new Date("2026-07-23T18:30:00.000Z") });

    await expect(deliverAgentUnblockNotification({
      issue,
      previousDescriptor: { owner: { agentId }, action: "Review the finding" },
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("notifies for a descriptor first written after the park, when the owner was never told", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const issue = blockedIssue({ notifiedAt: null });

    await expect(deliverAgentUnblockNotification({
      issue,
      previousDescriptor: null,
      wakeup,
      markNotified,
    })).resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
    }));
  });

  it("treats a changed owner as a changed instruction", async () => {
    expect(sameUnblockDescriptor(
      { owner: { agentId }, action: "Review the finding" },
      { owner: { agentId }, action: "Review the finding" },
    )).toBe(true);
    expect(sameUnblockDescriptor(
      { owner: { agentId }, action: "Review the finding" },
      { owner: { agentId }, action: "Review the finding again" },
    )).toBe(false);
    expect(sameUnblockDescriptor(
      { owner: { agentId }, action: "Review the finding" },
      { owner: { agentId: "00000000-0000-4000-8000-000000000003" }, action: "Review the finding" },
    )).toBe(false);
    expect(sameUnblockDescriptor(null, { owner: "board", action: "Decide" })).toBe(false);
    expect(sameUnblockDescriptor(null, null)).toBe(true);
  });
});
