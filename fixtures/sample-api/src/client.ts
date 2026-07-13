/** Minimal typed client for the Sample Users API. */
export interface User {
  id: string;
  email: string;
  name?: string;
}

/**
 * Fetch one user by id.
 * @param baseUrl API base URL, e.g. https://api.example.com/v1
 * @param id the user's id
 */
export async function getUser(baseUrl: string, id: string): Promise<User> {
  const res = await fetch(`${baseUrl}/users/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getUser failed: ${res.status}`);
  return (await res.json()) as User;
}
