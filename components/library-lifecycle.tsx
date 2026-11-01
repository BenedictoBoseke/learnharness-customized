"use client";
import { useEffect } from "react";
/** Starts the local coordinator; browser connectivity is a wake hint, not the durable queue. */
export function LibraryLifecycle() {
  useEffect(() => {
    const wake = () => {
      void fetch("/api/sync", { cache: "no-store" }).catch(() => {});
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
