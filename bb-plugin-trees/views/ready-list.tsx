import { Badge } from "@bb/shared-ui/badge";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Icon } from "@bb/shared-ui/icon";
import {
  NODE_STATE_LABELS,
  type TreeNode,
  type TreeProject,
} from "../src/model";

export interface ReadyEntryView {
  project: TreeProject;
  node: TreeNode;
}

export interface ReadyListProps {
  entries: readonly ReadyEntryView[];
  onOpen: (args: { projectId: string; nodeId: string }) => void;
}

export function ReadyList({ entries, onOpen }: ReadyListProps) {
  if (entries.length === 0) {
    return (
      <EmptyStatePanel>
        <p className="text-sm text-muted-foreground">
          Nothing is ready. Complete a task and the ones depending on it appear
          here.
        </p>
      </EmptyStatePanel>
    );
  }

  const byProject = new Map<string, ReadyEntryView[]>();
  for (const entry of entries) {
    const existing = byProject.get(entry.project.id);
    if (existing === undefined) {
      byProject.set(entry.project.id, [entry]);
      continue;
    }
    existing.push(entry);
  }

  return (
    <div className="space-y-5">
      {[...byProject.values()].map((group) => {
        const project = group[0]?.project;
        if (project === undefined) return null;
        return (
          <section key={project.id} className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">
              {project.name}
            </h3>
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {group.map((entry) => (
                <li key={entry.node.id} className="min-w-0">
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() =>
                      onOpen({
                        projectId: entry.project.id,
                        nodeId: entry.node.id,
                      })
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">
                          {entry.node.title}
                        </span>
                        <Badge
                          className="shrink-0"
                          variant={
                            entry.node.state === "stale"
                              ? "destructive"
                              : "default"
                          }
                        >
                          {NODE_STATE_LABELS[entry.node.state]}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {entry.node.kind === "agent" ? "Agent task" : "Note"} ·{" "}
                        {entry.node.artifactFile}
                      </span>
                    </span>
                    <Icon
                      name="ChevronRight"
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
