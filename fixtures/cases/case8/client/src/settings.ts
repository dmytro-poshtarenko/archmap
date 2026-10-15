export async function loadEndpoint(name: string): Promise<string> {
  const response = await fetch(`/api/settings/${name}`);
  const { url } = (await response.json()) as { url: string };
  return url;
}
