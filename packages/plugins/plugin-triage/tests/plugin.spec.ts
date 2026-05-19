import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Company } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, {
  PLUGIN_ID,
  TRIAGE_ASSISTANT_AGENT_KEY,
  TRIAGE_MANAGED_SKILL_CANONICAL_KEYS,
  TRIAGE_MANAGED_SKILL_KEYS,
  TRIAGE_PROJECT_KEY,
} from "../src/manifest.js";
import plugin, { createTriagePlugin } from "../src/worker.js";
import { createInMemoryTriageStore } from "../src/triage.js";

const COMPANY_ID = "company-1";
const OTHER_COMPANY_ID = "company-2";

function company(id: string, name = id): Company {
  const now = new Date();
  return {
    id,
    name,
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: id === COMPANY_ID ? "PAP" : "ALT",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 25_000_000,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("Paperclip Triage scaffold", () => {
  it("declares the package manifest, UI slots, and managed resources", () => {
    expect(manifest).toMatchObject({
      id: PLUGIN_ID,
    });
    expect(manifest.database).toEqual({
      namespaceSlug: "triage",
      migrationsDir: "migrations",
      coreReadTables: ["companies", "issues"],
    });
    expect(manifest.apiRoutes).toEqual([
      expect.objectContaining({
        routeKey: "items.ingest",
        method: "POST",
        path: "/queues/:queueKey/items",
      }),
    ]);
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      "api.routes.register",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "companies.read",
      "issues.read",
      "issues.create",
      "issues.update",
      "issue.comments.read",
      "issue.comments.create",
      "agents.managed",
      "projects.managed",
      "skills.managed",
      "instance.settings.register",
      "ui.sidebar.register",
      "ui.page.register",
    ]));
    expect(manifest.ui?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "sidebar", exportName: "SidebarLink" }),
      expect.objectContaining({ type: "page", exportName: "TriagePage", routePath: "triage" }),
      expect.objectContaining({ type: "routeSidebar", exportName: "TriageRouteSidebar", routePath: "triage" }),
      expect.objectContaining({ type: "settingsPage", exportName: "SettingsPage" }),
    ]));
    expect(manifest.agents?.[0]).toEqual(expect.objectContaining({
      agentKey: TRIAGE_ASSISTANT_AGENT_KEY,
      displayName: "Triage Assistant",
      status: "paused",
      permissions: { pluginTools: [PLUGIN_ID] },
    }));
    expect(manifest.agents?.[0]?.adapterConfig?.paperclipSkillSync).toEqual({
      desiredSkills: TRIAGE_MANAGED_SKILL_CANONICAL_KEYS,
    });
    expect(manifest.projects?.[0]).toEqual(expect.objectContaining({
      projectKey: TRIAGE_PROJECT_KEY,
      displayName: "Triage",
    }));
    expect(manifest.skills?.map((skill) => skill.skillKey)).toEqual(TRIAGE_MANAGED_SKILL_KEYS);
  });

  it("declares the plugin-owned triage migration shape", () => {
    const migration = readFileSync(new URL("../migrations/001_triage_core.sql", import.meta.url), "utf8");

    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_queues");
    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_queue_states");
    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_queue_transitions");
    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_items");
    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_queue_chats");
    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_guidance_docs");
    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_guidance_doc_revisions");
    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_guidance_proposals");
    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_item_events");
    expect(migration).toContain("CREATE TABLE plugin_triage_f3b4aa721e.triage_transition_actions");
    expect(migration).toContain("REFERENCES public.companies(id)");
    expect(migration).toContain("REFERENCES public.issues(id)");
    expect(migration).toContain("CREATE UNIQUE INDEX triage_items_queue_item_key_idx");
    expect(migration).toContain("CREATE UNIQUE INDEX triage_items_queue_idempotency_key_idx");
  });

  it("reports missing managed resources before reconcile", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const health = await harness.getData<{ status: string; skills: Array<{ status: string }> }>(
      "managed-resource-health",
      { companyId: COMPANY_ID },
    );

    expect(health.status).toBe("missing");
    expect(health.skills).toHaveLength(TRIAGE_MANAGED_SKILL_KEYS.length);
    expect(health.skills.every((skill) => skill.status === "missing")).toBe(true);
  });

  it("reconciles managed project, assistant, and skills", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{
      status: string;
      agent: { status: string; agentId: string | null };
      project: { status: string; projectId: string | null };
      skills: Array<{ status: string; skillId: string | null; key: string | null }>;
    }>("reconcile-managed-resources", { companyId: COMPANY_ID });

    expect(result.status).toBe("ready");
    expect(result.agent).toEqual(expect.objectContaining({ status: "created" }));
    expect(result.agent.agentId).toBeTruthy();
    expect(result.project).toEqual(expect.objectContaining({ status: "created" }));
    expect(result.project.projectId).toBeTruthy();
    expect(result.skills).toHaveLength(TRIAGE_MANAGED_SKILL_KEYS.length);
    expect(result.skills.every((skill) => skill.status === "created")).toBe(true);
    expect(result.skills.map((skill) => skill.key)).toEqual(TRIAGE_MANAGED_SKILL_CANONICAL_KEYS);
  });
});

