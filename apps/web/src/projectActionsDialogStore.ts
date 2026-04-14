import { create } from "zustand";

export type ProjectActionsDialogOpenTarget = "auto" | "custom" | "packageScripts";

interface ProjectActionsDialogStore {
  openRequestId: number;
  preferredTab: ProjectActionsDialogOpenTarget;
  requestOpen: (preferredTab?: ProjectActionsDialogOpenTarget) => void;
}

export const useProjectActionsDialogStore = create<ProjectActionsDialogStore>((set) => ({
  openRequestId: 0,
  preferredTab: "auto",
  requestOpen: (preferredTab = "auto") =>
    set((state) => ({
      openRequestId: state.openRequestId + 1,
      preferredTab,
    })),
}));
