import type { DatabaseExecuteQueryResult, DatabasePreviewTableResult } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";

type DatabaseResultsDialogView =
  | {
      kind: "preview";
      connectionLabel: string | null;
      schemaName: string;
      tableName: string;
      page: number;
      result: DatabasePreviewTableResult | null;
      isPending: boolean;
      errorMessage: string | null;
      onPreviousPage: (() => void) | null;
      onNextPage: (() => void) | null;
    }
  | {
      kind: "query";
      connectionLabel: string | null;
      sql: string;
      result: DatabaseExecuteQueryResult;
    };

interface DatabaseResultsDialogProps {
  view: DatabaseResultsDialogView | null;
  onOpenChange: (open: boolean) => void;
}

function DatabaseResultsGrid(props: {
  columns: ReadonlyArray<{ name: string }>;
  rows: ReadonlyArray<Record<string, string | number | boolean | null>>;
}) {
  if (props.columns.length === 0) {
    return <p className="text-muted-foreground text-sm">No columns returned.</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/70">
      <ScrollArea className="h-[min(52vh,32rem)]">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-background/96 backdrop-blur">
            <tr className="border-b border-border/70">
              {props.columns.map((column) => (
                <th key={column.name} className="px-3 py-2 font-medium text-foreground">
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-muted-foreground"
                  colSpan={props.columns.length}
                >
                  No rows returned.
                </td>
              </tr>
            ) : (
              props.rows.map((row, index) => (
                <tr
                  key={JSON.stringify(row)}
                  className={cn(index % 2 === 0 ? "bg-background" : "bg-muted/18")}
                >
                  {props.columns.map((column) => (
                    <td key={column.name} className="max-w-64 px-3 py-2 align-top">
                      <span className="break-words whitespace-pre-wrap font-mono text-xs">
                        {row[column.name] === null ? "NULL" : String(row[column.name])}
                      </span>
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

export function DatabaseResultsDialog({ view, onOpenChange }: DatabaseResultsDialogProps) {
  const isOpen = view !== null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-[min(92vw,1040px)]">
        <DialogHeader>
          <DialogTitle>
            {view?.kind === "preview" ? `${view.schemaName}.${view.tableName}` : "Query result"}
          </DialogTitle>
          <DialogDescription>
            {view?.connectionLabel ? `Connection: ${view.connectionLabel}` : "Database result"}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {view?.kind === "preview" ? (
            view.errorMessage ? (
              <p className="text-destructive text-sm">{view.errorMessage}</p>
            ) : view.result === null && view.isPending ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner className="size-4" />
                Loading table data...
              </div>
            ) : view.result ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-muted-foreground text-xs">
                    Page {view.result.page} - showing {view.result.rows.length} of{" "}
                    {view.result.totalRowCount} total rows
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => view.onPreviousPage?.()}
                      disabled={view.onPreviousPage === null || view.isPending}
                    >
                      <ChevronLeftIcon className="size-3.5" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => view.onNextPage?.()}
                      disabled={view.onNextPage === null || view.isPending}
                    >
                      Next
                      <ChevronRightIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <DatabaseResultsGrid columns={view.result.columns} rows={view.result.rows} />
              </>
            ) : null
          ) : view?.kind === "query" ? (
            <>
              <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
                <p className="mb-2 text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  SQL
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">
                  {view.sql}
                </pre>
              </div>
              {view.result.kind === "command" ? (
                <div className="rounded-xl border border-border/70 bg-muted/24 p-4">
                  <p className="font-medium text-sm">{view.result.command}</p>
                  <p className="mt-1 text-muted-foreground text-sm">{view.result.message}</p>
                </div>
              ) : (
                <DatabaseResultsGrid columns={view.result.columns} rows={view.result.rows} />
              )}
            </>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
