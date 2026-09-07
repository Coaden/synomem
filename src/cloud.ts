/**
 * Synomem Cloud, as a constant rather than a question.
 *
 * Public onboarding must never ask for a service URL. A person setting up
 * Synomem has no way to know whether an address they were given is the real
 * one, and a prompt that accepts any origin is a prompt that can be phished.
 * The hosted service therefore has one address, compiled in.
 *
 * `SYNOMEM_API_URL` remains for development and private deployments. It is
 * deliberately undocumented in the README, the public docs, the packaged skill
 * and ordinary help output — a private deployment is configured by whoever runs
 * it, not discovered by an ordinary user.
 */
export const SYNOMEM_CLOUD_API_URL = 'https://api.synomem.ai';

export function cloudApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SYNOMEM_API_URL?.trim();
  return override || SYNOMEM_CLOUD_API_URL;
}
