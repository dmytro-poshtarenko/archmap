async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api${path}`, init);
  return response.json();
}

export const currentUser = () => request("/users/me");

export const updateProfile = (profile: unknown) => request("/users/me", { method: "PUT", body: JSON.stringify(profile) });
