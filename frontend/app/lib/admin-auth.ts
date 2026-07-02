export async function adminFetch(
  path: string,
  opts: NonNullable<Parameters<typeof fetch>[1]> = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  return fetch(path, {
    ...opts,
    headers,
    credentials: "include",
    cache: opts.cache ?? "no-store",
  });
}

export async function login(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (res.ok && data.ok) return { ok: true };
    return { ok: false, error: "Kredencialet janë të pasakta." };
  } catch {
    return { ok: false, error: "Kredencialet janë të pasakta." };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    // Swallow errors — the cookie will be cleared by the server regardless.
  }
}

export async function getMe(): Promise<{
  ok: boolean;
  user?: { email: string; display_name: string };
}> {
  try {
    const res = await fetch("/api/auth/me", {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      user?: { email: string; display_name: string };
    };
    if (!data.ok) return { ok: false };
    return { ok: true, user: data.user };
  } catch {
    return { ok: false };
  }
}
