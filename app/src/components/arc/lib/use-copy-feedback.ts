"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CopyFeedbackState = "idle" | "copied" | "error";

/** Write text to the clipboard. Falls back to a hidden textarea when the async API is unavailable. */
export async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Shared clipboard state for actions that render their own button or menu. */
export function useCopyFeedback(duration = 1900) {
  const [state, setState] = useState<CopyFeedbackState>("idle");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    setState("idle");
    setActiveKey(null);
  }, []);

  useEffect(() => () => {
    if (timeout.current) clearTimeout(timeout.current);
  }, []);

  const copy = useCallback(async (value: string, key = "default") => {
    if (timeout.current) clearTimeout(timeout.current);
    setActiveKey(key);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      timeout.current = setTimeout(reset, duration);
      return true;
    } catch {
      setState("error");
      timeout.current = setTimeout(reset, duration);
      return false;
    }
  }, [duration, reset]);

  return { state, activeKey, copy, reset };
}
