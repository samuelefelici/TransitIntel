/**
 * rule-profiles-api — client per i profili-regole dell'ottimizzatore turni guida.
 * Catena: default azienda (company) → default progetto (project) → override live.
 */
import { apiFetch } from "@/lib/api";
import type { OperatorConfig } from "@/hooks/use-crew-optimization";

export type RuleProfileScope = "company" | "project";
export type RuleProfileDomain = "crew" | "vsp" | "vcsp";

export interface RuleProfile {
  id: string;
  scope: RuleProfileScope;
  domain: RuleProfileDomain;
  projectId: string | null;
  name: string;
  serviceType: string | null;
  config: any;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

function qs(params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function listRuleProfiles(projectId?: string | null, domain: RuleProfileDomain = "crew"): Promise<RuleProfile[]> {
  const r = await apiFetch<{ profiles: RuleProfile[] }>(`/api/optimizer-rule-profiles${qs({ projectId, domain })}`);
  return r.profiles;
}

export async function resolveRuleProfile(
  projectId?: string | null,
  domain: RuleProfileDomain = "crew",
): Promise<{ config: any | null; sources: { company: boolean; project: boolean } }> {
  return apiFetch(`/api/optimizer-rule-profiles/resolve${qs({ projectId, domain })}`);
}

export async function createRuleProfile(input: {
  name: string;
  scope: RuleProfileScope;
  domain?: RuleProfileDomain;
  projectId?: string | null;
  serviceType?: string | null;
  config: any;
  isDefault?: boolean;
}): Promise<RuleProfile> {
  const r = await apiFetch<{ profile: RuleProfile }>(`/api/optimizer-rule-profiles`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return r.profile;
}

export async function updateRuleProfile(
  id: string,
  patch: Partial<{ name: string; serviceType: string | null; config: OperatorConfig; isDefault: boolean }>,
): Promise<RuleProfile> {
  const r = await apiFetch<{ profile: RuleProfile }>(`/api/optimizer-rule-profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return r.profile;
}

export async function deleteRuleProfile(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/optimizer-rule-profiles/${id}`, { method: "DELETE" });
}
