// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  NODE_STATE_LABELS,
  type TreeGraph,
  type TreeNode,
  type TreeProject,
} from "./src/model";

const app = await loadPluginApp(() => import("./app"));
/** Mirrors AUTOSAVE_DELAY_MS, for waits that have to straddle it. */
const AUTOSAVE_DEBOUNCE_MS = 700;
const panel = app.navPanels[0]!;
const header = { component: panel.headerContent! };
const breadcrumb = { component: panel.experimental_headerBreadcrumb! };

afterEach(() => {
  cleanup();
});

const project: TreeProject = {
  id: "trp_1",
  name: "Build auth",
  directory: "/Users/me/Trees/build_auth",
  nodeCount: 2,
  readyCount: 1,
  staleCount: 0,
  createdAt: 1,
  updatedAt: 2,
};

async function pressCard(
  slot: ReturnType<typeof renderSlot>,
  title: string,
): Promise<void> {
  const label = await slot.findByRole("button", { name: title });
  const card = label.parentElement;
  const surface = card?.parentElement;
  if (
    card === null ||
    card === undefined ||
    surface === null ||
    surface === undefined
  ) {
    throw new Error(`no graph card for ${title}`);
  }
  fireEvent.pointerDown(card, { pointerId: 1, button: 0 });
  fireEvent.pointerUp(surface, { pointerId: 1 });
}

