import { useEffect, useState } from "react";
import { AddToWikiDialog } from "./AddToWikiDialog";
import { QuickSearch } from "./QuickSearch";
import { addRequests, searchRequests, type AddRequest } from "./requests";

export function WikiOverlay() {
  const [request, setRequest] = useState<{ key: number; value: AddRequest } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => addRequests.subscribe((value) => setRequest((current) => ({ key: (current?.key ?? 0) + 1, value }))), []);
  useEffect(() => searchRequests.subscribe(() => setSearchOpen(true)), []);

  return (
    <>
      {request === null ? null : <AddToWikiDialog key={request.key} request={request.value} onClose={() => setRequest(null)} />}
      <QuickSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