describe("Paperclip Triage queue and item ingest", () => {
  function createHarness() {
    const store = createInMemoryTriageStore();
    const testPlugin = createTriagePlugin({ createStore: () => store });
    const harness = createTestHarness({ manifest });
    harness.seed({ companies: [company(COMPANY_ID), company(OTHER_COMPANY_ID)] });
    return { harness, plugin: testPlugin, store };
  }

  it("creates and updates queues through worker actions", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    const created = await harness.performAction<{ queue: { queueKey: string; title: string }; created: boolean }>(
      "create-queue",
      { companyId: COMPANY_ID, queueKey: "reviews", title: "Reviews" },
    );
    expect(created).toMatchObject({
      created: true,
      queue: { queueKey: "reviews", title: "Reviews" },
    });

    await harness.performAction("update-queue", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      title: "Editorial Reviews",
    });

    await expect(harness.getData("queue", { companyId: COMPANY_ID, queueKey: "reviews" }))
      .resolves.toMatchObject({ queueKey: "reviews", title: "Editorial Reviews" });
    await expect(harness.getData("queues", { companyId: OTHER_COMPANY_ID }))
      .resolves.toEqual([]);
  });

  it("strictly rejects missing queues when requireExistingQueue is true", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    await expect(harness.performAction("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "unknown",
      title: "Should not create",
      requireExistingQueue: true,
    })).rejects.toMatchObject({
      status: 404,
      code: "queue_not_found",
    });

    await expect(harness.getData("queues", { companyId: COMPANY_ID })).resolves.toEqual([]);
  });

  it("auto-creates a queue on ingest and upserts by stable item key", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    const first = await harness.performAction<{
      createdQueue: boolean;
      createdItem: boolean;
      item: { id: string; title: string; content: string; revision: number };
      queue: { queueKey: string; activeItemCount: number };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "content-training",
      title: "Draft launch post",
      content: "# Draft",
      itemKey: "external-1",
      properties: { sourceKind: "fixture" },
    });

    expect(first).toMatchObject({
      createdQueue: true,
      createdItem: true,
      item: { title: "Draft launch post", content: "# Draft", revision: 1 },
      queue: { queueKey: "content-training", activeItemCount: 1 },
    });

    const second = await harness.performAction<{
      createdQueue: boolean;
      createdItem: boolean;
      upserted: boolean;
      item: { id: string; title: string; content: string; revision: number };
      queue: { activeItemCount: number };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "content-training",
      title: "Revised launch post",
      content: "# Revised",
      itemKey: "external-1",
    });

    expect(second).toMatchObject({
      createdQueue: false,
      createdItem: false,
      upserted: true,
      item: { id: first.item.id, title: "Revised launch post", content: "# Revised", revision: 2 },
      queue: { activeItemCount: 1 },
    });

    await expect(harness.getData("queue-items", { companyId: COMPANY_ID, queueKey: "content-training" }))
      .resolves.toHaveLength(1);
  });

  it("keeps queue keys company-scoped and validates scoped API company context", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    await harness.performAction("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "inbox",
      title: "Company one item",
      idempotencyKey: "same-upstream-request",
    });
    await harness.performAction("ingest-item", {
      companyId: OTHER_COMPANY_ID,
      queueKey: "inbox",
      title: "Company two item",
      idempotencyKey: "same-upstream-request",
    });

    await expect(harness.getData("queue-items", { companyId: COMPANY_ID, queueKey: "inbox" }))
      .resolves.toEqual([expect.objectContaining({ title: "Company one item" })]);
    await expect(harness.getData("queue-items", { companyId: OTHER_COMPANY_ID, queueKey: "inbox" }))
      .resolves.toEqual([expect.objectContaining({ title: "Company two item" })]);

    const mismatch = await testPlugin.definition.onApiRequest?.({
      routeKey: "items.ingest",
      method: "POST",
      path: "/queues/inbox/items",
      params: { queueKey: "inbox" },
      query: {},
      body: {
        companyId: OTHER_COMPANY_ID,
        title: "Wrong company",
      },
      actor: {
        actorType: "user",
        actorId: "board",
        userId: "board",
        agentId: null,
        runId: null,
      },
      companyId: COMPANY_ID,
      headers: {},
    });

    expect(mismatch).toEqual({
      status: 403,
      body: {
        error: {
          code: "company_scope_mismatch",
          message: "Request companyId does not match the resolved plugin route company",
        },
      },
    });
  });

  it("reuses one hidden queue chat and assistant session per queue while isolating other queues", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    const first = await harness.performAction<{
      item: { id: string };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      title: "Launch review",
      content: "Please review the launch copy.",
      properties: { sourceKind: "manual" },
    });
    const other = await harness.performAction<{
      item: { id: string };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "support",
      title: "Support review",
      content: "Please review the support reply.",
    });

    const firstSend = await harness.performAction<{
      chat: { id: string; hiddenIssueId: string; metadata: Record<string, unknown> };
      hiddenIssueId: string;
      session: { sessionId: string };
      runId: string;
      prompt: string;
    }>("send-assistant-message", {
      companyId: COMPANY_ID,
      itemId: first.item.id,
      message: "What should I change?",
    });

    expect(firstSend.hiddenIssueId).toBeTruthy();
    expect(firstSend.chat.hiddenIssueId).toBe(firstSend.hiddenIssueId);
    expect(firstSend.runId).toBeTruthy();
    expect(firstSend.prompt).toContain("Queue: Reviews (reviews)");
    expect(firstSend.prompt).toContain("Please review the launch copy.");
    expect(firstSend.prompt).toContain("guidance.md");
    expect(firstSend.prompt).toContain("What should I change?");

    const secondSend = await harness.performAction<{
      chat: { id: string; hiddenIssueId: string };
      hiddenIssueId: string;
      session: { sessionId: string };
    }>("send-assistant-message", {
      companyId: COMPANY_ID,
      itemId: first.item.id,
      message: "Use the same thread.",
    });
    expect(secondSend.chat.id).toBe(firstSend.chat.id);
    expect(secondSend.hiddenIssueId).toBe(firstSend.hiddenIssueId);
    expect(secondSend.session.sessionId).toBe(firstSend.session.sessionId);

    const otherSend = await harness.performAction<{
      chat: { id: string };
      hiddenIssueId: string;
    }>("send-assistant-message", {
      companyId: COMPANY_ID,
      itemId: other.item.id,
      message: "Different queue.",
    });
    expect(otherSend.chat.id).not.toBe(firstSend.chat.id);
    expect(otherSend.hiddenIssueId).not.toBe(firstSend.hiddenIssueId);
  });

  it("updates item content only when the expected revision matches", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    const ingested = await harness.performAction<{
      item: { id: string; revision: number };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      title: "Original",
      content: "Original content",
    });

    const updated = await harness.performAction<{
      item: { title: string; content: string; revision: number };
      event: { eventType: string; metadata: Record<string, unknown> };
    }>("update-item-content", {
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      expectedRevision: ingested.item.revision,
      title: "Edited",
      content: "Edited content",
    });

    expect(updated.item).toMatchObject({ title: "Edited", content: "Edited content", revision: 2 });
    expect(updated.event).toMatchObject({
      eventType: "item.content.updated",
      metadata: { previousRevision: 1, nextRevision: 2 },
    });

    await expect(harness.performAction("update-item-content", {
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      expectedRevision: 1,
      content: "Stale edit",
    })).rejects.toMatchObject({
      status: 409,
      code: "item_revision_conflict",
    });
  });

  it("supports guidance proposal generation, revision, acceptance, rejection, and manual edits", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    const ingested = await harness.performAction<{
      item: { id: string };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      title: "Review example",
      content: "Prefer concise copy.",
    });

    const manual = await harness.performAction<{
      doc: { content: string; currentRevisionId: string };
      revision: { id: string; summary: string };
    }>("manual-edit-guidance", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      content: "# Reviews Guidance\n\nStart from the user's target audience.",
      summary: "Seed guidance",
    });
    expect(manual.doc.content).toContain("target audience");
    expect(manual.doc.currentRevisionId).toBe(manual.revision.id);

    const generated = await harness.performAction<{
      proposal: { id: string; status: string; proposedContent: string };
    }>("generate-guidance-proposal", {
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      suggestedChange: "For launch copy, flag vague benefits before approving.",
      rationale: "The item exposed a repeatable approval rule.",
    });
    expect(generated.proposal.status).toBe("proposed");
    expect(generated.proposal.proposedContent).toContain("target audience");
    expect(generated.proposal.proposedContent).toContain("flag vague benefits");

    const revised = await harness.performAction<{ status: string; proposedContent: string }>(
      "revise-guidance-proposal",
      {
        companyId: COMPANY_ID,
        proposalId: generated.proposal.id,
        proposedContent: "# Reviews Guidance\n\nFlag vague benefits and ask for concrete proof.",
        rationale: "Sharper wording.",
      },
    );
    expect(revised).toMatchObject({ status: "revised" });

    const accepted = await harness.performAction<{
      proposal: { status: string; metadata: Record<string, unknown> };
      doc: { content: string; currentRevisionId: string };
      revision: { id: string };
    }>("accept-guidance-proposal", {
      companyId: COMPANY_ID,
      proposalId: generated.proposal.id,
    });
    expect(accepted.proposal.status).toBe("accepted");
    expect(accepted.proposal.metadata.acceptedRevisionId).toBe(accepted.revision.id);
    expect(accepted.doc.content).toContain("concrete proof");
    expect(accepted.doc.currentRevisionId).toBe(accepted.revision.id);

    const rejectedCandidate = await harness.performAction<{
      proposal: { id: string };
    }>("generate-guidance-proposal", {
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      proposedContent: "# Reviews Guidance\n\nToo broad.",
    });
    const rejected = await harness.performAction<{ status: string; metadata: Record<string, unknown> }>(
      "reject-guidance-proposal",
      {
        companyId: COMPANY_ID,
        proposalId: rejectedCandidate.proposal.id,
        reason: "Too broad for this queue.",
      },
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      metadata: expect.objectContaining({ rejectionReason: "Too broad for this queue." }),
    });
    await expect(harness.performAction("accept-guidance-proposal", {
      companyId: COMPANY_ID,
      proposalId: rejectedCandidate.proposal.id,
    })).rejects.toMatchObject({
      status: 409,
      code: "guidance_proposal_rejected",
    });
  });

  it("creates a linked work issue from a create_if_missing transition action and records history", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    const ingested = await harness.performAction<{
      item: { id: string };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      title: "Draft launch post",
      content: "# Draft\n\nMake this sharper.",
      properties: { sourceKind: "fixture", priority: "high" },
    });

    await harness.performAction("upsert-transition-action", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      actionKey: "create-work",
      fromStateKey: "draft",
      toStateKey: "approved",
      action: {
        type: "create_or_update_issue",
        mode: "create_if_missing",
        template: {
          title: "{{item.title}}",
          description: "{{item.content}}\n\nMetadata:\n{{item.propertiesJson}}",
          comment: "Triage item moved to {{transition.toStateKey}}.",
          priority: "high",
          status: "todo",
        },
      },
    });

    const transitioned = await harness.performAction<{
      item: { stateKey: string; linkedWorkIssueId: string | null };
      actionResults: Array<{ result: string; issueId: string | null; commentCreated: boolean }>;
    }>("transition-item", {
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      toStateKey: "approved",
    });

    expect(transitioned.item.stateKey).toBe("approved");
    expect(transitioned.item.linkedWorkIssueId).toBeTruthy();
    expect(transitioned.actionResults).toEqual([
      expect.objectContaining({ result: "created", issueId: transitioned.item.linkedWorkIssueId, commentCreated: true }),
    ]);

    const issue = await harness.ctx.issues.get(transitioned.item.linkedWorkIssueId!, COMPANY_ID);
    expect(issue).toMatchObject({
      title: "Draft launch post",
      description: expect.stringContaining("Make this sharper."),
      status: "todo",
      priority: "high",
      originId: ingested.item.id,
    });
    const comments = await harness.ctx.issues.listComments(transitioned.item.linkedWorkIssueId!, COMPANY_ID);
    expect(comments).toEqual([expect.objectContaining({ body: "Triage item moved to approved." })]);

    const events = await harness.getData<Array<{ eventType: string; metadata: Record<string, unknown> }>>(
      "item-events",
      { companyId: COMPANY_ID, itemId: ingested.item.id },
    );
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "item.transitioned",
      "transition.action.executed",
      "item.ingested.created",
    ]));
    expect(events.find((event) => event.eventType === "transition.action.executed")?.metadata)
      .toMatchObject({ actionKey: "create-work", result: "created", commentCreated: true });
  });

  it("updates an existing linked work issue from an update_existing transition action", async () => {
    const { harness, plugin: testPlugin, store } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    const issue = await harness.ctx.issues.create({
      companyId: COMPANY_ID,
      title: "Old title",
      status: "todo",
      priority: "medium",
    });
    const ingested = await harness.performAction<{
      item: { id: string };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      title: "Needs owner",
      content: "Please assign this.",
    });
    await store.updateItem({
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      linkedWorkIssueId: issue.id,
    });
    await harness.performAction("upsert-transition-action", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      actionKey: "update-work",
      fromStateKey: "draft",
      toStateKey: "approved",
      action: {
        type: "create_or_update_issue",
        mode: "update_existing",
        template: {
          title: "Updated: {{item.title}}",
          comment: "Existing work issue updated for {{transition.toStateKey}}.",
          priority: "high",
          status: "in_review",
        },
      },
    });

    const transitioned = await harness.performAction<{
      actionResults: Array<{ result: string; issueId: string | null; commentCreated: boolean }>;
    }>("transition-item", {
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      toStateKey: "approved",
    });

    expect(transitioned.actionResults).toEqual([
      expect.objectContaining({ result: "updated", issueId: issue.id, commentCreated: true }),
    ]);
    await expect(harness.ctx.issues.get(issue.id, COMPANY_ID)).resolves.toMatchObject({
      title: "Updated: Needs owner",
      status: "in_review",
      priority: "high",
    });
    await expect(harness.ctx.issues.listComments(issue.id, COMPANY_ID)).resolves.toEqual([
      expect.objectContaining({ body: "Existing work issue updated for approved." }),
    ]);
  });

  it("create_or_update creates when missing and updates the same linked issue later", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    const ingested = await harness.performAction<{
      item: { id: string };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      title: "Reusable handoff",
      content: "Create once, update later.",
    });
    await harness.performAction("upsert-transition-action", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      actionKey: "create-or-update",
      fromStateKey: "draft",
      toStateKey: "approved",
      action: {
        type: "create_or_update_issue",
        mode: "create_or_update",
        template: {
          title: "{{item.title}}",
          description: "{{item.content}}",
          status: "todo",
        },
      },
    });
    const first = await harness.performAction<{
      item: { linkedWorkIssueId: string | null };
      actionResults: Array<{ result: string; issueId: string | null }>;
    }>("transition-item", {
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      toStateKey: "approved",
    });

    await harness.performAction("upsert-transition-action", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      actionKey: "finish-work",
      fromStateKey: "approved",
      toStateKey: "done",
      action: {
        type: "create_or_update_issue",
        mode: "create_or_update",
        template: {
          title: "Finished: {{item.title}}",
          comment: "Completed from triage.",
          status: "done",
        },
      },
    });
    const second = await harness.performAction<{
      item: { linkedWorkIssueId: string | null };
      actionResults: Array<{ result: string; issueId: string | null }>;
    }>("transition-item", {
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      toStateKey: "done",
    });

    expect(first.actionResults).toEqual([expect.objectContaining({ result: "created" })]);
    expect(second.actionResults).toEqual([
      expect.objectContaining({ result: "updated", issueId: first.item.linkedWorkIssueId }),
    ]);
    expect(second.item.linkedWorkIssueId).toBe(first.item.linkedWorkIssueId);
    await expect(harness.ctx.issues.get(first.item.linkedWorkIssueId!, COMPANY_ID)).resolves.toMatchObject({
      title: "Finished: Reusable handoff",
      status: "done",
    });
  });

  it("rejects unsupported transition action types and invalid issue templates", async () => {
    const { harness, plugin: testPlugin } = createHarness();
    await testPlugin.definition.setup(harness.ctx);
    await harness.performAction("create-queue", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      title: "Reviews",
    });

    await expect(harness.performAction("upsert-transition-action", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      actionKey: "external-call",
      fromStateKey: "draft",
      toStateKey: "approved",
      action: {
        type: "webhook",
        mode: "create_or_update",
        template: { title: "Nope" },
      },
    })).rejects.toMatchObject({
      status: 422,
      code: "unsupported_transition_action",
    });

    await expect(harness.performAction("upsert-transition-action", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      actionKey: "bad-template",
      fromStateKey: "draft",
      toStateKey: "approved",
      action: {
        type: "create_or_update_issue",
        mode: "create_or_update",
        template: { title: "{{item.title}}", externalUrl: "https://example.test" },
      },
    })).rejects.toMatchObject({
      status: 422,
      code: "invalid_transition_action_template",
    });
  });

  it("denies transition actions linked to a work issue from another company", async () => {
    const { harness, plugin: testPlugin, store } = createHarness();
    await testPlugin.definition.setup(harness.ctx);

    const otherIssue = await harness.ctx.issues.create({
      companyId: OTHER_COMPANY_ID,
      title: "Other company issue",
    });
    const ingested = await harness.performAction<{
      item: { id: string };
    }>("ingest-item", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      title: "Cross-company link",
    });
    await store.updateItem({
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      linkedWorkIssueId: otherIssue.id,
    });
    await harness.performAction("upsert-transition-action", {
      companyId: COMPANY_ID,
      queueKey: "reviews",
      actionKey: "update-work",
      fromStateKey: "draft",
      toStateKey: "approved",
      action: {
        type: "create_or_update_issue",
        mode: "update_existing",
        template: {
          title: "Should not update",
        },
      },
    });

    await expect(harness.performAction("transition-item", {
      companyId: COMPANY_ID,
      itemId: ingested.item.id,
      toStateKey: "approved",
    })).rejects.toMatchObject({
      status: 403,
      code: "linked_issue_cross_company_denied",
    });

    await expect(harness.getData("queue-item", { companyId: COMPANY_ID, itemId: ingested.item.id }))
      .resolves.toMatchObject({ stateKey: "draft" });
    await expect(harness.ctx.issues.get(otherIssue.id, OTHER_COMPANY_ID)).resolves.toMatchObject({
      title: "Other company issue",
    });
  });
});
