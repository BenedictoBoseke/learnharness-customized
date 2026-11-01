"use client";
import { useEffect } from "react";
/** Starts the local coordinator; browser connectivity is a wake hint, not the durable queue. */
export function LibraryLifecycle() {
  useEffect(() => {
    const wake = () => {
      void fetch("/api/sync", { cache: "no-store" }).catch(() => {});
      if(document.visibilityState==='visible')void fetch('/api/subjects',{cache:'no-store'}).then(r=>r.json()).then(b=>{for(const s of b.subjects||[])if(s.bound&&s.scan.phase!=='scanning')void fetch('/api/subjects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'refresh',workspaceId:s.id})}).catch(()=>{});}).catch(()=>{});
    };
    wake();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  return null;
}
