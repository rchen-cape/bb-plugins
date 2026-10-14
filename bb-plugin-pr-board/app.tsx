import { definePluginApp, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { BoardView } from "./components/Board";
import { AddressThreadTab, ReviewThreadTab, ThreadDiffButton } from "./components/ThreadPanels";
import { ReviewWorkspace } from "./components/Workspace";
import { ADDRESS_THREAD_TAB, BOARD_PANEL, REVIEW_THREAD_TAB, parseWorkspacePath } from "./routes";

function BoardPanel({ subPath }: PluginNavPanelProps) {
  const pull = parseWorkspacePath(subPath);
  return pull === null ? <BoardView /> : <ReviewWorkspace pull={pull} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: BOARD_PANEL,
    title: "PR Board",
    icon: "GitPullRequest",
    path: BOARD_PANEL,
    component: BoardPanel,
    fixedTabs: [
      { ...REVIEW_THREAD_TAB, title: "Review thread", icon: "MessageSquare", component: ReviewThreadTab, layout: "flush" },
      { ...ADDRESS_THREAD_TAB, title: "Address thread", icon: "MessageCirclePlus", component: AddressThreadTab, layout: "flush" },
    ],
  });
  app.slots.experimental_threadHeaderAction({
    id: "review-diff",
    title: "PR Board diff",
    component: ThreadDiffButton,
  });
});
