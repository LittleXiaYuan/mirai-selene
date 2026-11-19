import { useCallback, useEffect, useState } from "react";

/**
 * 钱包：余额与订单都来自服务端，购买走真实扣款。
 * 未登录时不发请求，界面上也不显示余额。
 */
export interface Order {
  id: string;
  listingId: string;
  title: string;
  price: number;
  createdAt: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

export function useWallet(signedIn: boolean) {
  const [balance, setBalance] = useState<number | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setBalance(null);
      setOrders([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const data = await api<{ balance: number; orders: Order[] }>("/api/wallet");
        if (!alive) return;
        setBalance(data.balance);
        setOrders(data.orders ?? []);
      } catch {
        if (alive) setBalance(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [signedIn]);

  const purchase = useCallback(async (listingId: string) => {
    setBusyId(listingId);
    setError(null);
    try {
      const data = await api<{ balance: number; already?: boolean; listing?: { title: string } }>(
        "/api/market/purchase",
        { method: "POST", body: JSON.stringify({ id: listingId }) },
      );
      setBalance(data.balance);
      setOrders((prev) =>
        prev.some((order) => order.listingId === listingId)
          ? prev
          : [
              {
                id: `local-${listingId}`,
                listingId,
                title: data.listing?.title ?? "",
                price: 0,
                createdAt: new Date().toISOString(),
              },
              ...prev,
            ],
      );
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "购买失败");
      throw err;
    } finally {
      setBusyId(null);
    }
  }, []);

  return { balance, orders, owned: new Set(orders.map((order) => order.listingId)), purchase, busyId, error };
}