function node(overrides: Partial<TreeNode>): TreeNode {
  return {
    id: "trn_1",
    projectId: project.id,
    title: "Write auth requirements",
    kind: "markdown",
    state: "ready",
    artifactFile: "01_write_auth_requirements.md",
    artifactPath: `${project.directory}/01_write_auth_requirements.md`,
    summary: "",
    summaryStatus: "idle",
    summaryProblem: null,
    instruction: "",
    contextMode: "all_parents",
    handoff: "summary",
    baseBranch: null,
    customBrief: "",
    contextIncludes: [],
    workspace: { kind: "tree" },
    threadId: null,
    dependsOn: [],
    x: 0,
    y: 0,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

const requirements = node({});
const specs = node({
  id: "trn_2",
  title: "Generate API design specs",
  kind: "agent",
  state: "blocked",
  artifactFile: "02_generate_api_design_specs.md",
  artifactPath: `${project.directory}/02_generate_api_design_specs.md`,
  instruction: "Generate the OpenAPI schema.",
  dependsOn: [requirements.id],
  x: 0,
  y: 132,
});

const graph: TreeGraph = { project, nodes: [requirements, specs] };

function baseRpc(overrides: Record<string, (input: never) => unknown> = {}) {
  return {
    projects_list: () => ({ projects: [project] }),
    graph_get: () => graph,
    ready_list: () => ({ entries: [{ project, node: requirements }] }),
    workspace_options: () => ({
      projects: [{ id: "proj_api", name: "API" }],
      environments: [
        {
          id: "env_shared",
          projectId: "proj_api",
          label: "API · feature/push (worktree)",
        },
      ],
    }),
    artifact_read: () => ({
      content: "# Write auth requirements\n\n",
      sha256: "abc",
      problem: null,
    }),
    context_preview: () => ({
      prompt: "# Generate API design specs\n\n## Task\n\nGenerate it.",
      sourceTitles: ["Write auth requirements"],
    }),
    ...overrides,
  };
}

describe("Trees panel", () => {
  it("registers one full-page panel in the sidebar", () => {
    expect(app.navPanels).toHaveLength(1);
    expect(panel.id).toBe("trees");
    expect(panel.title).toBe("Trees");
    expect(panel.path).toBe("trees");
  });

  it("lists trees with their folder and ready count", async () => {
    const slot = renderSlot(panel, { subPath: "" }, { rpc: baseRpc() });
    await slot.findByText("Build auth");
    await slot.findByText("/Users/me/Trees/build_auth");
    await slot.findByText("2 tasks · 1 ready");
  });

  it("invites the first tree when there are none", async () => {
    const slot = renderSlot(
      panel,
      { subPath: "" },
      { rpc: baseRpc({ projects_list: () => ({ projects: [] }) }) },
    );
    await slot.findByText(/No trees yet/u);
  });

  it("creates a tree and navigates into it", async () => {
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        rpc: baseRpc({
          projects_create: () => ({ project }),
        }),
      },
    );
    const input = await slot.findByLabelText("New tree name");
    fireEvent.change(input, { target: { value: "Build auth" } });
    fireEvent.click(slot.getByText("New tree"));

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "projects_create",
            input: { name: "Build auth" },
          }),
        ]),
      );
    });
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "toPluginPanel",
            path: "trees",
            options: expect.objectContaining({ subPath: "trp_1" }),
          }),
        ]),
      );
    });
  });

  it("draws every task on the canvas with its state", async () => {
    const slot = renderSlot(panel, { subPath: project.id }, { rpc: baseRpc() });
    await slot.findByText("Write auth requirements");
    await slot.findByText("Generate API design specs");
    await slot.findByText("Ready");
    await slot.findByText("Blocked");
  });

  it("reveals a tree's folder in the file manager", async () => {
    const reveals: unknown[] = [];
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        rpc: baseRpc({
          project_reveal: (input: unknown) => {
            reveals.push(input);
            return { directory: project.directory };
          },
        }),
      },
    );

    fireEvent.click(
      await slot.findByRole("button", {
        name: `Show ${project.name} in the file manager`,
      }),
    );

    await waitFor(() => {
      expect(reveals).toEqual([{ projectId: project.id }]);
    });
  });

  it("opens the detail panel for the task in the route", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    const title = await slot.findByLabelText("Task title");
    expect((title as HTMLInputElement).value).toBe("Generate API design specs");
  });

  it("opens the detail panel for the task that was clicked", async () => {
    const slot = renderSlot(panel, { subPath: project.id }, { rpc: baseRpc() });
    await slot.findByText("Generate API design specs");
    expect(slot.queryByLabelText("Task title")).toBeNull();

    await pressCard(slot, "Generate API design specs");

    const title = await slot.findByLabelText("Task title");
    expect((title as HTMLInputElement).value).toBe("Generate API design specs");
  });

  it("closes the detail panel when the open task is clicked again", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    await slot.findByLabelText("Task state");

    await pressCard(slot, "Generate API design specs");

    await waitFor(() => {
      expect(slot.queryByLabelText("Task state")).toBeNull();
    });
  });

  it("replaces the detail panel when a different task is clicked", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    const title = (await slot.findByLabelText(
      "Task title",
    )) as HTMLInputElement;
    expect(title.value).toBe("Generate API design specs");

    await pressCard(slot, "Write auth requirements");

    await waitFor(() => {
      expect(
        (slot.getByLabelText("Task title") as HTMLInputElement).value,
      ).toBe("Write auth requirements");
    });
  });

  it("keeps a completed task editable", async () => {
    const done = node({ id: "trn_9", state: "completed", kind: "agent" });
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${done.id}` },
      { rpc: baseRpc({ graph_get: () => ({ project, nodes: [done] }) }) },
    );
    const title = await slot.findByLabelText("Task title");
    const state = await slot.findByLabelText("Task state");
    expect((title as HTMLInputElement).disabled).toBe(false);
    expect((state as HTMLSelectElement).disabled).toBe(false);
  });

  it("shows the task state as a label rather than a button", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      { rpc: baseRpc() },
    );
    await slot.findByLabelText("Task document");
    const aside = slot.getByRole("complementary");

    // The state is a picker, not one button per transition.
    const state = within(aside).getByLabelText("Task state");
    expect(state.getAttribute("aria-haspopup")).toBe("menu");
    expect(state.getAttribute("aria-expanded")).toBe("false");
    expect(within(aside).queryByRole("menu")).toBeNull();
  });

  it("keeps the detail panel free of filenames and text-label chrome", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    await slot.findByLabelText("Task state");
    const aside = slot.getByRole("complementary");

    expect(within(aside).queryByText(specs.artifactFile)).toBeNull();
    expect(within(aside).queryByText("Instruction")).toBeNull();
    expect(within(aside).queryByText("Close")).toBeNull();
    expect(
      within(aside).getByRole("button", { name: "Close task details" }),
    ).toBeDefined();

    fireEvent.click(within(aside).getByRole("button", { name: "Setup" }));
    expect(
      within(aside).getByRole("button", { name: /Delete task/u }),
    ).toBeDefined();
  });

  it("hides dependencies and context behind disclosures", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    await slot.findByLabelText("Task state");
    expect(slot.queryByLabelText("Context mode")).toBeNull();
    expect(slot.queryByLabelText("Add a dependency")).toBeNull();
    expect(slot.queryByLabelText("Workspace")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Setup" }));

    await slot.findByLabelText("Context mode");
    await slot.findByLabelText("Workspace");
    await slot.findByRole("button", {
      name: /Remove the dependency on/u,
    });
  });

  it("drops the note instruction box so a note is just its document", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      { rpc: baseRpc() },
    );
    await slot.findByLabelText("Task document");
    expect(slot.queryByLabelText("Base branch")).toBeNull();
    expect(slot.queryByText("What to do")).toBeNull();
  });

  /*
   * A summary that has not landed yet and one that failed are both states of
   * the task, so they are coloured like the task's own states rather than
   * reading as more of the heading.
   */
  it.each([
    ["pending" as const, "summarizing…", "text-warning-text"],
    ["failed" as const, "failed", "text-destructive-text"],
  ])(
    "marks a %s summary apart from its heading",
    async (status, text, tone) => {
      const done = node({
        id: "trn_9",
        state: "completed",
        kind: "agent",
        summaryStatus: status,
        summaryProblem: status === "failed" ? "No thread to ask." : null,
      });
      const slot = renderSlot(
        panel,
        { subPath: `${project.id}/${done.id}` },
        { rpc: baseRpc({ graph_get: () => ({ project, nodes: [done] }) }) },
      );

      const note = await slot.findByText(`· ${text}`);
      expect(note.className).toContain(tone);

      const heading = slot.getByText("What it passes downstream");
      expect(heading).not.toBe(note);
      expect(heading.className).not.toContain(tone);
    },
  );

  it("opens the summary only once the task is complete", async () => {
    const ready = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    await ready.findByLabelText("Task state");
    expect(ready.queryByLabelText("Text passed downstream")).toBeNull();
    fireEvent.click(
      ready.getByRole("button", { name: "What it passes downstream" }),
    );
    await ready.findByLabelText("Text passed downstream");
    cleanup();

    const done = node({ id: "trn_8", state: "completed", kind: "agent" });
    const finished = renderSlot(
      panel,
      { subPath: `${project.id}/${done.id}` },
      { rpc: baseRpc({ graph_get: () => ({ project, nodes: [done] }) }) },
    );
    await finished.findByLabelText("Text passed downstream");
  });

  /*
   * Nothing is shown for a whole-document handoff: what goes down is the
   * document above, which the user just read or wrote.
   */
  it("shows no box when the whole document goes downstream", async () => {
    const done = node({
      id: "trn_10",
      state: "completed",
      kind: "markdown",
      handoff: "full",
      summary: "A compaction written back when it was auto-summarized.",
    });
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${done.id}` },
      { rpc: baseRpc({ graph_get: () => ({ project, nodes: [done] }) }) },
    );

    await slot.findByText(/receive the whole document/);
    expect(slot.queryByLabelText("Text passed downstream")).toBeNull();
    expect(slot.queryByRole("button", { name: "Compact with AI" })).toBeNull();
  });

  /*
   * The point of the button is the fan-out, so what it reports back has to
   * distinguish a child that was messaged from one that will get this later.
   */
  it("sends the context down and says what each child did with it", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          node_hand_down: () => ({
            deliveries: [
              {
                nodeId: specs.id,
                title: specs.title,
                outcome: "sent",
                problem: null,
              },
              {
                nodeId: "trn_x",
                title: "Write the changelog",
                outcome: "on_start",
                problem: null,
              },
            ],
          }),
        }),
      },
    );

    fireEvent.click(
      await slot.findByRole("button", { name: "What it passes downstream" }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Send down the context" }),
    );

    await slot.findByText(/Generate API design specs got it in its thread/);
    await slot.findByText(/Write the changelog will get it when it starts/);
  });

  it("offers no hand-down on a task nothing depends on", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "What it passes downstream" }),
    );
    await slot.findByText("Nothing depends on this task yet.");
    expect(
      slot.queryByRole("button", { name: "Send down the context" }),
    ).toBeNull();
  });

  it("switches what goes downstream from the box's own control", async () => {
    const updates: unknown[] = [];
    const done = node({
      id: "trn_11",
      state: "completed",
      kind: "markdown",
      summary: "A compaction.",
    });
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${done.id}` },
      {
        rpc: baseRpc({
          graph_get: () => ({ project, nodes: [done] }),
          node_update: (input: never) => {
            updates.push(input);
            return { node: { ...done, handoff: "custom" } };
          },
        }),
      },
    );

    const group = await slot.findByRole("radiogroup", {
      name: "What it passes downstream",
    });
    expect(group).toBeTruthy();
    fireEvent.click(slot.getByRole("radio", { name: "What I write" }));

    await waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(updates[0]).toMatchObject({ nodeId: done.id, handoff: "custom" });
  });

  it("previews the assembled context on request", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Setup" }));
    fireEvent.click(await slot.findByRole("button", { name: "Preview" }));
    await slot.findByText(/Generate it\./u);
    expect(slot.inspection.rpcCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "context_preview",
          input: { nodeId: specs.id },
        }),
      ]),
    );
  });

  it("offers a stale task both ways out", async () => {
    const stale = node({ id: "trn_3", state: "stale", title: "Stale task" });
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${stale.id}` },
      {
        rpc: baseRpc({
          graph_get: () => ({ project, nodes: [stale] }),
        }),
      },
    );
    const state = await slot.findByLabelText("Task state");
    expect(state.textContent).toContain(NODE_STATE_LABELS.stale);

    fireEvent.click(state);
    /*
     * Stale is where the graph put the task, so it shows on the pill but is
     * not on offer: both ways out of it are.
     */
    expect(
      slot.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual([
      NODE_STATE_LABELS.ready,
      NODE_STATE_LABELS.in_progress,
      NODE_STATE_LABELS.completed,
    ]);
  });

  it("drops the state menu below the pill, never over it", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      { rpc: baseRpc() },
    );
    fireEvent.click(await slot.findByLabelText("Task state"));

    const menu = slot.getByRole("menu");
    expect(menu.className).toContain("top-full");
    expect(menu.className).not.toContain("bottom-full");
  });

  it("closes the state menu on Escape without changing anything", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      { rpc: baseRpc() },
    );
    const state = await slot.findByLabelText("Task state");
    fireEvent.click(state);
    fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });

    await waitFor(() => {
      expect(slot.queryByRole("menu")).toBeNull();
    });
    expect(
      slot.inspection.rpcCalls.some((call) => call.method.startsWith("node_")),
    ).toBe(false);
  });

  /*
   * A hand-rolled menu has to bring its own keyboard, or the picker that
   * performs every transition is mouse-only.
   */
  it("opens the state menu and picks from it with the keyboard", async () => {
    const calls: string[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          node_complete: () => {
            calls.push("node_complete");
            return { node: requirements, summaryProblem: null };
          },
        }),
      },
    );
    const state = await slot.findByLabelText("Task state");

    fireEvent.keyDown(state, { key: "ArrowDown" });
    const menu = slot.getByRole("menu");
    // Focus starts on the task's own state, so arrows move relative to it.
    await waitFor(() => {
      expect(globalThis.document.activeElement).toBe(
        slot.getByRole("menuitemradio", { name: NODE_STATE_LABELS.ready }),
      );
    });

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    await waitFor(() => {
      expect(globalThis.document.activeElement).toBe(
        slot.getByRole("menuitemradio", { name: NODE_STATE_LABELS.completed }),
      );
    });

    fireEvent.click(globalThis.document.activeElement as HTMLElement);
    await waitFor(() => {
      expect(calls).toEqual(["node_complete"]);
    });
    expect(slot.queryByRole("menu")).toBeNull();
  });

  it("closes the state menu when the pointer goes elsewhere", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      { rpc: baseRpc() },
    );
    fireEvent.click(await slot.findByLabelText("Task state"));
    expect(slot.getByRole("menu")).toBeDefined();

    fireEvent.pointerDown(globalThis.document.body);
    await waitFor(() => {
      expect(slot.queryByRole("menu")).toBeNull();
    });
  });

  it("changes state through the dropdown instead of a button", async () => {
    const calls: string[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          node_complete: () => {
            calls.push("node_complete");
            return { node: requirements, summaryProblem: null };
          },
        }),
      },
    );
    const state = await slot.findByLabelText("Task state");
    expect(slot.queryByRole("button", { name: "Complete" })).toBeNull();

    fireEvent.click(state);
    fireEvent.click(
      slot.getByRole("menuitemradio", { name: NODE_STATE_LABELS.completed }),
    );

    await waitFor(() => {
      expect(calls).toEqual(["node_complete"]);
    });
  });

  it("records progress from the dropdown without creating a thread", async () => {
    const calls: string[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      {
        rpc: baseRpc({
          graph_get: () => ({
            project,
            nodes: [requirements, node({ ...specs, state: "ready" })],
          }),
          node_mark_working: () => {
            calls.push("node_mark_working");
            return { node: specs };
          },
          node_start: () => {
            calls.push("node_start");
            return { node: specs };
          },
        }),
      },
    );
    const state = await slot.findByLabelText("Task state");

    fireEvent.click(state);
    fireEvent.click(
      slot.getByRole("menuitemradio", { name: NODE_STATE_LABELS.in_progress }),
    );

    await waitFor(() => {
      expect(calls).toEqual(["node_mark_working"]);
    });
  });

  /*
   * A tree spans projects, so an agent task with none yet is asked which one
   * it changes before it is asked anything about a branch.
   */
  it("asks an agent task which project it works in", async () => {
    const updates: unknown[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      {
        rpc: baseRpc({
          node_update: (input: never) => {
            updates.push(input);
            return { node: specs };
          },
        }),
      },
    );

    expect(slot.queryByLabelText("Base branch")).toBeNull();
    fireEvent.change(await slot.findByLabelText("Project it works in"), {
      target: { value: "proj_api" },
    });

    await waitFor(() => {
      expect(updates).toEqual([
        {
          nodeId: specs.id,
          workspace: { kind: "project", projectId: "proj_api" },
        },
      ]);
    });
  });

  it("starts an agent task in its own worktree off a chosen branch", async () => {
    const calls: unknown[] = [];
    const inProject = node({
      ...specs,
      workspace: { kind: "project", projectId: "proj_api" },
    });
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${inProject.id}` },
      {
        rpc: baseRpc({
          graph_get: () => ({ project, nodes: [requirements, inProject] }),
          base_branches: () => ({
            branches: ["main", "feature/push"],
            defaultBranch: "main",
          }),
          node_open_thread: (input: unknown) => {
            calls.push(input);
            return { node: { ...inProject, threadId: "th_1" } };
          },
        }),
      },
    );
    const branch = (await slot.findByLabelText(
      "Base branch",
    )) as HTMLSelectElement;
    // The picker renders before its branches arrive, disabled and empty until
    // they do, so the default is only there to assert once they have landed.
    await waitFor(() => {
      expect(branch.value).toBe("main");
    });

    fireEvent.change(branch, { target: { value: "feature/push" } });
    fireEvent.change(slot.getByLabelText("Task instruction"), {
      target: { value: "Draft the schema." },
    });
    fireEvent.click(slot.getByRole("button", { name: "Start thread" }));

    await waitFor(() => {
      expect(calls).toEqual([
        {
          nodeId: inProject.id,
          baseBranch: "feature/push",
          prompt: "Draft the schema.",
        },
      ]);
    });
    // The thread opens in the background; Trees keeps the canvas and panel.
    expect(
      slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toEqual([]);
  });

  it("does not leave Trees when a task is created", async () => {
    const slot = renderSlot(panel, { subPath: project.id }, { rpc: baseRpc() });
    await slot.findByText("Write auth requirements");

    fireEvent.click(
      slot.getByRole("button", {
        name: "New task beside Write auth requirements",
      }),
    );
    fireEvent.change(await slot.findByLabelText("New task title"), {
      target: { value: "Fresh agent" },
    });
    fireEvent.click(slot.getByRole("radio", { name: "Agent" }));
    fireEvent.click(slot.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "node_create"),
      ).toBe(true);
    });
    expect(
      slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toEqual([]);
  });

  it("grows a dependent task from the handle under its parent", async () => {
    const creates: { dependsOn?: string[] }[] = [];
    const slot = renderSlot(
      panel,
      { subPath: project.id },
      {
        rpc: baseRpc({
          node_create: (input: { dependsOn?: string[] }) => {
            creates.push(input);
            return { node: specs };
          },
        }),
      },
    );
    await slot.findByText("Write auth requirements");

    const handle = slot.getByRole("button", {
      name: /New task depending on Write auth requirements/u,
    });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    fireEvent.change(await slot.findByLabelText("New task title"), {
      target: { value: "Fresh task" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });
    expect(creates[0]?.dependsOn).toEqual([requirements.id]);
    /*
     * Creating without a position is what makes the server lay the tree out,
     * so every task added on the canvas leaves it tidied.
     */
    expect(creates[0]).not.toHaveProperty("position");
  });

  it("links a new parent to its child and re-lays the tree out", async () => {
    const slot = renderSlot(
      panel,
      { subPath: project.id },
      {
        rpc: baseRpc({
          node_create: () => ({ node: specs }),
          dependency_add: () => ({ ok: true }),
          layout_apply: () => ({ ok: true }),
        }),
      },
    );
    await slot.findByText("Write auth requirements");

    fireEvent.click(
      slot.getByRole("button", {
        name: "New parent task for Write auth requirements",
      }),
    );
    fireEvent.change(await slot.findByLabelText("New task title"), {
      target: { value: "Groundwork" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "layout_apply"),
      ).toBe(true);
    });
    expect(
      slot.inspection.rpcCalls.filter(
        (call) => call.method === "dependency_add",
      ),
    ).toEqual([
      expect.objectContaining({
        input: { parentId: specs.id, childId: requirements.id },
      }),
    ]);
  });

  /*
   * The task owns its thread, so its chat owns its execution controls. Left to
   * inherit, the permission mode is pinned to a snapshot and shown as a dimmed
   * label, which a task the user started themselves should not be.
   */
  it("lets the embedded chat change how the task runs", async () => {
    const withThread = node({
      id: "trn_11",
      kind: "agent",
      state: "in_progress",
      threadId: "th_9",
    });
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${withThread.id}` },
      {
        rpc: baseRpc({
          graph_get: () => ({ project, nodes: [withThread] }),
        }),
      },
    );

    const chat = await slot.findByTestId("bb-thread-chat");
    expect(chat.dataset.permissionPolicy).toBe("editable");
    expect(chat.dataset.threadId).toBe("th_9");
  });

  it("renders a completed note as read-only markdown", async () => {
    const done = node({
      id: "trn_10",
      kind: "markdown",
      state: "completed",
      title: "Done note",
    });
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${done.id}` },
      { rpc: baseRpc({ graph_get: () => ({ project, nodes: [done] }) }) },
    );

    const document = await slot.findByLabelText("Task document");
    expect(document.tagName).not.toBe("TEXTAREA");
    expect(document.getAttribute("aria-readonly")).toBe("true");
  });

  it("autosaves a note without a save button", async () => {
    const writes: string[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          artifact_write: (input: { content: string }) => {
            writes.push(input.content);
            return { sha256: "def" };
          },
        }),
      },
    );
    const document = await slot.findByLabelText("Task document");
    expect(slot.queryByRole("button", { name: "Save" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Discard" })).toBeNull();

    fireEvent.change(document, { target: { value: "# Notes\n\nReal text." } });

    await waitFor(
      () => {
        expect(writes).toEqual(["# Notes\n\nReal text."]);
      },
      { timeout: 3000 },
    );
  });

  /*
   * A save must not take the editor away. Writing publishes, which reloads the
   * graph, which used to hand the panel a new task object and send it back to
   * disk for the document — disabling the field and dropping the caret in the
   * middle of a sentence.
   */
  it("keeps typing uninterrupted whatever the panel does around it", async () => {
    let reads = 0;
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          artifact_read: () => {
            reads += 1;
            if (reads === 1) {
              return { content: "", sha256: "abc", problem: null };
            }
            // A read that never lands, as a slow disk would give.
            return new Promise(() => {});
          },
        }),
      },
    );
    const field = (await slot.findByLabelText(
      "Task document",
    )) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "# Context" } });

    // Whatever the panel does with the document afterwards, the text the user
    // typed stays put and stays editable.
    expect(field.disabled).toBe(false);
    fireEvent.change(field, { target: { value: "# Context\n\n- Unified" } });
    expect(field.value).toBe("# Context\n\n- Unified");
  });

  it("saves what is pending when the task is left", async () => {
    const writes: string[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          artifact_write: (input: { content: string }) => {
            writes.push(input.content);
            return { sha256: "def" };
          },
        }),
      },
    );
    const field = await slot.findByLabelText("Task document");
    fireEvent.change(field, { target: { value: "Half a sentence" } });

    // Away before the debounce could fire.
    await pressCard(slot, "Generate API design specs");

    /*
     * Promptly: leaving has to write, not leave a timer to fire later on a
     * panel that has already moved on.
     */
    await waitFor(
      () => {
        expect(writes).toEqual(["Half a sentence"]);
      },
      { timeout: AUTOSAVE_DEBOUNCE_MS / 2 },
    );
  });

  it("chains writes rather than racing them over one digest", async () => {
    const writes: { content: string; expectedSha256: string | null }[] = [];
    let release = () => {};
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          artifact_write: (input: {
            content: string;
            expectedSha256: string | null;
          }) => {
            writes.push(input);
            if (writes.length === 1) {
              return new Promise<{ sha256: string }>((resolve) => {
                release = () => resolve({ sha256: "second" });
              });
            }
            return { sha256: "third" };
          },
        }),
      },
    );
    const field = await slot.findByLabelText("Task document");

    fireEvent.change(field, { target: { value: "one" } });
    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 3000 });

    // Two more edits while the first write is still in the air.
    fireEvent.change(field, { target: { value: "one two" } });
    fireEvent.change(field, { target: { value: "one two three" } });

    // Long enough for their debounce to come due and find the file still held.
    await new Promise((resolve) =>
      setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS * 2),
    );
    expect(writes).toHaveLength(1);

    release();
    await waitFor(() => expect(writes).toHaveLength(2), { timeout: 3000 });
    // One follow-up, carrying the latest text and the digest the first returned.
    expect(writes[1]).toEqual({
      nodeId: requirements.id,
      content: "one two three",
      expectedSha256: "second",
    });
  });

  it("does not send the note back to disk when the graph changes underneath", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          artifact_write: () => ({ sha256: "def" }),
        }),
      },
    );
    const field = await slot.findByLabelText("Task document");
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.filter(
          (call) => call.method === "artifact_read",
        ),
      ).toHaveLength(1);
    });

    fireEvent.change(field, { target: { value: "Typed once." } });
    await waitFor(
      () => {
        expect(
          slot.inspection.rpcCalls.filter((call) => call.method === "graph_get")
            .length,
        ).toBeGreaterThan(1);
      },
      { timeout: 3000 },
    );

    expect(
      slot.inspection.rpcCalls.filter(
        (call) => call.method === "artifact_read",
      ),
    ).toHaveLength(1);
  });

  it("flushes a pending note save when the field loses focus", async () => {
    const writes: string[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          artifact_write: (input: { content: string }) => {
            writes.push(input.content);
            return { sha256: "def" };
          },
        }),
      },
    );
    const document = await slot.findByLabelText("Task document");

    fireEvent.change(document, { target: { value: "# Notes\n\nTyped." } });
    fireEvent.blur(document);

    await waitFor(() => {
      expect(writes).toEqual(["# Notes\n\nTyped."]);
    });
  });

  it("offers a fresh workspace or an existing one to share", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Setup" }));

    const workspace = (await slot.findByLabelText(
      "Workspace",
    )) as HTMLSelectElement;
    expect([...workspace.options].map((option) => option.value)).toEqual([
      "tree",
      "project:proj_api",
      "environment:env_shared",
    ]);
  });

  it("points a task at a shared workspace", async () => {
    const updates: unknown[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      {
        rpc: baseRpc({
          node_update: (input: unknown) => {
            updates.push(input);
            return { node: specs };
          },
        }),
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Setup" }));
    const workspace = await slot.findByLabelText("Workspace");

    fireEvent.change(workspace, {
      target: { value: "environment:env_shared" },
    });

    await waitFor(() => {
      expect(updates).toEqual([
        {
          nodeId: specs.id,
          workspace: { kind: "environment", environmentId: "env_shared" },
        },
      ]);
    });
  });

  it("lets the detail panel be resized well past half the width", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${specs.id}` },
      { rpc: baseRpc() },
    );
    const separator = await slot.findByRole("separator", {
      name: "Resize the task panel",
    });
    expect(separator.getAttribute("aria-valuemax")).toBe("80");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });

    await waitFor(() => {
      expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThan(
        34,
      );
    });
  });

  /*
   * Dropping a picture into a note has to leave the note a Markdown file
   * that points at it, or nothing downstream would ever be shown it.
   */
  it("stores a dropped image and writes the reference into the note", async () => {
    const attached: unknown[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          assets_preview: () => ({
            baseUrl: "http://127.0.0.1:1/preview",
            expiresAtMs: 9_999,
          }),
          image_attach: (input: never) => {
            attached.push(input);
            return {
              markdown: "![shot.png](assets/abc123.png)",
              assetFile: "abc123.png",
              url: "http://127.0.0.1:1/preview/abc123.png",
            };
          },
          artifact_write: () => ({ sha256: "def" }),
        }),
      },
    );

    const document = (await slot.findByLabelText(
      "Task document",
    )) as HTMLTextAreaElement;
    const file = new File(["png bytes"], "shot.png", { type: "image/png" });
    fireEvent.drop(document.parentElement!, {
      dataTransfer: { files: [file], items: [{ kind: "file" }] },
    });

    await waitFor(() => {
      expect(attached).toHaveLength(1);
    });
    expect(attached[0]).toMatchObject({
      nodeId: requirements.id,
      fileName: "shot.png",
    });
    await waitFor(() => {
      expect(document.value).toContain("![shot.png](assets/abc123.png)");
    });
    // And the image itself, not just its reference in the text.
    const thumbnail = await slot.findByRole("img", { name: "shot.png" });
    expect(thumbnail.getAttribute("src")).toBe(
      "http://127.0.0.1:1/preview/abc123.png",
    );
  });

  it("leaves a dropped file that is not an image alone", async () => {
    const attached: unknown[] = [];
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          image_attach: (input: never) => {
            attached.push(input);
            return { markdown: "", assetFile: "", url: null };
          },
        }),
      },
    );

    const document = await slot.findByLabelText("Task document");
    fireEvent.drop(document.parentElement!, {
      dataTransfer: {
        files: [new File(["text"], "notes.txt", { type: "text/plain" })],
        items: [{ kind: "file" }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attached).toEqual([]);
  });

  /*
   * A note is a file the user writes. Nothing assembles a prompt for it and
   * nothing runs it, so neither choice has any meaning there.
   */
  it("offers a note neither a workspace nor a context to receive", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      { rpc: baseRpc() },
    );
    await slot.findByLabelText("Task document");
    fireEvent.click(await slot.findByRole("button", { name: "Setup" }));
    await slot.findByLabelText("Add a dependency");
    expect(slot.queryByLabelText("Context mode")).toBeNull();
    expect(slot.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(slot.queryByLabelText("Workspace")).toBeNull();
  });

  it("surfaces a file that could not be read instead of showing it as empty", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/${requirements.id}` },
      {
        rpc: baseRpc({
          artifact_read: () => ({
            content: "",
            sha256: null,
            problem: "EACCES /Users/me/Trees/build_auth/01.md",
          }),
        }),
      },
    );
    await slot.findByRole("alert");
    await slot.findByText(/EACCES/u);
  });

  it("puts the tree actions in the shared title bar", async () => {
    const slot = renderSlot(
      header,
      { subPath: project.id },
      { rpc: baseRpc() },
    );

    expect(
      await slot.findByRole("button", { name: "Tidy layout" }),
    ).toBeDefined();
    expect(slot.getByRole("button", { name: "Delete tree" })).toBeDefined();
    // Adding a task belongs to the canvas, where the task will live.
    expect(slot.queryByRole("button", { name: "New task" })).toBeNull();
  });

  it("names the open tree in the title bar breadcrumb, without repeating Trees", async () => {
    const slot = renderSlot(
      breadcrumb,
      { subPath: project.id },
      { rpc: baseRpc() },
    );

    await slot.findByText(project.name);
    await slot.findByText("2 tasks ·");
    await slot.findByRole("button", { name: "1 ready" });
    expect(slot.queryByText("Trees")).toBeNull();
  });

  it("keeps the title bar clear on the tree index", async () => {
    const slot = renderSlot(header, { subPath: "" }, { rpc: baseRpc() });
    await waitFor(() => {
      expect(slot.queryByRole("button", { name: "Tidy layout" })).toBeNull();
    });

    const crumb = renderSlot(breadcrumb, { subPath: "" }, { rpc: baseRpc() });
    expect(crumb.container.textContent).toBe("");
  });

  it("shows the ready list across trees", async () => {
    const slot = renderSlot(panel, { subPath: "ready" }, { rpc: baseRpc() });
    fireEvent.click(
      await slot.findByRole("button", { name: /Write auth requirements/u }),
    );
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "toPluginPanel",
            options: expect.objectContaining({
              subPath: `${project.id}/${requirements.id}`,
            }),
          }),
        ]),
      );
    });
  });

  /*
   * A tree's ready list belongs under the tree, so leaving it lands on that
   * tree's canvas and only Trees goes back to every tree.
   */
  it("keeps a tree's ready list inside the tree, entered by its count", async () => {
    const crumb = renderSlot(
      breadcrumb,
      { subPath: project.id },
      { rpc: baseRpc() },
    );
    fireEvent.click(await crumb.findByRole("button", { name: "1 ready" }));
    expect(crumb.inspection.navigateCalls).toEqual([
      expect.objectContaining({
        method: "toPluginPanel",
        options: expect.objectContaining({ subPath: `${project.id}/ready` }),
      }),
    ]);

    // The count replaced the button, rather than joining it.
    const bar = renderSlot(header, { subPath: project.id }, { rpc: baseRpc() });
    await bar.findByRole("button", { name: "Tidy layout" });
    expect(bar.queryByRole("button", { name: "What’s ready" })).toBeNull();
  });

  it("offers no way back into the list it is already showing", async () => {
    const crumb = renderSlot(
      breadcrumb,
      { subPath: `${project.id}/ready` },
      { rpc: baseRpc() },
    );
    await crumb.findByText("What’s ready");
    expect(crumb.queryByRole("button", { name: "1 ready" })).toBeNull();
  });

  it("asks only for the open tree's ready tasks", async () => {
    const slot = renderSlot(
      panel,
      { subPath: `${project.id}/ready` },
      { rpc: baseRpc() },
    );
    await slot.findByRole("button", { name: /Write auth requirements/u });
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "ready_list"),
    ).toEqual([expect.objectContaining({ input: { projectId: project.id } })]);
  });

  it("asks for every tree's ready tasks from the tree index", async () => {
    const slot = renderSlot(panel, { subPath: "ready" }, { rpc: baseRpc() });
    await slot.findByRole("button", { name: /Write auth requirements/u });
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "ready_list"),
    ).toEqual([expect.objectContaining({ input: { projectId: null } })]);
  });

  it("trails a tree's ready list behind the tree, which goes back to it", async () => {
    const crumb = renderSlot(
      breadcrumb,
      { subPath: `${project.id}/ready` },
      { rpc: baseRpc() },
    );
    await crumb.findByText("What’s ready");

    fireEvent.click(await crumb.findByRole("button", { name: project.name }));
    expect(crumb.inspection.navigateCalls).toEqual([
      expect.objectContaining({
        method: "toPluginPanel",
        options: expect.objectContaining({ subPath: project.id }),
      }),
    ]);
  });

  it("names no tree above the ready list that spans them all", async () => {
    const crumb = renderSlot(
      breadcrumb,
      { subPath: "ready" },
      { rpc: baseRpc() },
    );
    await crumb.findByText("What’s ready");
    expect(crumb.queryByRole("button", { name: project.name })).toBeNull();
  });

  it("reports a tree that cannot be loaded and offers a way back", async () => {
    const slot = renderSlot(
      panel,
      { subPath: "trp_missing" },
      {
        rpc: baseRpc({
          graph_get: () => {
            throw new Error("Unknown tree project trp_missing.");
          },
        }),
      },
    );
    await slot.findByText(/Unknown tree project/u);
    await slot.findByText("All trees");
  });
});
